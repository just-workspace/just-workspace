// Package wsrelay is the WebSocket transport. It lives behind ws-nginx at
// /audiorelay/ws, so it works wherever the app itself works (TCP 443 through
// the reverse proxy). WebSocket is reliable and ordered, so audio frames
// arrive late rather than lost; the client's jitter buffer absorbs that.
//
// Auth mirrors the backend's chat WebSocket: the relay token rides in
// Sec-WebSocket-Protocol as "jw.relay, jw.token.<base64url(token)>" (or in
// Authorization: Bearer for non-browser clients). Never in the query string —
// nginx error_log would keep it in plain text.
package wsrelay

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"just-workspace/audiorelay/internal/proto"
	"just-workspace/audiorelay/internal/room"
	"just-workspace/audiorelay/internal/token"
)

const (
	Subprotocol = "jw.relay"
	tokenPrefix = "jw.token."
	writeWait   = 5 * time.Second
)

// Handler upgrades and runs one WebSocket member.
type Handler struct {
	Hub    *room.Hub
	Secret []byte
	Log    *slog.Logger
}

// TokenFromRequest extracts the relay token from the handshake.
func TokenFromRequest(r *http.Request) string {
	for _, raw := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, p := range strings.Split(raw, ",") {
			p = strings.TrimSpace(p)
			if strings.HasPrefix(p, tokenPrefix) {
				enc := p[len(tokenPrefix):]
				if b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(enc, "=")); err == nil {
					return string(b)
				}
			}
		}
	}
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		return strings.TrimSpace(a[7:])
	}
	return ""
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	tok := TokenFromRequest(r)
	claims, err := token.Verify(h.Secret, tok, time.Now())
	if err != nil {
		// Reject before upgrading so the browser sees a clean 401 instead of a
		// socket that closes immediately.
		http.Error(w, "invalid relay token", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{Subprotocol},
		// Auth is the bearer token above, never a cookie, so cross-site
		// WebSocket hijacking does not apply and Origin need not be checked.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled, // PCM does not compress; save the CPU
	})
	if err != nil {
		return
	}
	c.SetReadLimit(proto.MaxPacket)
	tr := &transport{c: c}
	peer, err := h.Hub.Join(claims, tr)
	if err != nil {
		c.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}
	ctx := r.Context()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			peer.Leave("read: " + websocket.CloseStatus(err).String())
			return
		}
		if typ != websocket.MessageBinary {
			continue
		}
		peer.Ingest(data, true)
	}
}

type transport struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (t *transport) write(p []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), writeWait)
	defer cancel()
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.c.Write(ctx, websocket.MessageBinary, p)
}

func (t *transport) SendUnreliable(p []byte) error { return t.write(p) }
func (t *transport) SendReliable(p []byte) error   { return t.write(p) }
func (t *transport) Kind() string                  { return "websocket" }
func (t *transport) Close(reason string) {
	if len(reason) > 120 {
		reason = reason[:120]
	}
	_ = t.c.Close(websocket.StatusNormalClosure, reason)
}
