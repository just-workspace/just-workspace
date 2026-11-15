package room

import (
	"encoding/json"
	"sync"
	"sync/atomic"

	"just-workspace/audiorelay/internal/proto"
)

// counters are the relay-side numbers for one peer. All fields are atomic so
// the hot path never takes a lock.
type counters struct {
	bytesIn, pktsIn    atomic.Uint64 // audio+parity received from this peer
	bytesOut, pktsOut  atomic.Uint64 // forwarded to this peer
	lossIn             atomic.Uint64 // seq gaps seen on the uplink (frames)
	dupIn              atomic.Uint64
	dropped            atomic.Uint64 // outbound packets dropped (queue full or test drop)
	nackRecv, retxSent atomic.Uint64
	badPkts            atomic.Uint64
	windowBytesIn      atomic.Uint64 // reset every tick → bitrate
	windowBytesOut     atomic.Uint64
	rttMicros          atomic.Int64 // last relay→peer→relay round trip
	rttEWMAMicros      atomic.Int64
}

// format is the latest header seen from a sender (what the UI shows as a badge).
type format struct {
	mu     sync.Mutex
	set    bool
	codec  uint8
	flags  uint8
	rate   uint32
	ch     uint8
	bits   uint8
	frame  uint16
	lastTS uint32
}

func (f *format) update(h proto.Header) {
	f.mu.Lock()
	f.set, f.codec, f.flags, f.rate, f.ch, f.bits, f.frame, f.lastTS = true, h.Codec, h.Flags, h.Rate, h.Channels, h.Bits, h.Frame, h.TS
	f.mu.Unlock()
}

// Format is the sender's announced stream format.
type Format struct {
	Codec    string  `json:"codec"`
	Rate     uint32  `json:"rate"`
	Channels uint8   `json:"channels"`
	Bits     uint8   `json:"bits"`
	Frame    uint16  `json:"frame_samples"`
	FrameMs  float64 `json:"frame_ms"`
	FEC      bool    `json:"fec"`
	Nominal  float64 `json:"nominal_bps"` // rate × ch × bits for PCM
}

// CodecName maps the wire codec byte to its name.
func CodecName(c uint8) string {
	switch c {
	case proto.CodecPCMS16:
		return "pcm_s16"
	case proto.CodecPCMS24:
		return "pcm_s24"
	case proto.CodecPCMF32:
		return "pcm_f32"
	case proto.CodecFLAC:
		return "flac"
	case proto.CodecOpus:
		return "opus"
	case proto.CodecPCMS32:
		return "pcm_s32"
	}
	return "unknown"
}

func (f *format) snapshot() *Format {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.set {
		return nil
	}
	out := &Format{Codec: CodecName(f.codec), Rate: f.rate, Channels: f.ch, Bits: f.bits, Frame: f.frame, FEC: f.flags&proto.FlagFEC != 0}
	if f.rate > 0 {
		out.FrameMs = float64(f.frame) * 1000 / float64(f.rate)
	}
	if f.codec <= proto.CodecPCMF32 {
		out.Nominal = float64(f.rate) * float64(f.ch) * float64(f.bits)
	}
	return out
}

// PeerStats is one row of the "proof" panel.
type PeerStats struct {
	Peer       uint16          `json:"peer"`
	UID        string          `json:"uid"`
	Name       string          `json:"name,omitempty"`
	Identity   string          `json:"identity,omitempty"`
	Transport  string          `json:"transport"`
	Format     *Format         `json:"format,omitempty"`
	BitrateIn  float64         `json:"bitrate_in_bps"` // measured over the last tick, header included
	BitrateOut float64         `json:"bitrate_out_bps"`
	PacketsIn  uint64          `json:"packets_in"`
	BytesIn    uint64          `json:"bytes_in"`
	LossIn     uint64          `json:"loss_in"` // uplink frames the relay never saw
	DupIn      uint64          `json:"dup_in"`
	PacketsOut uint64          `json:"packets_out"`
	BytesOut   uint64          `json:"bytes_out"`
	Dropped    uint64          `json:"dropped_out"`
	NackRecv   uint64          `json:"nack_recv"`
	RetxSent   uint64          `json:"retx_sent"`
	BadPkts    uint64          `json:"bad_packets"`
	RTTMs      float64         `json:"rtt_ms"`
	RTTAvgMs   float64         `json:"rtt_avg_ms"`
	Client     json.RawMessage `json:"client,omitempty"` // last client-reported receive stats (jitter buffer, FEC/NACK recoveries, PLC)
}

// RoomStats is the per-room snapshot pushed to members every second and served
// at GET /audiorelay/stats.
type RoomStats struct {
	T            string      `json:"t"` // "stats"
	Room         string      `json:"room"`
	ServerTimeMs int64       `json:"server_time_ms"`
	Peers        []PeerStats `json:"peers"`
}
