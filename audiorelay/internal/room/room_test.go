package room

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"just-workspace/audiorelay/internal/proto"
	"just-workspace/audiorelay/internal/token"
)

// fakeTransport records what the relay sent.
type fakeTransport struct {
	mu         sync.Mutex
	unreliable [][]byte
	reliable   [][]byte
	closed     string
	kind       string
}

func (f *fakeTransport) SendUnreliable(p []byte) error {
	cp := append([]byte(nil), p...)
	f.mu.Lock()
	f.unreliable = append(f.unreliable, cp)
	f.mu.Unlock()
	return nil
}
func (f *fakeTransport) SendReliable(p []byte) error {
	cp := append([]byte(nil), p...)
	f.mu.Lock()
	f.reliable = append(f.reliable, cp)
	f.mu.Unlock()
	return nil
}
func (f *fakeTransport) Close(r string) { f.mu.Lock(); f.closed = r; f.mu.Unlock() }
func (f *fakeTransport) Kind() string {
	if f.kind == "" {
		return "websocket"
	}
	return f.kind
}

func (f *fakeTransport) wait(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		ok := cond()
		f.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func (f *fakeTransport) ctrl(t *testing.T, typ string) map[string]any {
	t.Helper()
	var found map[string]any
	f.wait(t, func() bool {
		for _, pkt := range f.reliable {
			h, err := proto.Decode(pkt)
			if err != nil || h.Type != proto.TypeCtrl {
				continue
			}
			var m map[string]any
			if json.Unmarshal(proto.Payload(pkt), &m) == nil && m["t"] == typ {
				found = m
				return true
			}
		}
		return false
	})
	return found
}

func audio(seq uint32, fill byte) []byte {
	h := proto.Header{Type: proto.TypeAudio, Codec: proto.CodecPCMS24, Flags: proto.FlagFEC, Channels: 2, Bits: 24, Frame: 120, Rate: 48000, Seq: seq, TS: seq * 120, FragCnt: 1}
	return proto.Marshal(h, bytes.Repeat([]byte{fill}, 720))
}

func join(t *testing.T, h *Hub, room, uid string, tr Transport) *Peer {
	t.Helper()
	p, err := h.Join(token.Claims{Room: room, UID: uid, Name: uid, EXP: time.Now().Unix() + 60}, tr)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestFanoutStampsSrcAndSkipsSender(t *testing.T) {
	h := NewHub(Options{})
	ta, tb, tc := &fakeTransport{}, &fakeTransport{}, &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	b := join(t, h, "r", "bob", tb)
	_ = join(t, h, "r", "carol", tc)
	w := ta.ctrl(t, "welcome")
	if int(w["peer"].(float64)) != int(a.ID) || w["room"] != "r" {
		t.Fatalf("welcome %v", w)
	}
	// bob's welcome lists alice; alice gets peer_joined for bob and carol
	wb := tb.ctrl(t, "welcome")
	if len(wb["peers"].([]any)) != 1 {
		t.Fatalf("bob peers %v", wb["peers"])
	}
	ta.ctrl(t, "peer_joined")

	pkt := audio(1, 0xAB)
	a.Ingest(pkt, false)
	tb.wait(t, func() bool { return len(tb.unreliable) == 1 })
	tc.wait(t, func() bool { return len(tc.unreliable) == 1 })
	got, _ := proto.Decode(tb.unreliable[0])
	if got.Src != a.ID {
		t.Fatalf("src %d want %d", got.Src, a.ID)
	}
	if !bytes.Equal(proto.Payload(tb.unreliable[0]), proto.Payload(pkt)) {
		t.Fatal("payload altered")
	}
	// Everything else in the header untouched
	want, _ := proto.Decode(audio(1, 0xAB))
	want.Src = a.ID
	if got != want {
		t.Fatalf("header altered %+v", got)
	}
	ta.mu.Lock()
	n := len(ta.unreliable)
	ta.mu.Unlock()
	if n != 0 {
		t.Fatal("sender received its own audio")
	}
	_ = b
}

func TestNackServedFromCache(t *testing.T) {
	h := NewHub(Options{})
	ta, tb := &fakeTransport{}, &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	b := join(t, h, "r", "bob", tb)
	for s := uint32(0); s < 8; s++ {
		a.Ingest(audio(s, byte(s)), false)
	}
	tb.wait(t, func() bool { return len(tb.unreliable) == 8 })
	// bob asks for 3 and 5 from alice, plus 999 (not cached)
	b.Ingest(proto.EncodeNack(a.ID, []uint32{3, 5, 999}), true)
	tb.wait(t, func() bool {
		n := 0
		for _, p := range tb.reliable {
			if h, _ := proto.Decode(p); h.Type == proto.TypeAudio {
				n++
			}
		}
		return n == 2
	})
	var seqs []uint32
	for _, p := range tb.reliable {
		if h, _ := proto.Decode(p); h.Type == proto.TypeAudio {
			if h.Flags&proto.FlagRetransmit == 0 || h.Src != a.ID {
				t.Fatalf("retx flags %+v", h)
			}
			if proto.Payload(p)[0] != byte(h.Seq) {
				t.Fatal("wrong frame content")
			}
			seqs = append(seqs, h.Seq)
		}
	}
	if len(seqs) != 2 || seqs[0] != 3 || seqs[1] != 5 {
		t.Fatalf("seqs %v", seqs)
	}
	st := h.RoomStats("r")
	var sa, sb PeerStats
	for _, ps := range st.Peers {
		if ps.UID == "alice" {
			sa = ps
		} else {
			sb = ps
		}
	}
	if sa.RetxSent != 2 || sb.NackRecv != 1 {
		t.Fatalf("stats a=%+v b=%+v", sa, sb)
	}
}

func TestFragmentsCachedTogether(t *testing.T) {
	h := NewHub(Options{})
	ta, tb := &fakeTransport{}, &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	b := join(t, h, "r", "bob", tb)
	for i := uint8(0); i < 3; i++ {
		hd := proto.Header{Type: proto.TypeAudio, Codec: proto.CodecPCMS24, Channels: 2, Bits: 24, Frame: 480, Rate: 48000, Seq: 42, FragIdx: i, FragCnt: 3}
		a.Ingest(proto.Marshal(hd, []byte{i}), false)
	}
	b.Ingest(proto.EncodeNack(a.ID, []uint32{42}), true)
	tb.wait(t, func() bool {
		n := 0
		for _, p := range tb.reliable {
			if h, _ := proto.Decode(p); h.Type == proto.TypeAudio {
				n++
			}
		}
		return n == 3
	})
}

func TestUplinkLossAndFormat(t *testing.T) {
	h := NewHub(Options{})
	ta := &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	a.Ingest(audio(10, 0), false)
	a.Ingest(audio(11, 0), false)
	a.Ingest(audio(14, 0), false) // 12, 13 missing
	a.Ingest(audio(13, 0), false) // 13 arrives late
	st := h.RoomStats("r")
	ps := st.Peers[0]
	if ps.LossIn != 1 || ps.PacketsIn != 4 {
		t.Fatalf("%+v", ps)
	}
	if ps.Format == nil || ps.Format.Codec != "pcm_s24" || ps.Format.FrameMs != 2.5 || !ps.Format.FEC || ps.Format.Nominal != 48000*2*24 {
		t.Fatalf("format %+v", ps.Format)
	}
}

func TestPingPongSamePathAndClientStats(t *testing.T) {
	h := NewHub(Options{})
	ta := &fakeTransport{kind: "webtransport"}
	a := join(t, h, "r", "alice", ta)
	ping := proto.Marshal(proto.Header{Type: proto.TypePing, FragCnt: 1}, []byte{1, 2, 3, 4, 5, 6, 7, 8})
	a.Ingest(ping, false)
	ta.wait(t, func() bool { return len(ta.unreliable) == 1 })
	h2, _ := proto.Decode(ta.unreliable[0])
	if h2.Type != proto.TypePong || h2.Src != 0 || !bytes.Equal(proto.Payload(ta.unreliable[0]), []byte{1, 2, 3, 4, 5, 6, 7, 8}) {
		t.Fatalf("pong %+v", h2)
	}
	a.Ingest(ping, true)
	ta.wait(t, func() bool {
		for _, p := range ta.reliable {
			if hh, _ := proto.Decode(p); hh.Type == proto.TypePong {
				return true
			}
		}
		return false
	})
	a.Ingest(proto.Ctrl(0, []byte(`{"t":"stats","recovered_fec":3,"plc":1}`)), true)
	st := h.RoomStats("r")
	if !bytes.Contains(st.Peers[0].Client, []byte(`"recovered_fec":3`)) {
		t.Fatalf("client stats %s", st.Peers[0].Client)
	}
}

func TestLeaveAndRoomGC(t *testing.T) {
	h := NewHub(Options{})
	ta, tb := &fakeTransport{}, &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	b := join(t, h, "r", "bob", tb)
	a.Leave("bye")
	left := tb.ctrl(t, "peer_left")
	if int(left["peer"].(float64)) != int(a.ID) {
		t.Fatalf("%v", left)
	}
	if ta.closed != "bye" {
		t.Fatal("transport not closed")
	}
	a.Leave("again") // idempotent
	if h.Summary().Peers != 1 {
		t.Fatal("peer count")
	}
	b.Leave("bye")
	if s := h.Summary(); s.Rooms != 0 || s.Peers != 0 {
		t.Fatalf("room not collected %+v", s)
	}
	if h.RoomStats("r") != nil {
		t.Fatal("stats for dead room")
	}
}

func TestLimits(t *testing.T) {
	h := NewHub(Options{MaxPeersPerRoom: 1, MaxRooms: 1})
	join(t, h, "r", "a", &fakeTransport{})
	if _, err := h.Join(token.Claims{Room: "r", UID: "b"}, &fakeTransport{}); err != ErrRoomFull {
		t.Fatalf("%v", err)
	}
	if _, err := h.Join(token.Claims{Room: "r2", UID: "c"}, &fakeTransport{}); err != ErrTooMany {
		t.Fatalf("%v", err)
	}
}

func TestTestDrop(t *testing.T) {
	h := NewHub(Options{TestDropPercent: 100})
	ta, tb := &fakeTransport{}, &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	join(t, h, "r", "bob", tb)
	for s := uint32(0); s < 20; s++ {
		a.Ingest(audio(s, 0), false)
	}
	time.Sleep(20 * time.Millisecond)
	tb.mu.Lock()
	n := len(tb.unreliable)
	tb.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d forwarded with 100%% drop", n)
	}
	if h.RoomStats("r").Peers[0].Dropped+h.RoomStats("r").Peers[1].Dropped != 20 {
		t.Fatal("dropped counter")
	}
}

func TestBadPackets(t *testing.T) {
	h := NewHub(Options{})
	ta := &fakeTransport{}
	a := join(t, h, "r", "alice", ta)
	a.Ingest([]byte{1, 2, 3}, true)
	a.Ingest(proto.Marshal(proto.Header{Type: 99, FragCnt: 1}, nil), true)
	a.Ingest(proto.Ctrl(0, []byte("not json")), true)
	if h.RoomStats("r").Peers[0].BadPkts != 3 {
		t.Fatal("bad packet count")
	}
}
