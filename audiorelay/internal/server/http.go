// Package server wires the HTTP side: health, info, stats and the WebSocket
// upgrade. It listens on plain HTTP inside the compose network; ws-nginx
// fronts it at /audiorelay/.
package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"just-workspace/audiorelay/internal/room"
	"just-workspace/audiorelay/internal/token"
	"just-workspace/audiorelay/internal/wsrelay"
)

// Version is stamped at build time; main overrides it from JW_APP_VERSION when set.
var Version = "dev"

// Info is the GET /audiorelay/info document the backend relays to clients.
type Info struct {
	Version      string            `json:"version"`
	Protocol     int               `json:"protocol"`
	WSPath       string            `json:"ws_path"`
	WebTransport *WebTransportInfo `json:"webtransport"` // null when disabled
	Summary      room.Summary      `json:"summary"`
}

// WebTransportInfo tells the browser how to reach the UDP side.
type WebTransportInfo struct {
	URL        string `json:"url"`
	CertHash   string `json:"cert_hash,omitempty"` // sha-256 hex of the leaf; only for self-signed
	SelfSigned bool   `json:"self_signed"`
	NotAfter   string `json:"not_after,omitempty"`
}

// HTTP builds the mux.
type HTTP struct {
	Hub     *room.Hub
	Secret  []byte
	WT      *WebTransportInfo
	Certs   *CertSource
	Log     *slog.Logger
	MaxBody int64
}

// Handler returns the router.
func (s *HTTP) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /audiorelay/health", s.health)
	mux.HandleFunc("GET /audiorelay/info", s.info)
	mux.HandleFunc("GET /audiorelay/stats", s.stats)
	mux.Handle("GET /audiorelay/ws", &wsrelay.Handler{Hub: s.Hub, Secret: s.Secret, Log: s.Log})
	return mux
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *HTTP) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "version": Version, "time": time.Now().UTC().Format(time.RFC3339)})
}

func (s *HTTP) info(w http.ResponseWriter, _ *http.Request) {
	inf := Info{Version: Version, Protocol: 1, WSPath: "/audiorelay/ws", Summary: s.Hub.Summary()}
	if s.WT != nil {
		cp := *s.WT
		if s.Certs != nil && s.Certs.IsSelfSigned() {
			cp.CertHash = s.Certs.Hash()
			cp.SelfSigned = true
			cp.NotAfter = s.Certs.NotAfter().UTC().Format(time.RFC3339)
		}
		inf.WebTransport = &cp
	}
	writeJSON(w, 200, inf)
}

// stats requires the caller's relay token; it only ever returns the room that
// token is for, so members cannot peek at other channels.
func (s *HTTP) stats(w http.ResponseWriter, r *http.Request) {
	tok := ""
	if a := r.Header.Get("Authorization"); strings.HasPrefix(a, "Bearer ") {
		tok = strings.TrimSpace(a[7:])
	}
	claims, err := token.Verify(s.Secret, tok, time.Now())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid relay token"})
		return
	}
	st := s.Hub.RoomStats(claims.Room)
	if st == nil {
		writeJSON(w, 200, room.RoomStats{T: "stats", Room: claims.Room, ServerTimeMs: time.Now().UnixMilli(), Peers: []room.PeerStats{}})
		return
	}
	writeJSON(w, 200, st)
}
