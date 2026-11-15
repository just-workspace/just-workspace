package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"just-workspace/audiorelay/internal/proto"
	"just-workspace/audiorelay/internal/room"
	"just-workspace/audiorelay/internal/token"
)

var secret = []byte("0123456789abcdef0123456789abcdef")

func newServer(t *testing.T, wt *WebTransportInfo, certs *CertSource) (*httptest.Server, *room.Hub) {
	hub := room.NewHub(room.Options{Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	h := &HTTP{Hub: hub, Secret: secret, WT: wt, Certs: certs, Log: slog.Default()}
	srv := httptest.NewServer(h.Handler())
	t.Cleanup(srv.Close)
	return srv, hub
}

func mint(roomID, uid string) string {
	now := time.Now().Unix()
	return token.Sign(secret, token.Claims{Room: roomID, UID: uid, Name: uid, IAT: now, EXP: now + 60, Nonce: "n"})
}

func dial(t *testing.T, srv *httptest.Server, tok string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/audiorelay/ws"
	enc := base64.RawURLEncoding.EncodeToString([]byte(tok))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"jw.relay", "jw.token." + enc}})
	if err != nil {
		t.Fatalf("dial: %v (%v)", err, resp)
	}
	if c.Subprotocol() != "jw.relay" {
		t.Fatalf("subprotocol %q", c.Subprotocol())
	}
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return c
}

func readCtrl(t *testing.T, c *websocket.Conn, typ string) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		h, err := proto.Decode(data)
		if err != nil || h.Type != proto.TypeCtrl {
			continue
		}
		var m map[string]any
		if json.Unmarshal(proto.Payload(data), &m) == nil && m["t"] == typ {
			return m
		}
	}
}

func readAudio(t *testing.T, c *websocket.Conn) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if h, err := proto.Decode(data); err == nil && h.Type == proto.TypeAudio {
			return data
		}
	}
}

func TestWebSocketRelayEndToEnd(t *testing.T) {
	srv, _ := newServer(t, nil, nil)
	a := dial(t, srv, mint("voice-1", "alice"))
	wa := readCtrl(t, a, "welcome")
	b := dial(t, srv, mint("voice-1", "bob"))
	wb := readCtrl(t, b, "welcome")
	if wa["room"] != "voice-1" || len(wb["peers"].([]any)) != 1 {
		t.Fatalf("welcome %v / %v", wa, wb)
	}
	readCtrl(t, a, "peer_joined")

	payload := make([]byte, 2880)
	for i := range payload {
		payload[i] = byte(i * 7)
	}
	pkt := proto.Marshal(proto.Header{Type: proto.TypeAudio, Codec: proto.CodecPCMS24, Channels: 2, Bits: 24, Frame: 480, Rate: 48000, Seq: 5, TS: 2400, FragCnt: 1}, payload)
	ctx := context.Background()
	if err := a.Write(ctx, websocket.MessageBinary, pkt); err != nil {
		t.Fatal(err)
	}
	got := readAudio(t, b)
	h, _ := proto.Decode(got)
	if h.Src != uint16(wa["peer"].(float64)) || h.Seq != 5 {
		t.Fatalf("%+v", h)
	}
	if string(proto.Payload(got)) != string(payload) {
		t.Fatal("payload not bit-exact")
	}

	// NACK over WS is served from the relay cache.
	if err := b.Write(ctx, websocket.MessageBinary, proto.EncodeNack(h.Src, []uint32{5})); err != nil {
		t.Fatal(err)
	}
	rt := readAudio(t, b)
	rh, _ := proto.Decode(rt)
	if rh.Flags&proto.FlagRetransmit == 0 || string(proto.Payload(rt)) != string(payload) {
		t.Fatal("retransmit")
	}

	// Stats endpoint: token-gated, room-scoped.
	req, _ := http.NewRequest("GET", srv.URL+"/audiorelay/stats", nil)
	req.Header.Set("Authorization", "Bearer "+mint("voice-1", "carol"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var st room.RoomStats
	_ = json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if resp.StatusCode != 200 || len(st.Peers) != 2 {
		t.Fatalf("stats %d %+v", resp.StatusCode, st)
	}
	var alice room.PeerStats
	for _, p := range st.Peers {
		if p.UID == "alice" {
			alice = p
		}
	}
	if alice.Format == nil || alice.Format.Codec != "pcm_s24" || alice.PacketsIn != 1 || alice.RetxSent != 1 {
		t.Fatalf("alice %+v", alice)
	}
	// Other room → empty, no leak.
	req.Header.Set("Authorization", "Bearer "+mint("voice-2", "eve"))
	resp, _ = http.DefaultClient.Do(req)
	_ = json.NewDecoder(resp.Body).Decode(&st)
	resp.Body.Close()
	if len(st.Peers) != 0 {
		t.Fatal("stats leaked across rooms")
	}
	resp, _ = http.Get(srv.URL + "/audiorelay/stats")
	if resp.StatusCode != 401 {
		t.Fatalf("unauthenticated stats %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestWebSocketRejectsBadToken(t *testing.T) {
	srv, _ := newServer(t, nil, nil)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/audiorelay/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"jw.relay", "jw.token.bogus"}})
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got err=%v resp=%v", err, resp)
	}
	// Expired token
	old := token.Sign(secret, token.Claims{Room: "r", UID: "u", EXP: time.Now().Unix() - 100})
	enc := base64.RawURLEncoding.EncodeToString([]byte(old))
	_, resp, err = websocket.Dial(ctx, url, &websocket.DialOptions{Subprotocols: []string{"jw.relay", "jw.token." + enc}})
	if err == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatal("expired token accepted")
	}
}

func TestInfoAndHealth(t *testing.T) {
	certs, err := SelfSigned([]string{"127.0.0.1", "localhost"})
	if err != nil {
		t.Fatal(err)
	}
	srv, _ := newServer(t, &WebTransportInfo{URL: "https://127.0.0.1:4433/audiorelay/wt"}, certs)
	resp, err := http.Get(srv.URL + "/audiorelay/info")
	if err != nil {
		t.Fatal(err)
	}
	var inf Info
	_ = json.NewDecoder(resp.Body).Decode(&inf)
	resp.Body.Close()
	if inf.Protocol != 1 || inf.WSPath != "/audiorelay/ws" || inf.WebTransport == nil {
		t.Fatalf("%+v", inf)
	}
	if !inf.WebTransport.SelfSigned || len(inf.WebTransport.CertHash) != 64 || inf.WebTransport.CertHash != certs.Hash() {
		t.Fatalf("wt %+v", inf.WebTransport)
	}
	if na := certs.NotAfter(); time.Until(na) > 14*24*time.Hour || time.Until(na) < 12*24*time.Hour {
		t.Fatalf("self-signed validity %v", time.Until(na))
	}
	resp, _ = http.Get(srv.URL + "/audiorelay/health")
	if resp.StatusCode != 200 {
		t.Fatal("health")
	}
	resp.Body.Close()

	// Without WebTransport configured the field is null.
	srv2, _ := newServer(t, nil, nil)
	resp, _ = http.Get(srv2.URL + "/audiorelay/info")
	var inf2 Info
	_ = json.NewDecoder(resp.Body).Decode(&inf2)
	resp.Body.Close()
	if inf2.WebTransport != nil {
		t.Fatal("wt should be null")
	}
}
