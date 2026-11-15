// Package room is the SFU core: rooms, peers, fan-out, NACK retransmission
// from the relay-side cache, and per-peer statistics. It knows nothing about
// WebSocket or WebTransport — transports implement the Transport interface.
package room

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"just-workspace/audiorelay/internal/proto"
	"just-workspace/audiorelay/internal/token"
)

// Transport is one connected client. Implementations must be safe for a
// single writer goroutine (the peer's) plus Close from anywhere.
type Transport interface {
	// SendUnreliable carries audio/parity. May be lossy (datagram). The
	// relay does not retain pkt after the call returns.
	SendUnreliable(pkt []byte) error
	// SendReliable carries control, pong and retransmissions, in order.
	SendReliable(pkt []byte) error
	Close(reason string)
	Kind() string // "websocket" | "webtransport"
}

// Options tune the hub.
type Options struct {
	MaxRooms        int
	MaxPeersPerRoom int
	// TestDropPercent, when > 0, drops that share of forwarded audio
	// packets before they reach the transport. Only for loss-recovery tests;
	// the compose file never sets it.
	TestDropPercent int
	Log             *slog.Logger
}

var (
	ErrRoomFull  = errors.New("room: full")
	ErrTooMany   = errors.New("room: too many rooms")
	ErrPeerGone  = errors.New("room: peer closed")
	ErrQueueFull = errors.New("room: send queue full")
)

// Hub owns all rooms.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]*Room
	opts  Options
	rng   *rand.Rand
	rngMu sync.Mutex
}

// NewHub creates an empty hub.
func NewHub(opts Options) *Hub {
	if opts.MaxRooms <= 0 {
		opts.MaxRooms = 256
	}
	if opts.MaxPeersPerRoom <= 0 {
		opts.MaxPeersPerRoom = 16
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Hub{rooms: map[string]*Room{}, opts: opts, rng: rand.New(rand.NewPCG(7, 11))}
}

// Room is one voice channel.
type Room struct {
	ID      string
	hub     *Hub
	mu      sync.RWMutex
	peers   map[uint16]*Peer
	nextID  uint16
	created time.Time
	stop    chan struct{}
}

// Peer is one member.
type Peer struct {
	ID       uint16
	UID      string
	Name     string
	Identity string
	room     *Room
	tr       Transport
	kind     string
	cache    retxCache
	format   format
	c        counters

	seqMu  sync.Mutex
	hasSeq bool
	expSeq uint32 // next expected frame seq on the uplink

	clientMu sync.Mutex
	client   json.RawMessage

	unreliable chan []byte
	reliable   chan []byte
	closed     atomic.Bool
	done       chan struct{}

	lastWin, lastWinOut atomic.Uint64
}

// Join admits a verified token holder with its transport. It sends the
// welcome message to the new peer and peer_joined to the others.
func (h *Hub) Join(c token.Claims, tr Transport) (*Peer, error) {
	h.mu.Lock()
	r, ok := h.rooms[c.Room]
	if !ok {
		if len(h.rooms) >= h.opts.MaxRooms {
			h.mu.Unlock()
			return nil, ErrTooMany
		}
		r = &Room{ID: c.Room, hub: h, peers: map[uint16]*Peer{}, created: time.Now(), stop: make(chan struct{})}
		h.rooms[c.Room] = r
		go r.ticker()
	}
	h.mu.Unlock()

	r.mu.Lock()
	if len(r.peers) >= h.opts.MaxPeersPerRoom {
		r.mu.Unlock()
		return nil, ErrRoomFull
	}
	// Peer ids are never 0 and never reused within a room's lifetime (u16 wrap aside).
	for {
		r.nextID++
		if r.nextID == 0 {
			r.nextID = 1
		}
		if _, taken := r.peers[r.nextID]; !taken {
			break
		}
	}
	p := &Peer{
		ID: r.nextID, UID: c.UID, Name: c.Name, Identity: c.Identity, room: r, tr: tr, kind: tr.Kind(),
		unreliable: make(chan []byte, 256), reliable: make(chan []byte, 256), done: make(chan struct{}),
	}
	r.peers[p.ID] = p
	others := make([]peerInfo, 0, len(r.peers))
	for _, o := range r.peers {
		if o != p {
			others = append(others, peerInfo{Peer: o.ID, UID: o.UID, Name: o.Name, Identity: o.Identity, Transport: o.kind})
		}
	}
	r.mu.Unlock()

	go p.writer()
	welcome, _ := json.Marshal(struct {
		T            string     `json:"t"`
		Room         string     `json:"room"`
		Peer         uint16     `json:"peer"`
		UID          string     `json:"uid"`
		Transport    string     `json:"transport"`
		ServerTimeMs int64      `json:"server_time_ms"`
		Peers        []peerInfo `json:"peers"`
	}{"welcome", r.ID, p.ID, p.UID, p.kind, time.Now().UnixMilli(), others})
	_ = p.sendReliable(proto.Ctrl(0, welcome))

	joined, _ := json.Marshal(struct {
		T string `json:"t"`
		peerInfo
	}{"peer_joined", peerInfo{Peer: p.ID, UID: p.UID, Name: p.Name, Identity: p.Identity, Transport: p.kind}})
	r.broadcastCtrl(joined, p)
	h.opts.Log.Info("peer joined", "room", r.ID, "peer", p.ID, "uid", p.UID, "transport", p.kind)
	return p, nil
}

type peerInfo struct {
	Peer      uint16 `json:"peer"`
	UID       string `json:"uid"`
	Name      string `json:"name,omitempty"`
	Identity  string `json:"identity,omitempty"`
	Transport string `json:"transport"`
}

// Leave removes the peer, closes its transport and tells the others.
func (p *Peer) Leave(reason string) {
	if !p.closed.CompareAndSwap(false, true) {
		return
	}
	close(p.done)
	r := p.room
	r.mu.Lock()
	delete(r.peers, p.ID)
	empty := len(r.peers) == 0
	r.mu.Unlock()
	p.tr.Close(reason)
	left, _ := json.Marshal(struct {
		T    string `json:"t"`
		Peer uint16 `json:"peer"`
		UID  string `json:"uid"`
	}{"peer_left", p.ID, p.UID})
	r.broadcastCtrl(left, nil)
	r.hub.opts.Log.Info("peer left", "room", r.ID, "peer", p.ID, "reason", reason)
	if empty {
		r.hub.mu.Lock()
		if cur, ok := r.hub.rooms[r.ID]; ok && cur == r {
			r.mu.RLock()
			still := len(r.peers)
			r.mu.RUnlock()
			if still == 0 {
				delete(r.hub.rooms, r.ID)
				close(r.stop)
			}
		}
		r.hub.mu.Unlock()
	}
}

// Done is closed when the peer has left.
func (p *Peer) Done() <-chan struct{} { return p.done }

// Room returns the peer's room id.
func (p *Peer) Room() string { return p.room.ID }

func (p *Peer) sendReliable(pkt []byte) error {
	if p.closed.Load() {
		return ErrPeerGone
	}
	select {
	case p.reliable <- pkt:
		return nil
	default:
		// A reliable backlog this deep means the client is not reading; drop the
		// client rather than buffer forever (it reconnects and gets a fresh welcome).
		go p.Leave("slow consumer")
		return ErrQueueFull
	}
}

func (p *Peer) sendUnreliable(pkt []byte) error {
	if p.closed.Load() {
		return ErrPeerGone
	}
	select {
	case p.unreliable <- pkt:
		return nil
	default:
		p.c.dropped.Add(1)
		return ErrQueueFull
	}
}

// writer is the single goroutine that touches the transport's send side.
func (p *Peer) writer() {
	for {
		select {
		case <-p.done:
			return
		case pkt := <-p.reliable:
			if err := p.tr.SendReliable(pkt); err != nil {
				go p.Leave("send: " + err.Error())
				return
			}
			p.c.pktsOut.Add(1)
			p.c.bytesOut.Add(uint64(len(pkt)))
			p.c.windowBytesOut.Add(uint64(len(pkt)))
		case pkt := <-p.unreliable:
			if err := p.tr.SendUnreliable(pkt); err != nil {
				// Datagram too big or session gone; the former is a client bug.
				p.c.dropped.Add(1)
				continue
			}
			p.c.pktsOut.Add(1)
			p.c.bytesOut.Add(uint64(len(pkt)))
			p.c.windowBytesOut.Add(uint64(len(pkt)))
		}
	}
}

// Ingest handles one packet received from this peer. reliable says which
// path it arrived on so the pong goes back the same way.
func (p *Peer) Ingest(pkt []byte, reliable bool) {
	h, err := proto.Decode(pkt)
	if err != nil {
		p.c.badPkts.Add(1)
		return
	}
	switch h.Type {
	case proto.TypeAudio, proto.TypeParity:
		p.ingestMedia(h, pkt)
	case proto.TypeNack:
		p.handleNack(h, pkt)
	case proto.TypePing:
		// Echo the opaque payload; Src tells the client it came from the relay.
		pong := make([]byte, len(pkt))
		copy(pong, pkt)
		pong[1] = proto.TypePong
		proto.StampSrc(pong, 0)
		if reliable {
			_ = p.sendReliable(pong)
		} else {
			_ = p.sendUnreliable(pong)
		}
	case proto.TypePong:
		p.handlePong(pkt)
	case proto.TypeCtrl:
		p.handleCtrl(proto.Payload(pkt))
	default:
		p.c.badPkts.Add(1)
	}
}

func (p *Peer) ingestMedia(h proto.Header, pkt []byte) {
	p.c.pktsIn.Add(1)
	p.c.bytesIn.Add(uint64(len(pkt)))
	p.c.windowBytesIn.Add(uint64(len(pkt)))
	if h.Type == proto.TypeAudio {
		p.format.update(h)
		if h.FragIdx == 0 {
			p.trackSeq(h.Seq)
		}
		p.cache.put(h.Seq, h.FragIdx, h.FragCnt, pkt)
	}
	proto.StampSrc(pkt, p.ID)
	p.room.fanout(pkt, p)
}

// trackSeq counts uplink gaps (frames the relay never received). Reordering
// within a short window is tolerated: a late frame decrements the gap count.
func (p *Peer) trackSeq(seq uint32) {
	p.seqMu.Lock()
	defer p.seqMu.Unlock()
	if !p.hasSeq {
		p.hasSeq, p.expSeq = true, seq+1
		return
	}
	d := int32(seq - p.expSeq)
	switch {
	case d == 0:
		p.expSeq = seq + 1
	case d > 0 && d < 1024:
		p.c.lossIn.Add(uint64(d))
		p.expSeq = seq + 1
	case d < 0 && d > -1024:
		// Late arrival of something we counted as lost.
		for {
			cur := p.c.lossIn.Load()
			if cur == 0 || p.c.lossIn.CompareAndSwap(cur, cur-1) {
				break
			}
		}
		p.c.dupIn.Add(0)
	default:
		// Sender restarted its counter.
		p.expSeq = seq + 1
	}
}

func (p *Peer) handleNack(h proto.Header, pkt []byte) {
	p.c.nackRecv.Add(1)
	seqs := proto.DecodeNack(proto.Payload(pkt))
	src := p.room.peer(h.Src)
	if src == nil || src == p {
		return
	}
	for _, s := range seqs {
		for _, frag := range src.cache.get(s) {
			proto.SetFlag(frag, proto.FlagRetransmit)
			proto.StampSrc(frag, src.ID)
			if p.sendReliable(frag) == nil {
				src.c.retxSent.Add(1)
			}
		}
	}
}

func (p *Peer) handlePong(pkt []byte) {
	pl := proto.Payload(pkt)
	if len(pl) < 8 {
		return
	}
	sent := int64(binary.BigEndian.Uint64(pl))
	rtt := time.Now().UnixMicro() - sent
	if rtt < 0 || rtt > 60_000_000 {
		return
	}
	p.c.rttMicros.Store(rtt)
	prev := p.c.rttEWMAMicros.Load()
	if prev == 0 {
		p.c.rttEWMAMicros.Store(rtt)
	} else {
		p.c.rttEWMAMicros.Store(prev + (rtt-prev)/8)
	}
}

func (p *Peer) handleCtrl(js []byte) {
	var m struct {
		T string `json:"t"`
	}
	if json.Unmarshal(js, &m) != nil {
		p.c.badPkts.Add(1)
		return
	}
	switch m.T {
	case "stats":
		// Client-side receive stats (jitter buffer, recoveries). Stored verbatim,
		// size-capped, and re-published to the room.
		if len(js) > 4096 {
			return
		}
		cp := make([]byte, len(js))
		copy(cp, js)
		p.clientMu.Lock()
		p.client = cp
		p.clientMu.Unlock()
	}
}

// RTT returns the smoothed relay↔peer round trip.
func (p *Peer) RTT() time.Duration { return time.Duration(p.c.rttEWMAMicros.Load()) * time.Microsecond }

// peer looks a member up by id.
func (r *Room) peer(id uint16) *Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.peers[id]
}

// fanout forwards a media packet to every other member.
func (r *Room) fanout(pkt []byte, from *Peer) {
	r.mu.RLock()
	targets := make([]*Peer, 0, len(r.peers))
	for _, o := range r.peers {
		if o != from {
			targets = append(targets, o)
		}
	}
	r.mu.RUnlock()
	drop := r.hub.opts.TestDropPercent
	for _, o := range targets {
		if drop > 0 && r.hub.testDrop(drop) {
			o.c.dropped.Add(1)
			continue
		}
		_ = o.sendUnreliable(pkt)
	}
}

func (h *Hub) testDrop(pct int) bool {
	h.rngMu.Lock()
	defer h.rngMu.Unlock()
	return h.rng.IntN(100) < pct
}

func (r *Room) broadcastCtrl(js []byte, except *Peer) {
	pkt := proto.Ctrl(0, js)
	r.mu.RLock()
	targets := make([]*Peer, 0, len(r.peers))
	for _, o := range r.peers {
		if o != except {
			targets = append(targets, o)
		}
	}
	r.mu.RUnlock()
	for _, o := range targets {
		_ = o.sendReliable(pkt)
	}
}

// ticker runs once a second per room: relay→peer pings (for RTT) and the stats push.
func (r *Room) ticker() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
			r.tick()
		}
	}
}

func (r *Room) tick() {
	r.mu.RLock()
	peers := make([]*Peer, 0, len(r.peers))
	for _, o := range r.peers {
		peers = append(peers, o)
	}
	r.mu.RUnlock()
	now := time.Now()
	for _, o := range peers {
		pl := make([]byte, 8)
		binary.BigEndian.PutUint64(pl, uint64(now.UnixMicro()))
		ping := proto.Marshal(proto.Header{Type: proto.TypePing, FragCnt: 1}, pl)
		// Measure the path the audio takes.
		if o.kind == "webtransport" {
			_ = o.sendUnreliable(ping)
		} else {
			_ = o.sendReliable(ping)
		}
	}
	js, _ := json.Marshal(r.Stats(true))
	pkt := proto.Ctrl(0, js)
	for _, o := range peers {
		_ = o.sendReliable(pkt)
	}
}

// Stats snapshots the room. resetWindow is true from the ticker (so bitrates
// are per-second) and false for HTTP readers (which reuse the last window).
func (r *Room) Stats(resetWindow bool) RoomStats {
	r.mu.RLock()
	peers := make([]*Peer, 0, len(r.peers))
	for _, o := range r.peers {
		peers = append(peers, o)
	}
	r.mu.RUnlock()
	out := RoomStats{T: "stats", Room: r.ID, ServerTimeMs: time.Now().UnixMilli(), Peers: make([]PeerStats, 0, len(peers))}
	for _, o := range peers {
		var win, winOut uint64
		if resetWindow {
			win = o.c.windowBytesIn.Swap(0)
			winOut = o.c.windowBytesOut.Swap(0)
			o.lastWin.Store(win)
			o.lastWinOut.Store(winOut)
		} else {
			win = o.lastWin.Load()
			winOut = o.lastWinOut.Load()
		}
		o.clientMu.Lock()
		cl := o.client
		o.clientMu.Unlock()
		out.Peers = append(out.Peers, PeerStats{
			Peer: o.ID, UID: o.UID, Name: o.Name, Identity: o.Identity, Transport: o.kind, Format: o.format.snapshot(),
			BitrateIn: float64(win) * 8, BitrateOut: float64(winOut) * 8,
			PacketsIn: o.c.pktsIn.Load(), BytesIn: o.c.bytesIn.Load(), LossIn: o.c.lossIn.Load(), DupIn: o.c.dupIn.Load(),
			PacketsOut: o.c.pktsOut.Load(), BytesOut: o.c.bytesOut.Load(), Dropped: o.c.dropped.Load(),
			NackRecv: o.c.nackRecv.Load(), RetxSent: o.c.retxSent.Load(), BadPkts: o.c.badPkts.Load(),
			RTTMs: float64(o.c.rttMicros.Load()) / 1000, RTTAvgMs: float64(o.c.rttEWMAMicros.Load()) / 1000,
			Client: cl,
		})
	}
	return out
}

// RoomStats returns the snapshot for one room (nil if it does not exist).
func (h *Hub) RoomStats(id string) *RoomStats {
	h.mu.RLock()
	r := h.rooms[id]
	h.mu.RUnlock()
	if r == nil {
		return nil
	}
	s := r.Stats(false)
	return &s
}

// Summary is the unauthenticated /info view.
type Summary struct {
	Rooms int `json:"rooms"`
	Peers int `json:"peers"`
}

// Summary counts rooms and peers.
func (h *Hub) Summary() Summary {
	h.mu.RLock()
	defer h.mu.RUnlock()
	s := Summary{Rooms: len(h.rooms)}
	for _, r := range h.rooms {
		r.mu.RLock()
		s.Peers += len(r.peers)
		r.mu.RUnlock()
	}
	return s
}
