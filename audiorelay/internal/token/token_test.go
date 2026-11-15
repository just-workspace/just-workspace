package token

import (
	"strings"
	"testing"
	"time"
)

var secret = []byte("test-secret")

func TestSignVerify(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tok := Sign(secret, Claims{Room: "voice-abc", UID: "u1", Name: "Alice", IAT: now.Unix(), EXP: now.Unix() + 120, Nonce: "n"})
	c, err := Verify(secret, tok, now)
	if err != nil {
		t.Fatal(err)
	}
	if c.Room != "voice-abc" || c.UID != "u1" || c.Name != "Alice" {
		t.Fatalf("%+v", c)
	}
}

// Fixed vector shared with backend/tests/test_voice_relay.py — if either side
// changes the format, both tests fail.
func TestKnownVector(t *testing.T) {
	// body = {"room":"voice-r1","uid":"u1","name":"A","iat":1700000000,"exp":1700000120,"nonce":"x"}
	const tok = "eyJyb29tIjoidm9pY2UtcjEiLCJ1aWQiOiJ1MSIsIm5hbWUiOiJBIiwiaWF0IjoxNzAwMDAwMDAwLCJleHAiOjE3MDAwMDAxMjAsIm5vbmNlIjoieCJ9." +
		"V5oZ5LFHJ8gkvjprQ5xo_BMBvySbQGNkAc-tAedjw1o"
	c, err := Verify([]byte("shared-secret"), tok, time.Unix(1700000100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if c.Room != "voice-r1" || c.UID != "u1" {
		t.Fatalf("%+v", c)
	}
}

func TestRejects(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	good := Sign(secret, Claims{Room: "r", UID: "u", EXP: now.Unix() + 10})
	cases := map[string]struct {
		tok    string
		secret []byte
		now    time.Time
		want   error
	}{
		"wrong secret": {good, []byte("other"), now, ErrSignature},
		"empty secret": {good, nil, now, ErrSignature},
		"expired":      {good, secret, now.Add(20 * time.Second), ErrExpired},
		"no dot":       {strings.ReplaceAll(good, ".", "_"), secret, now, ErrFormat},
		"tampered":     {"x" + good[1:], secret, now, ErrSignature},
	}
	for name, c := range cases {
		if _, err := Verify(c.secret, c.tok, c.now); err != c.want {
			t.Errorf("%s: got %v want %v", name, err, c.want)
		}
	}
	// Signed but missing claims.
	bad := Sign(secret, Claims{Room: "r"})
	if _, err := Verify(secret, bad, now); err != ErrClaims {
		t.Errorf("claims: %v", err)
	}
	// 5 s slack.
	if _, err := Verify(secret, good, now.Add(14*time.Second)); err != nil {
		t.Errorf("slack: %v", err)
	}
}
