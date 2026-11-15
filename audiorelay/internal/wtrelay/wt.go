// Package wtrelay is the WebTransport (HTTP/3 over QUIC/UDP) transport.
//
// Audio and parity ride on QUIC DATAGRAM frames (unreliable, no head-of-line
// blocking); control, NACKs, retransmissions and the stats push use one
// bidirectional stream the client opens first. The very first stream frame
// must be a ctrl {"t":"auth","token":"…"} message — browsers cannot set
// headers on a WebTransport handshake and we refuse to put the token in the
// URL.
//
// Stream framing: u16 big-endian length + packet (PROTOCOL.md §4.2).
package wtrelay

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	"just-workspace/audiorelay/internal/proto"
	"just-workspace/audiorelay/internal/room"
	"just-workspace/audiorelay/internal/token"
)

const (
	authTimeout = 5 * time.Second
	// Path the browser connects to.
	Path = "/audiorelay/wt"
)

// Server wraps webtransport-go.
type Server struct {
	Addr   string
	TLS    *tls.Config
	Hub    *room.Hub
	Secret []byte
	Log    *slog.Logger

	wt *webtransport.Server
}

// ListenAndServe blocks until the server stops.
func (s *Server) ListenAndServe() error {
	mux := http.NewServeMux()
	s.wt = &webtransport.Server{
		H3: &http3.Server{
			Addr: s.Addr,
			// Adds the h3 ALPN; webtransport-go hands the config straight to quic-go.
			TLSConfig:       http3.ConfigureTLSConfig(s.TLS),
			Handler:         mux,
			EnableDatagrams: true,
			QUICConfig: &quic.Config{
				EnableDatagrams:                  true,
				EnableStreamResetPartialDelivery: true,
				MaxIdleTimeout:                   30 * time.Second,
				KeepAlivePeriod:                  10 * time.Second,
				InitialPacketSize:                1200,
				DisablePathMTUDiscovery:          false,
			},
		},
		// Auth is the signed token, so any page origin may connect.
		CheckOrigin: func(*http.Request) bool { return true },
	}
	mux.HandleFunc(Path, s.handle)
	mux.HandleFunc("/audiorelay/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"transport":"webtransport"}`))
	})
	s.Log.Info("webtransport listening", "addr", s.Addr, "path", Path)
	return s.wt.ListenAndServe()
}

// Close stops the server.
func (s *Server) Close() error {
	if s.wt == nil {
		return nil
	}
	return s.wt.Close()
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	sess, err := s.wt.Upgrade(w, r)
	if err != nil {
		s.Log.Warn("wt upgrade failed", "err", err)
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	go s.serve(sess)
}

type authMsg struct {
	T     string `json:"t"`
	Token string `json:"token"`
}

func (s *Server) serve(sess *webtransport.Session) {
	ctx, cancel := context.WithTimeout(context.Background(), authTimeout)
	str, err := sess.AcceptStream(ctx)
	cancel()
	if err != nil {
		sess.CloseWithError(1, "no control stream")
		return
	}
	_ = str.SetReadDeadline(time.Now().Add(authTimeout))
	first, err := readFrame(str)
	if err != nil {
		sess.CloseWithError(1, "bad auth frame")
		return
	}
	_ = str.SetReadDeadline(time.Time{})
	h, err := proto.Decode(first)
	if err != nil || h.Type != proto.TypeCtrl {
		sess.CloseWithError(1, "auth must be ctrl")
		return
	}
	var am authMsg
	if json.Unmarshal(proto.Payload(first), &am) != nil || am.T != "auth" {
		sess.CloseWithError(1, "auth must be {t:auth}")
		return
	}
	claims, err := token.Verify(s.Secret, am.Token, time.Now())
	if err != nil {
		sess.CloseWithError(2, "invalid relay token")
		return
	}
	tr := &transport{sess: sess, str: str}
	peer, err := s.Hub.Join(claims, tr)
	if err != nil {
		sess.CloseWithError(3, err.Error())
		return
	}

	// Datagram reader: audio/parity/ping from the client.
	go func() {
		for {
			dg, err := sess.ReceiveDatagram(context.Background())
			if err != nil {
				peer.Leave("datagram: " + err.Error())
				return
			}
			peer.Ingest(dg, false)
		}
	}()
	// Stream reader: ctrl/nack/ping.
	for {
		pkt, err := readFrame(str)
		if err != nil {
			peer.Leave("stream: " + err.Error())
			return
		}
		peer.Ingest(pkt, true)
	}
}

// readFrame reads one u16-length-prefixed packet.
func readFrame(r io.Reader) ([]byte, error) {
	var lb [2]byte
	if _, err := io.ReadFull(r, lb[:]); err != nil {
		return nil, err
	}
	n := int(binary.BigEndian.Uint16(lb[:]))
	if n < proto.HeaderSize {
		return nil, errors.New("frame too short")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

type transport struct {
	sess *webtransport.Session
	str  *webtransport.Stream
	mu   sync.Mutex
}

func (t *transport) SendUnreliable(p []byte) error {
	// quic-go may retain the slice until the datagram is sent — copy.
	cp := make([]byte, len(p))
	copy(cp, p)
	return t.sess.SendDatagram(cp)
}

func (t *transport) SendReliable(p []byte) error {
	if len(p) > proto.MaxStreamFrame {
		return errors.New("frame too large for stream")
	}
	f := proto.StreamFrame(p)
	t.mu.Lock()
	defer t.mu.Unlock()
	_ = t.str.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := t.str.Write(f)
	return err
}

func (t *transport) Kind() string { return "webtransport" }

func (t *transport) Close(reason string) {
	if len(reason) > 120 {
		reason = reason[:120]
	}
	t.sess.CloseWithError(0, reason)
}
