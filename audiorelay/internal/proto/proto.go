// Package proto implements the audiorelay wire format (see ../../PROTOCOL.md).
//
// Every message — on WebSocket, on a WebTransport datagram or inside a
// WebTransport stream — starts with the same fixed 24-byte header. The relay
// never looks at the payload: it reads the header to learn the sender's
// sequence/format (for stats and the retransmit cache), stamps the Src field
// and forwards the bytes to the other members of the room untouched.
package proto

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Version is the only wire version this relay speaks.
const Version = 1

// HeaderSize is the fixed size of the header that precedes every payload.
const HeaderSize = 24

// MaxPacket caps a single message. Frames bigger than this are rejected
// (a 20 ms f32 stereo 192 kHz frame is 30,720 B — well inside).
const MaxPacket = 64 * 1024

// Message types (header byte 1).
const (
	TypeAudio  uint8 = 0 // one audio frame (or a fragment of one)
	TypeParity uint8 = 1 // XOR parity of the 4 preceding audio frames (4:1 FEC)
	TypeNack   uint8 = 2 // receiver → relay: list of missing seqs for Src
	TypePing   uint8 = 3 // either direction: 8-byte opaque payload echoed back as Pong
	TypePong   uint8 = 4
	TypeCtrl   uint8 = 5 // JSON control message (welcome, peers, stats, auth, …)
)

// Codecs (header byte 2). The relay forwards all of them without looking.
const (
	CodecPCMS16 uint8 = 0
	CodecPCMS24 uint8 = 1
	CodecPCMF32 uint8 = 2
	CodecFLAC   uint8 = 3
	CodecOpus   uint8 = 4 // opus passthrough (pre-encoded by the sender)
	CodecPCMS32 uint8 = 5 // 32-bit signed integer LE (desktop hi-res)
)

// Flags (header byte 3).
const (
	FlagFEC        uint8 = 1 << 0 // sender emits parity frames for this stream
	FlagRetransmit uint8 = 1 << 1 // this packet is a NACK-driven retransmission
	FlagKeyframe   uint8 = 1 << 2 // codec setup (e.g. FLAC STREAMINFO) rides along
	FlagMuted      uint8 = 1 << 3 // sender is muted; payload is all-zero frame
)

// Header is the decoded fixed header.
type Header struct {
	Version  uint8
	Type     uint8
	Codec    uint8
	Flags    uint8
	Channels uint8
	Bits     uint8  // 16, 24 or 32
	Frame    uint16 // samples per channel in one frame
	Rate     uint32 // Hz
	Seq      uint32 // frame counter (parity: seq of the last frame in its group)
	TS       uint32 // sample index of the first sample in the frame (wraps)
	Src      uint16 // peer id, stamped by the relay (0 = relay itself / unset)
	FragIdx  uint8
	FragCnt  uint8 // 1 = unfragmented
}

var (
	ErrShort   = errors.New("proto: packet shorter than header")
	ErrVersion = errors.New("proto: unsupported version")
	ErrTooBig  = errors.New("proto: packet exceeds MaxPacket")
	ErrFrag    = errors.New("proto: bad fragment counters")
)

// Decode parses the header at the start of b. It does not copy.
func Decode(b []byte) (Header, error) {
	var h Header
	if len(b) < HeaderSize {
		return h, ErrShort
	}
	if len(b) > MaxPacket {
		return h, ErrTooBig
	}
	h.Version = b[0]
	if h.Version != Version {
		return h, fmt.Errorf("%w: %d", ErrVersion, h.Version)
	}
	h.Type = b[1]
	h.Codec = b[2]
	h.Flags = b[3]
	h.Channels = b[4]
	h.Bits = b[5]
	h.Frame = binary.BigEndian.Uint16(b[6:8])
	h.Rate = binary.BigEndian.Uint32(b[8:12])
	h.Seq = binary.BigEndian.Uint32(b[12:16])
	h.TS = binary.BigEndian.Uint32(b[16:20])
	h.Src = binary.BigEndian.Uint16(b[20:22])
	h.FragIdx = b[22]
	h.FragCnt = b[23]
	if h.FragCnt == 0 || h.FragIdx >= h.FragCnt {
		return h, ErrFrag
	}
	return h, nil
}

// Encode writes the header into dst (len >= HeaderSize) and returns dst[:HeaderSize].
func (h Header) Encode(dst []byte) []byte {
	if len(dst) < HeaderSize {
		dst = make([]byte, HeaderSize)
	}
	dst[0] = Version
	dst[1] = h.Type
	dst[2] = h.Codec
	dst[3] = h.Flags
	dst[4] = h.Channels
	dst[5] = h.Bits
	binary.BigEndian.PutUint16(dst[6:8], h.Frame)
	binary.BigEndian.PutUint32(dst[8:12], h.Rate)
	binary.BigEndian.PutUint32(dst[12:16], h.Seq)
	binary.BigEndian.PutUint32(dst[16:20], h.TS)
	binary.BigEndian.PutUint16(dst[20:22], h.Src)
	dst[22] = h.FragIdx
	cnt := h.FragCnt
	if cnt == 0 {
		cnt = 1
	}
	dst[23] = cnt
	return dst[:HeaderSize]
}

// Marshal returns header+payload as one packet.
func Marshal(h Header, payload []byte) []byte {
	out := make([]byte, HeaderSize+len(payload))
	h.Encode(out)
	copy(out[HeaderSize:], payload)
	return out
}

// StampSrc overwrites the Src field in place. This is the only byte-level
// change the relay makes to a forwarded packet.
func StampSrc(pkt []byte, src uint16) {
	if len(pkt) >= HeaderSize {
		binary.BigEndian.PutUint16(pkt[20:22], src)
	}
}

// SetFlag sets flag bits in place (used to mark retransmissions).
func SetFlag(pkt []byte, flag uint8) {
	if len(pkt) >= HeaderSize {
		pkt[3] |= flag
	}
}

// Payload returns the bytes after the header.
func Payload(pkt []byte) []byte {
	if len(pkt) < HeaderSize {
		return nil
	}
	return pkt[HeaderSize:]
}

// FrameBytes is the payload size of one unfragmented PCM frame for this header.
func (h Header) FrameBytes() int {
	return int(h.Frame) * int(h.Channels) * int(h.Bits) / 8
}

// Bitrate is the nominal stream bitrate (payload only) in bit/s for PCM.
func (h Header) Bitrate() float64 {
	if h.Rate == 0 {
		return 0
	}
	return float64(h.Rate) * float64(h.Channels) * float64(h.Bits)
}

// ParityGroup is the number of audio frames one parity frame protects.
const ParityGroup = 4

// GroupBase returns the first seq of the parity group containing seq.
func GroupBase(seq uint32) uint32 { return seq &^ (ParityGroup - 1) }

// DecodeNack returns the list of seqs in a NACK payload (u32 BE each).
func DecodeNack(payload []byte) []uint32 {
	n := len(payload) / 4
	if n > 64 {
		n = 64
	}
	out := make([]uint32, n)
	for i := 0; i < n; i++ {
		out[i] = binary.BigEndian.Uint32(payload[i*4:])
	}
	return out
}

// EncodeNack builds a NACK packet asking Src's frames seqs to be resent.
func EncodeNack(src uint16, seqs []uint32) []byte {
	p := make([]byte, 4*len(seqs))
	for i, s := range seqs {
		binary.BigEndian.PutUint32(p[i*4:], s)
	}
	return Marshal(Header{Type: TypeNack, Src: src, FragCnt: 1}, p)
}

// Ctrl builds a control packet carrying JSON.
func Ctrl(src uint16, js []byte) []byte {
	return Marshal(Header{Type: TypeCtrl, Src: src, FragCnt: 1}, js)
}

// StreamFrame prefixes a packet with its u16 BE length for use inside a
// WebTransport stream (streams are byte streams; datagrams/WS messages are not).
func StreamFrame(pkt []byte) []byte {
	out := make([]byte, 2+len(pkt))
	binary.BigEndian.PutUint16(out, uint16(len(pkt)))
	copy(out[2:], pkt)
	return out
}

// MaxStreamFrame bounds one length-prefixed stream frame.
const MaxStreamFrame = 65535
