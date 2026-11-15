// Package token verifies the relay tokens the backend mints.
//
// Format: base64url(JSON claims) "." base64url(HMAC-SHA256(secret, base64url(JSON claims)))
// — the same shape on both sides so the Python and Go test vectors match.
// Claims: {"room","uid","name","iat","exp","nonce"}. The relay needs no DB:
// channel access was checked by the backend when it issued the token.
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Claims is the token body.
type Claims struct {
	Room string `json:"room"`
	UID  string `json:"uid"`
	Name string `json:"name,omitempty"`
	// LiveKit identity of the same session (voice presence key). Lets clients
	// pair a relay peer with the LiveKit participant and prefer the PCM stream.
	Identity string `json:"identity,omitempty"`
	IAT      int64  `json:"iat"`
	EXP      int64  `json:"exp"`
	Nonce    string `json:"nonce,omitempty"`
}

var (
	ErrFormat    = errors.New("token: malformed")
	ErrSignature = errors.New("token: bad signature")
	ErrExpired   = errors.New("token: expired")
	ErrClaims    = errors.New("token: missing claims")
)

var b64 = base64.RawURLEncoding

// Sign mints a token (used by tests and the self-test CLI; production tokens
// come from the backend).
func Sign(secret []byte, c Claims) string {
	body, _ := json.Marshal(c)
	enc := b64.EncodeToString(body)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(enc))
	return enc + "." + b64.EncodeToString(mac.Sum(nil))
}

// Verify checks signature and expiry (with 5 s of clock slack) and returns the claims.
func Verify(secret []byte, tok string, now time.Time) (Claims, error) {
	var c Claims
	if len(secret) == 0 {
		return c, ErrSignature
	}
	i := strings.IndexByte(tok, '.')
	if i <= 0 || i == len(tok)-1 {
		return c, ErrFormat
	}
	enc, sig := tok[:i], tok[i+1:]
	want, err := b64.DecodeString(sig)
	if err != nil {
		return c, ErrFormat
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(enc))
	if !hmac.Equal(mac.Sum(nil), want) {
		return c, ErrSignature
	}
	body, err := b64.DecodeString(enc)
	if err != nil {
		return c, ErrFormat
	}
	if err := json.Unmarshal(body, &c); err != nil {
		return c, ErrFormat
	}
	if c.Room == "" || c.UID == "" || c.EXP == 0 {
		return c, ErrClaims
	}
	if now.Unix() > c.EXP+5 {
		return c, ErrExpired
	}
	return c, nil
}
