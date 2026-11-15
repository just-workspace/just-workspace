// audiorelay — lossless real-time audio relay for just-workspace voice channels.
//
// Pure forwarder (SFU style): it never decodes or transcodes. See PROTOCOL.md.
//
// Environment:
//
//	RELAY_SECRET            HMAC secret shared with the backend (AUDIORELAY_SECRET). Required.
//	RELAY_HTTP_ADDR         plain HTTP listener (health/info/stats/ws). Default :8090
//	RELAY_WT_ADDR           WebTransport UDP listener. Default :4433. Empty disables WebTransport.
//	RELAY_WT_PUBLIC_URL     URL browsers use, e.g. https://relay.example.com:4433/audiorelay/wt.
//	                        Empty disables WebTransport (clients use WebSocket only).
//	RELAY_WT_CERT / RELAY_WT_KEY   PEM pair for the WT listener. Missing → self-signed
//	                        13-day ECDSA cert; its hash is published at /audiorelay/info
//	                        (browsers need serverCertificateHashes). LAN/testing only.
//	RELAY_WT_SELF_SIGNED_HOSTS     comma list of IPs/names for the self-signed SAN.
//	RELAY_MAX_ROOMS, RELAY_MAX_PEERS_PER_ROOM   limits (256 / 16)
//	RELAY_TEST_DROP_PERCENT  drop N% of forwarded audio (loss-recovery tests only)
//	RELAY_LOG_LEVEL          debug|info|warn (info)
//
// `audiorelay -check` performs the container health check (distroless has no curl).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"just-workspace/audiorelay/internal/room"
	"just-workspace/audiorelay/internal/server"
	"just-workspace/audiorelay/internal/wtrelay"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	check := flag.Bool("check", false, "health check against the local HTTP listener and exit")
	flag.Parse()
	httpAddr := env("RELAY_HTTP_ADDR", ":8090")
	if *check {
		os.Exit(healthCheck(httpAddr))
	}

	lvl := slog.LevelInfo
	switch strings.ToLower(env("RELAY_LOG_LEVEL", "info")) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
	slog.SetDefault(log)

	secret := []byte(os.Getenv("RELAY_SECRET"))
	if len(secret) < 16 {
		log.Error("RELAY_SECRET missing or shorter than 16 bytes")
		os.Exit(2)
	}

	hub := room.NewHub(room.Options{
		MaxRooms:        envInt("RELAY_MAX_ROOMS", 256),
		MaxPeersPerRoom: envInt("RELAY_MAX_PEERS_PER_ROOM", 16),
		TestDropPercent: envInt("RELAY_TEST_DROP_PERCENT", 0),
		Log:             log,
	})
	if hub != nil && envInt("RELAY_TEST_DROP_PERCENT", 0) > 0 {
		log.Warn("RELAY_TEST_DROP_PERCENT is set — dropping forwarded audio on purpose (tests only)")
	}

	var wtInfo *server.WebTransportInfo
	var certs *server.CertSource
	wtAddr := env("RELAY_WT_ADDR", ":4433")
	wtURL := os.Getenv("RELAY_WT_PUBLIC_URL")
	if wtAddr != "" && wtURL != "" {
		certFile, keyFile := os.Getenv("RELAY_WT_CERT"), os.Getenv("RELAY_WT_KEY")
		var err error
		if server.FilesExist(certFile, keyFile) {
			certs, err = server.FromFiles(certFile, keyFile)
			if err != nil {
				log.Error("loading WebTransport certificate", "err", err)
				os.Exit(2)
			}
			log.Info("webtransport certificate loaded", "cert", certFile, "not_after", certs.NotAfter())
		} else {
			hosts := strings.Split(env("RELAY_WT_SELF_SIGNED_HOSTS", "localhost,127.0.0.1"), ",")
			certs, err = server.SelfSigned(hosts)
			if err != nil {
				log.Error("generating self-signed certificate", "err", err)
				os.Exit(2)
			}
			log.Warn("webtransport using SELF-SIGNED certificate (LAN/testing only); browsers need serverCertificateHashes from /audiorelay/info",
				"hosts", hosts, "hash", certs.Hash(), "not_after", certs.NotAfter())
		}
		wtInfo = &server.WebTransportInfo{URL: wtURL}
		wt := &wtrelay.Server{Addr: wtAddr, TLS: certs.TLSConfig(), Hub: hub, Secret: secret, Log: log}
		go func() {
			if err := wt.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("webtransport server stopped", "err", err)
				os.Exit(1)
			}
		}()
	} else {
		log.Info("webtransport disabled (RELAY_WT_PUBLIC_URL empty) — WebSocket only")
	}

	h := &server.HTTP{Hub: hub, Secret: secret, WT: wtInfo, Certs: certs, Log: log}
	srv := &http.Server{
		Addr:              httpAddr,
		Handler:           h.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("http listening", "addr", httpAddr, "version", server.Version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server stopped", "err", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

func healthCheck(addr string) int {
	host := addr
	if strings.HasPrefix(host, ":") {
		host = "127.0.0.1" + host
	}
	c := &http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://" + host + "/audiorelay/health")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Fprintln(os.Stderr, "status", resp.StatusCode)
		return 1
	}
	return 0
}
