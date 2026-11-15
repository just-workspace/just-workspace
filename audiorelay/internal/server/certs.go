package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"errors"
	"math/big"
	"net"
	"os"
	"sync"
	"time"
)

// CertSource provides the TLS config for WebTransport and the leaf-certificate
// hash browsers need for serverCertificateHashes when the cert is not
// publicly trusted (LAN / self-signed mode).
type CertSource struct {
	mu       sync.Mutex
	cert     *tls.Certificate
	hash     string // hex sha-256 of the leaf DER; "" for CA-issued certs
	self     bool
	certFile string
	keyFile  string
	loaded   time.Time
	hosts    []string
}

// FromFiles reloads the PEM pair at most once an hour (Let's Encrypt renews in
// place; quic-go asks GetCertificate per handshake).
func FromFiles(certFile, keyFile string) (*CertSource, error) {
	cs := &CertSource{certFile: certFile, keyFile: keyFile}
	if err := cs.reload(); err != nil {
		return nil, err
	}
	return cs, nil
}

// SelfSigned makes an ECDSA P-256 certificate valid for 13 days — the
// WebTransport serverCertificateHashes rules require ECDSA and ≤ 14 days.
func SelfSigned(hosts []string) (*CertSource, error) {
	cs := &CertSource{self: true, hosts: hosts}
	if err := cs.regen(); err != nil {
		return nil, err
	}
	return cs, nil
}

func (c *CertSource) regen() error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	now := time.Now().Add(-time.Hour)
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "audiorelay (self-signed, LAN)"},
		NotBefore:    now,
		NotAfter:     now.Add(13 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range c.hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else if h != "" {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(der)
	leaf, _ := x509.ParseCertificate(der)
	c.mu.Lock()
	c.cert = &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
	c.hash = hex.EncodeToString(sum[:])
	c.loaded = time.Now()
	c.mu.Unlock()
	return nil
}

func (c *CertSource) reload() error {
	crt, err := tls.LoadX509KeyPair(c.certFile, c.keyFile)
	if err != nil {
		return err
	}
	if crt.Leaf == nil && len(crt.Certificate) > 0 {
		crt.Leaf, _ = x509.ParseCertificate(crt.Certificate[0])
	}
	c.mu.Lock()
	c.cert = &crt
	c.loaded = time.Now()
	c.mu.Unlock()
	return nil
}

// Hash is the leaf hash (self-signed only).
func (c *CertSource) Hash() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hash
}

// SelfSigned reports whether the cert is the generated one.
func (c *CertSource) IsSelfSigned() bool { return c.self }

// NotAfter is the leaf expiry.
func (c *CertSource) NotAfter() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cert == nil || c.cert.Leaf == nil {
		return time.Time{}
	}
	return c.cert.Leaf.NotAfter
}

// TLSConfig returns an HTTP/3-ready config.
func (c *CertSource) TLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			c.mu.Lock()
			stale := !c.self && time.Since(c.loaded) > time.Hour
			// Regenerate the self-signed cert a day before it would expire so a
			// long-running container keeps a valid hash.
			regen := c.self && c.cert != nil && c.cert.Leaf != nil && time.Until(c.cert.Leaf.NotAfter) < 24*time.Hour
			cert := c.cert
			c.mu.Unlock()
			if stale {
				_ = c.reload()
			}
			if regen {
				_ = c.regen()
			}
			if stale || regen {
				c.mu.Lock()
				cert = c.cert
				c.mu.Unlock()
			}
			if cert == nil {
				return nil, errors.New("no certificate")
			}
			return cert, nil
		},
	}
}

// FilesExist is true when both PEM files are readable.
func FilesExist(certFile, keyFile string) bool {
	if certFile == "" || keyFile == "" {
		return false
	}
	_, e1 := os.Stat(certFile)
	_, e2 := os.Stat(keyFile)
	return e1 == nil && e2 == nil
}
