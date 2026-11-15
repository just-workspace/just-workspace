package proto

import (
	"bytes"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	h := Header{
		Type: TypeAudio, Codec: CodecPCMS24, Flags: FlagFEC, Channels: 2, Bits: 24,
		Frame: 480, Rate: 48000, Seq: 0xDEADBEEF, TS: 0x01020304, Src: 7, FragIdx: 1, FragCnt: 3,
	}
	payload := bytes.Repeat([]byte{1, 2, 3}, 100)
	pkt := Marshal(h, payload)
	if len(pkt) != HeaderSize+len(payload) {
		t.Fatalf("len %d", len(pkt))
	}
	got, err := Decode(pkt)
	if err != nil {
		t.Fatal(err)
	}
	h.Version = Version
	if got != h {
		t.Fatalf("mismatch\n got %+v\nwant %+v", got, h)
	}
	if !bytes.Equal(Payload(pkt), payload) {
		t.Fatal("payload changed")
	}
	if got.FrameBytes() != 480*2*3 {
		t.Fatalf("FrameBytes %d", got.FrameBytes())
	}
	if got.Bitrate() != 48000*2*24 {
		t.Fatalf("Bitrate %v", got.Bitrate())
	}
}

func TestEncodeDefaultsFragCnt(t *testing.T) {
	pkt := Marshal(Header{Type: TypePing}, nil)
	h, err := Decode(pkt)
	if err != nil {
		t.Fatal(err)
	}
	if h.FragCnt != 1 || h.FragIdx != 0 {
		t.Fatalf("frag %d/%d", h.FragIdx, h.FragCnt)
	}
}

func TestDecodeErrors(t *testing.T) {
	if _, err := Decode(make([]byte, HeaderSize-1)); err != ErrShort {
		t.Fatalf("short: %v", err)
	}
	bad := Marshal(Header{}, nil)
	bad[0] = 9
	if _, err := Decode(bad); err == nil {
		t.Fatal("version accepted")
	}
	frag := Marshal(Header{FragIdx: 2, FragCnt: 2}, nil)
	if _, err := Decode(frag); err != ErrFrag {
		t.Fatalf("frag: %v", err)
	}
	if _, err := Decode(make([]byte, MaxPacket+1)); err != ErrTooBig {
		t.Fatal("too big accepted")
	}
}

func TestStampAndFlags(t *testing.T) {
	pkt := Marshal(Header{Type: TypeAudio}, []byte{9})
	StampSrc(pkt, 0x1234)
	SetFlag(pkt, FlagRetransmit)
	h, _ := Decode(pkt)
	if h.Src != 0x1234 || h.Flags&FlagRetransmit == 0 {
		t.Fatalf("%+v", h)
	}
	if Payload(pkt)[0] != 9 {
		t.Fatal("payload touched")
	}
}

func TestNack(t *testing.T) {
	pkt := EncodeNack(3, []uint32{10, 11, 4000000000})
	h, err := Decode(pkt)
	if err != nil || h.Type != TypeNack || h.Src != 3 {
		t.Fatalf("%v %+v", err, h)
	}
	seqs := DecodeNack(Payload(pkt))
	if len(seqs) != 3 || seqs[2] != 4000000000 {
		t.Fatalf("%v", seqs)
	}
	if GroupBase(7) != 4 || GroupBase(8) != 8 || GroupBase(0) != 0 {
		t.Fatal("GroupBase")
	}
}

func TestStreamFrame(t *testing.T) {
	pkt := Marshal(Header{Type: TypeCtrl}, []byte(`{"t":"x"}`))
	f := StreamFrame(pkt)
	if int(f[0])<<8|int(f[1]) != len(pkt) || !bytes.Equal(f[2:], pkt) {
		t.Fatal("frame")
	}
}
