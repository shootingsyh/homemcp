package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"regexp"
	"time"
)

// ACME DNS-01 challenges for per-user certificates.
//
// DESIGN (decided 2026-10-18): every user gets their OWN certificate
// for <username>.tunnel.homemcp.si — no shared wildcard, so there is
// no single private key whose leak would compromise every tenant. The
// key pair is generated and stored on the client (HomeMCP on the
// user's own machine) and never leaves it; tunneld has no key-upload
// path at all. The one thing the client cannot do itself is publish
// the DNS-01 TXT record, because the Cloudflare API token must stay
// server-side. This file is exactly that narrow capability:
//
//	POST   /api/v1/certificates/dns-challenges       publish my TXT
//	GET    /api/v1/certificates/dns-challenges/{id}  poll propagation
//	DELETE /api/v1/certificates/dns-challenges/{id}  remove my TXT
//
// OWNERSHIP INVARIANT: the record name is DERIVED from the
// authenticated per-user token's username —
// _acme-challenge.<username>.<tunnel domain> — and no request field
// can name anything else. Publishing a challenge for another user's
// subdomain is not merely forbidden, it is inexpressible.
//
// The TXT value is the ACME key-authorization digest the client's
// ACME library computed (base64url of a SHA-256). tunneld treats it as
// an opaque string to publish and later match during propagation
// checks; it cannot be used to reconstruct any key material.

const (
	ChallengeActive  = "active"
	ChallengeCleaned = "cleaned"
	ChallengeExpired = "expired"
)

const (
	// challengeLifetime bounds how long a challenge TXT may live.
	// ACME validation takes seconds once propagated; two hours is a
	// generous window for slow client polling, after which the
	// sweeper removes the record so challenge TXT never accumulates.
	challengeLifetime = 2 * time.Hour
	// maxActiveChallenges caps simultaneous challenges per user
	// (concurrent issuance + a renewal in flight fits comfortably).
	maxActiveChallenges = 4
	// maxChallengesPerHour is a blunt anti-abuse rate cap per user.
	maxChallengesPerHour = 10
	challengeSweepEvery  = 10 * time.Minute
)

// txtValuePattern: the DNS-01 TXT value is base64url(SHA-256) —
// always exactly 43 chars of the URL-safe alphabet, no padding.
var txtValuePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

type createChallengeRequest struct {
	Value string `json:"value"`
}

type challengeView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Value     string `json:"value"`
	Status    string `json:"status"` // pending | propagated | cleaned | expired
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

func (s *Server) challengeName(username string) string {
	return "_acme-challenge." + s.cfg.SubdomainFor(username)
}

func (s *Server) challengeViewOf(ch DNSChallenge) challengeView {
	status := ch.Status
	if status == ChallengeActive {
		if !ch.PropagatedAt.IsZero() {
			status = "propagated"
		} else {
			status = "pending"
		}
	}
	return challengeView{
		ID:        ch.ID,
		Name:      s.challengeName(ch.Username),
		Value:     ch.Value,
		Status:    status,
		CreatedAt: ch.CreatedAt.Format(time.RFC3339),
		ExpiresAt: ch.ExpiresAt.Format(time.RFC3339),
	}
}

// cfClient lazily builds the Cloudflare client (tests inject their own
// via the Server field; main() relies on this).
func (s *Server) cfClient() *cloudflareClient {
	if s.cf == nil {
		s.cf = newCloudflareClient(s.cfg)
	}
	return s.cf
}

// lookupTXT resolves TXT records for the propagation check. Tests
// inject a fake via the Server field; production uses 1.1.1.1 (a
// Cloudflare resolver, fitting since the zone is served by
// Cloudflare) rather than the host resolver, whose results could come
// through layers of operator caching.
func (s *Server) lookupTXT(ctx context.Context, name string) ([]string, error) {
	if s.txtLookup != nil {
		return s.txtLookup(ctx, name)
	}
	r := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			return d.DialContext(ctx, "udp", "1.1.1.1:53")
		},
	}
	return r.LookupTXT(ctx, name)
}

// requireCertSetup gates all three certificate endpoints: without a
// Cloudflare token + zone the feature is off, uniformly 503.
func (s *Server) requireCertSetup(w http.ResponseWriter) bool {
	if !s.cfg.CertDNSConfigured() {
		writeAPIError(w, http.StatusServiceUnavailable, "cert_dns_not_configured", "certificate DNS is not configured on this server yet")
		return false
	}
	return true
}

// ownedChallenge loads a challenge and enforces ownership: a challenge
// that does not exist and one that belongs to another user are the
// same 404, so IDs cannot be probed across accounts.
func (s *Server) ownedChallenge(w http.ResponseWriter, r *http.Request, u User) (DNSChallenge, bool) {
	ch, ok := s.store.GetChallenge(r.PathValue("id"))
	if !ok || ch.Username != u.Username {
		writeAPIError(w, http.StatusNotFound, "challenge_not_found", "no such challenge")
		return DNSChallenge{}, false
	}
	return ch, true
}

// retireChallenge removes the Cloudflare record (best effort: an
// already-gone record is success, see cloudflareClient.deleteRecord)
// and marks the challenge with the given terminal status.
func (s *Server) retireChallenge(ch DNSChallenge, status string) {
	if ch.CFRecordID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := s.cfClient().deleteRecord(ctx, ch.CFRecordID); err != nil {
			// Leave the status active so a later DELETE or sweep
			// retries; report through the log.
			log.Printf("cert challenge %s: delete cloudflare record: %v", ch.ID, err)
			return
		}
	}
	_ = s.store.UpdateChallenge(ch.ID, func(x *DNSChallenge) {
		x.Status = status
	})
}

// handleCreateChallenge is POST /api/v1/certificates/dns-challenges
// (Bearer per-user token). It publishes ONE TXT record carrying the
// client's digest under the caller's own challenge name.
func (s *Server) handleCreateChallenge(w http.ResponseWriter, r *http.Request) {
	if !s.requireCertSetup(w) {
		return
	}
	u, ok := s.bearerUser(w, r)
	if !ok {
		return
	}
	now := time.Now().UTC()
	if allowed, _ := subscriptionAllows(u, now); !allowed {
		writeAPIError(w, http.StatusForbidden, "subscription_inactive", "an active subscription is required to issue certificates")
		return
	}
	var req createChallengeRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024))
	if err := dec.Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "request body must be JSON {value}")
		return
	}
	if !txtValuePattern.MatchString(req.Value) {
		writeAPIError(w, http.StatusUnprocessableEntity, "invalid_txt_value", "value must be the 43-character base64url SHA-256 digest of the ACME key authorization")
		return
	}
	id, err := newChallengeID()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not allocate challenge")
		return
	}
	ch := DNSChallenge{
		ID:        id,
		Username:  u.Username,
		Value:     req.Value,
		Status:    ChallengeActive,
		CreatedAt: now,
		ExpiresAt: now.Add(challengeLifetime),
	}
	if err := s.store.CreateChallenge(ch, maxActiveChallenges, maxChallengesPerHour, now.Add(-time.Hour)); err != nil {
		switch {
		case errors.Is(err, ErrChallengeLimit):
			writeAPIError(w, http.StatusTooManyRequests, "challenge_limit", "too many active challenges; delete one or wait for it to expire")
		case errors.Is(err, ErrChallengeRateCap):
			writeAPIError(w, http.StatusTooManyRequests, "challenge_rate_limited", "challenge creation rate exceeded; retry in a few minutes")
		default:
			writeAPIError(w, http.StatusInternalServerError, "internal", "could not store challenge")
		}
		return
	}
	recordID, err := s.cfClient().createTXTRecord(r.Context(), s.challengeName(u.Username), req.Value)
	if err != nil {
		// Roll the stored challenge to expired so it neither counts
		// against the active cap nor leaves phantom state; the rate
		// counter keeping it is deliberate (failed creates still cost
		// provider calls).
		_ = s.store.UpdateChallenge(id, func(x *DNSChallenge) { x.Status = ChallengeExpired })
		log.Printf("cert challenge %s for %q: cloudflare create: %v", id, u.Username, err)
		writeAPIError(w, http.StatusBadGateway, "dns_provider_error", "the DNS provider could not publish the challenge record")
		return
	}
	_ = s.store.UpdateChallenge(id, func(x *DNSChallenge) { x.CFRecordID = recordID })
	ch.CFRecordID = recordID
	writeJSON(w, http.StatusCreated, s.challengeViewOf(ch))
}

// handleGetChallenge is GET /api/v1/certificates/dns-challenges/{id}
// (Bearer). For an active challenge it performs a live propagation
// check: once the TXT value is publicly resolvable the status flips
// to "propagated" and the client may ask the ACME server to validate.
// An active challenge past its lifetime is retired on the spot.
func (s *Server) handleGetChallenge(w http.ResponseWriter, r *http.Request) {
	if !s.requireCertSetup(w) {
		return
	}
	u, ok := s.bearerUser(w, r)
	if !ok {
		return
	}
	ch, ok := s.ownedChallenge(w, r, u)
	if !ok {
		return
	}
	if ch.Status == ChallengeActive {
		now := time.Now().UTC()
		switch {
		case now.After(ch.ExpiresAt):
			s.retireChallenge(ch, ChallengeExpired)
			ch.Status = ChallengeExpired
		case ch.PropagatedAt.IsZero():
			ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
			values, err := s.lookupTXT(ctx, s.challengeName(ch.Username))
			cancel()
			if err == nil {
				for _, v := range values {
					if v == ch.Value {
						_ = s.store.UpdateChallenge(ch.ID, func(x *DNSChallenge) {
							x.PropagatedAt = time.Now().UTC()
						})
						ch.PropagatedAt = time.Now().UTC()
						break
					}
				}
			}
			// Lookup errors are not request errors: the answer is
			// simply "not propagated yet".
		}
	}
	writeJSON(w, http.StatusOK, s.challengeViewOf(ch))
}

// handleDeleteChallenge is DELETE /api/v1/certificates/dns-challenges/{id}
// (Bearer). Removes the TXT record and marks the challenge cleaned.
// Idempotent: deleting an already-cleaned or expired challenge is a
// 200 reporting that state.
func (s *Server) handleDeleteChallenge(w http.ResponseWriter, r *http.Request) {
	if !s.requireCertSetup(w) {
		return
	}
	u, ok := s.bearerUser(w, r)
	if !ok {
		return
	}
	ch, ok := s.ownedChallenge(w, r, u)
	if !ok {
		return
	}
	if ch.Status == ChallengeActive {
		if ch.CFRecordID != "" {
			if err := s.cfClient().deleteRecord(r.Context(), ch.CFRecordID); err != nil {
				log.Printf("cert challenge %s: cloudflare delete: %v", ch.ID, err)
				writeAPIError(w, http.StatusBadGateway, "dns_provider_error", "the DNS provider could not remove the challenge record; retry")
				return
			}
		}
		_ = s.store.UpdateChallenge(ch.ID, func(x *DNSChallenge) { x.Status = ChallengeCleaned })
		ch.Status = ChallengeCleaned
	}
	writeJSON(w, http.StatusOK, s.challengeViewOf(ch))
}

// sweepExpiredChallenges periodically retires challenges past their
// lifetime so TXT records never accumulate even when clients forget
// to DELETE. Runs for the life of the process; started from main()
// only when certificate DNS is configured.
func (s *Server) sweepExpiredChallenges(ctx context.Context) {
	ticker := time.NewTicker(challengeSweepEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, ch := range s.store.ListActiveChallenges() {
				if now.After(ch.ExpiresAt) {
					s.retireChallenge(ch, ChallengeExpired)
				}
			}
		}
	}
}
