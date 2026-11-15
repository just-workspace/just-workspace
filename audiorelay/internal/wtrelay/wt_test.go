package wtrelay

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"just-workspace/audiorelay/internal/proto"
	"just-workspace/audiorelay/internal/room"
	"just-workspace/audiorelay/internal/server"
	"just-workspace/audiorelay/internal/token"
)

var secret = []byte("0123456789abcdef0123456789abcdef")

func startServer(t *testing.T) (*Server, string, *room.Hub) {
	t.Helper()
	certs, err := server.SelfSigned([]string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	// Pick a free UDP port.
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := pc.LocalAddr().String()
	pc.Close()
	hub := room.NewHub(room.Options{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	s := &Server{Addr: addr, TLS: certs.TLSConfig(), Hub: hub, Secret: secret, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	go func() { _ = s.ListenAndServe() }()
	t.Cleanup(func() { _ = s.Close() })
	// Wait for the listener.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		c, err := net.Dial("udp4", addr)
		if err == nil {
			c.Close()
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	return s, "https://" + addr + Path, hub
}

type client struct {
	sess *webtransport.Session
	str  *webtransport.Stream
}

func connect(t *testing.T, url, tok string) *client {
	t.Helper()
	d := webtransport.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true, NextProtos: []string{http3.NextProtoH3}},
		QUICConfig:      &quic.Config{EnableDatagrams: true, EnableStreamResetPartialDelivery: true},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, sess, err := d.Dial(ctx, url, http.Header{})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	str, err := sess.OpenStreamSync(ctx)
	if err != nil {
		t.Fatal(err)
	}
	auth, _ := json.Marshal(map[string]string{"t": "auth", "token": tok})
	if _, err := str.Write(proto.StreamFrame(proto.Ctrl(0, auth))); err != nil {
		t.Fatal(err)
	}
	c := &client{sess: sess, str: str}
	t.Cleanup(func() { sess.CloseWithError(0, "") })
	return c
}

func (c *client) readCtrl(t *testing.T, typ string) map[string]any {
	t.Helper()
	_ = c.str.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		pkt, err := readFrame(c.str)
		if err != nil {
			t.Fatalf("stream read: %v", err)
		}
		h, err := proto.Decode(pkt)
		if err != nil || h.Type != proto.TypeCtrl {
			continue
		}
		var m map[string]any
		if json.Unmarshal(proto.Payload(pkt), &m) == nil && m["t"] == typ {
			return m
		}
	}
}

func mint(roomID, uid string) string {
	now := time.Now().Unix()
	return token.Sign(secret, token.Claims{Room: roomID, UID: uid, Name: uid, IAT: now, EXP: now + 60})
}

func TestWebTransportDatagramRelay(t *testing.T) {
	_, url, hub := startServer(t)
	a := connect(t, url, mint("voice-wt", "alice"))
	wa := a.readCtrl(t, "welcome")
	b := connect(t, url, mint("voice-wt", "bob"))
	b.readCtrl(t, "welcome")
	a.readCtrl(t, "peer_joined")
	if hub.Summary().Peers != 2 {
		t.Fatal("peers")
	}

	payload := make([]byte, 720)
	for i := range payload {
		payload[i] = byte(i)
	}
	pkt := proto.Marshal(proto.Header{Type: proto.TypeAudio, Codec: proto.CodecPCMS24, Channels: 2, Bits: 24, Frame: 120, Rate: 48000, Seq: 9, FragCnt: 1}, payload)
	// Datagrams may be dropped before the path is validated; send a few.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got := make(chan []byte, 1)
	go func() {
		for {
			dg, err := b.sess.ReceiveDatagram(ctx)
			if err != nil {
				return
			}
			if h, err := proto.Decode(dg); err == nil && h.Type == proto.TypeAudio {
				got <- dg
				return
			}
		}
	}()
	var recv []byte
loop:
	for i := 0; i < 50; i++ {
		if err := a.sess.SendDatagram(pkt); err != nil {
			t.Fatal(err)
		}
		select {
		case recv = <-got:
			break loop
		case <-time.After(100 * time.Millisecond):
		}
	}
	if recv == nil {
		t.Fatal("no datagram relayed")
	}
	h, _ := proto.Decode(recv)
	if h.Src != uint16(wa["peer"].(float64)) || h.Seq != 9 || string(proto.Payload(recv)) != string(payload) {
		t.Fatalf("relayed %+v", h)
	}

	// NACK on the stream → retransmission on the stream, flagged.
	if _, err := b.str.Write(proto.StreamFrame(proto.EncodeNack(h.Src, []uint32{9}))); err != nil {
		t.Fatal(err)
	}
	_ = b.str.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		f, err := readFrame(b.str)
		if err != nil {
			t.Fatalf("retx read: %v", err)
		}
		fh, _ := proto.Decode(f)
		if fh.Type == proto.TypeAudio {
			if fh.Flags&proto.FlagRetransmit == 0 || string(proto.Payload(f)) != string(payload) {
				t.Fatal("bad retransmit")
			}
			break
		}
	}
}

func TestWebTransportRejectsBadAuth(t *testing.T) {
	_, url, hub := startServer(t)
	c := connect(t, url, "not-a-token")
	_ = c.str.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := readFrame(c.str); err == nil {
		t.Fatal("expected the session to close")
	}
	<-time.After(50 * time.Millisecond)
	if hub.Summary().Peers != 0 {
		t.Fatal("peer admitted with bad token")
	}
}
