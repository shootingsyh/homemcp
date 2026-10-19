package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- fake Cloudflare ----------

// fakeCloudflare is an in-memory stand-in for the Cloudflare v4 DNS
// API: it records created TXT records and honors deletes, using the
// real response envelope so the client code path is exercised fully.
type fakeCloudflare struct {
	mu      sync.Mutex
	records map[string]fakeCFRecord // record ID -> record
	nextID  int
	creates int
	deletes int
}

type fakeCFRecord struct {
	Name    string
	Content string
}

func newFakeCloudflare(t *testing.T) (*fakeCloudflare, *httptest.Server) {
	t.Helper()
	f := &fakeCloudflare{records: map[string]fakeCFRecord{}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /zones/zone123/dns_records", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer cf-test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `{"success":false,"errors":[{"code":9109,"message":"bad token"}]}`)
			return
		}
		var body struct {
			Type    string `json:"type"`
			Name    string `json:"name"`
			Content string `json:"content"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.nextID++
		id := fmt.Sprintf("rec-%d", f.nextID)
		f.records[id] = fakeCFRecord{Name: body.Name, Content: body.Content}
		f.creates++
		f.mu.Unlock()
		fmt.Fprintf(w, `{"success":true,"result":{"id":%q}}`, id)
	})
	mux.HandleFunc("DELETE /zones/zone123/dns_records/{id}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		_, ok := f.records[r.PathValue("id")]
		if ok {
			delete(f.records, r.PathValue("id"))
			f.deletes++
		}
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			fmt.Fprint(w, `{"success":false,"errors":[{"code":81044,"message":"record does not exist"}]}`)
			return
		}
		fmt.Fprint(w, `{"success":true,"result":{}}`)
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return f, ts
}

// txtFor returns the TXT contents the fake currently holds for a name
// (used as the propagation resolver's view of the world).
func (f *fakeCloudflare) txtFor(name string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, rec := range f.records {
		if rec.Name == name {
			out = append(out, rec.Content)
		}
	}
	return out
}

func (f *fakeCloudflare) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.records)
}

// certTestServer builds a Server with certificate DNS configured
// against the fake Cloudflare, and a TXT resolver that reads the
// fake's records (i.e. propagation is instant once a record exists —
// unless a test overrides txtLookup to simulate lag).
func certTestServer(t *testing.T) (*Server, *fakeCloudflare) {
	t.Helper()
	fake, fts := newFakeCloudflare(t)
	cfg := testConfig(t)
	cfg.CloudflareAPIToken = "cf-test-token"
	cfg.CloudflareZoneID = "zone123"
	cfg.CloudflareAPIBase = fts.URL
	s := testServer(t, cfg)
	s.cf = newCloudflareClient(cfg)
	s.txtLookup = func(ctx context.Context, name string) ([]string, error) {
		return fake.txtFor(name), nil
	}
	return s, fake
}

func challengeValue(n int) string {
	// 43 chars of base64url alphabet, unique per n.
	return strings.Repeat("a", 42) + string(rune('a'+n%26))
}

func bearer(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

func createChallenge(t *testing.T, ts *httptest.Server, token, value string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, http.MethodPost, ts.URL+"/api/v1/certificates/dns-challenges",
		map[string]any{"value": value}, bearer(token))
}

// ---------- tests ----------

func TestCertNotConfigured(t *testing.T) {
	s := testServer(t, testConfig(t)) // no Cloudflare fields set
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-token", SubStatusActive, time.Time{})

	status, body := createChallenge(t, ts, "alice-token", challengeValue(1))
	if status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "cert_dns_not_configured" {
		t.Fatalf("code = %v, want cert_dns_not_configured", code)
	}
}

func TestCertCreateAuthAndValidation(t *testing.T) {
	s, _ := certTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-token", SubStatusActive, time.Time{})

	// No bearer at all.
	status, _ := doJSON(t, http.MethodPost, ts.URL+"/api/v1/certificates/dns-challenges",
		map[string]any{"value": challengeValue(1)}, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("no-token status = %d, want 401", status)
	}
	// Wrong token.
	status, _ = createChallenge(t, ts, "not-a-token", challengeValue(1))
	if status != http.StatusUnauthorized {
		t.Fatalf("bad-token status = %d, want 401", status)
	}
	// Malformed TXT value (too short / bad chars).
	for _, bad := range []string{"short", strings.Repeat("a", 44), strings.Repeat("a", 42) + "!", ""} {
		status, body := createChallenge(t, ts, "alice-token", bad)
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("value %q: status = %d, want 422; body %v", bad, status, body)
		}
		if code := body["error"].(map[string]any)["code"]; code != "invalid_txt_value" {
			t.Fatalf("value %q: code = %v, want invalid_txt_value", bad, code)
		}
	}
}

func TestCertLifecycle(t *testing.T) {
	s, fake := certTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-token", SubStatusActive, time.Time{})

	// Create.
	status, body := createChallenge(t, ts, "alice-token", challengeValue(1))
	if status != http.StatusCreated {
		t.Fatalf("create status = %d, want 201; body %v", status, body)
	}
	id, _ := body["id"].(string)
	if id == "" {
		t.Fatalf("create response missing id: %v", body)
	}
	if want := "_acme-challenge.alice.tunnel.homemcp.si"; body["name"] != want {
		t.Fatalf("name = %v, want %v (derived from the authenticated user)", body["name"], want)
	}
	if body["status"] != "pending" {
		t.Fatalf("initial status = %v, want pending", body["status"])
	}
	if got := fake.txtFor("_acme-challenge.alice.tunnel.homemcp.si"); len(got) != 1 || got[0] != challengeValue(1) {
		t.Fatalf("cloudflare records = %v, want exactly the challenge value", got)
	}

	// Poll: the fake resolver sees the record, so it flips to propagated.
	status, body = doJSON(t, http.MethodGet, ts.URL+"/api/v1/certificates/dns-challenges/"+id, nil, bearer("alice-token"))
	if status != http.StatusOK || body["status"] != "propagated" {
		t.Fatalf("poll = %d %v, want 200 propagated", status, body)
	}

	// Delete: record removed at the provider, challenge cleaned.
	status, body = doJSON(t, http.MethodDelete, ts.URL+"/api/v1/certificates/dns-challenges/"+id, nil, bearer("alice-token"))
	if status != http.StatusOK || body["status"] != "cleaned" {
		t.Fatalf("delete = %d %v, want 200 cleaned", status, body)
	}
	if fake.count() != 0 {
		t.Fatalf("cloudflare still holds %d records after delete", fake.count())
	}

	// Delete again: idempotent 200, still cleaned.
	status, body = doJSON(t, http.MethodDelete, ts.URL+"/api/v1/certificates/dns-challenges/"+id, nil, bearer("alice-token"))
	if status != http.StatusOK || body["status"] != "cleaned" {
		t.Fatalf("second delete = %d %v, want 200 cleaned", status, body)
	}
}

func TestCertOwnershipIsolation(t *testing.T) {
	s, fake := certTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-token", SubStatusActive, time.Time{})
	addUser(t, s, "bob", "bob-token", SubStatusActive, time.Time{})

	_, body := createChallenge(t, ts, "alice-token", challengeValue(2))
	id := body["id"].(string)

	// Bob can neither see nor delete Alice's challenge: both are the
	// same 404 as a nonexistent ID.
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		status, body := doJSON(t, method, ts.URL+"/api/v1/certificates/dns-challenges/"+id, nil, bearer("bob-token"))
		if status != http.StatusNotFound {
			t.Fatalf("bob %s alice's challenge: status = %d, want 404; body %v", method, status, body)
		}
		if code := body["error"].(map[string]any)["code"]; code != "challenge_not_found" {
			t.Fatalf("bob %s: code = %v, want challenge_not_found", method, code)
		}
	}
	if fake.count() != 1 {
		t.Fatalf("bob's delete attempts removed a record; %d remain, want 1", fake.count())
	}

	// Bob's own create lands under Bob's name only — there is no API
	// field to aim a challenge at someone else's subdomain.
	_, body = createChallenge(t, ts, "bob-token", challengeValue(3))
	if want := "_acme-challenge.bob.tunnel.homemcp.si"; body["name"] != want {
		t.Fatalf("bob's challenge name = %v, want %v", body["name"], want)
	}
}

func TestCertSubscriptionGate(t *testing.T) {
	s, _ := certTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "carol", "carol-token", SubStatusCanceled, time.Time{})

	status, body := createChallenge(t, ts, "carol-token", challengeValue(4))
	if status != http.StatusForbidden {
		t.Fatalf("canceled user create: status = %d, want 403; body %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "subscription_inactive" {
		t.Fatalf("code = %v, want subscription_inactive", code)
	}
}

func TestCertActiveCapAndRateLimit(t *testing.T) {
	s, _ := certTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-token", SubStatusActive, time.Time{})

	// Active cap: 4 live challenges, the 5th is refused.
	ids := make([]string, 0, maxActiveChallenges)
	for i := 0; i < maxActiveChallenges; i++ {
		status, body := createChallenge(t, ts, "alice-token", challengeValue(i))
		if status != http.StatusCreated {
			t.Fatalf("create %d: status = %d, want 201; body %v", i, status, body)
		}
		ids = append(ids, body["id"].(string))
	}
	status, body := createChallenge(t, ts, "alice-token", challengeValue(9))
	if status != http.StatusTooManyRequests {
		t.Fatalf("5th active create: status = %d, want 429; body %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "challenge_limit" {
		t.Fatalf("code = %v, want challenge_limit", code)
	}

	// Clean them all up, then burn through the hourly creation cap:
	// 4 already created this hour, 6 more create+delete cycles reach
	// 10; the 11th creation inside the hour is rate-limited.
	for _, id := range ids {
		doJSON(t, http.MethodDelete, ts.URL+"/api/v1/certificates/dns-challenges/"+id, nil, bearer("alice-token"))
	}
	for i := 0; i < maxChallengesPerHour-maxActiveChallenges; i++ {
		status, body := createChallenge(t, ts, "alice-token", challengeValue(10+i))
		if status != http.StatusCreated {
			t.Fatalf("cycle create %d: status = %d, want 201; body %v", i, status, body)
		}
		doJSON(t, http.MethodDelete, ts.URL+"/api/v1/certificates/dns-challenges/"+body["id"].(string), nil, bearer("alice-token"))
	}
	status, body = createChallenge(t, ts, "alice-token", challengeValue(30))
	if status != http.StatusTooManyRequests {
		t.Fatalf("11th hourly create: status = %d, want 429; body %v", status, body)
	}
	if code := body["error"].(map[string]any)["code"]; code != "challenge_rate_limited" {
		t.Fatalf("code = %v, want challenge_rate_limited", code)
	}
}

func TestCertExpiryRetiresRecord(t *testing.T) {
	s, fake := certTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-token", SubStatusActive, time.Time{})

	_, body := createChallenge(t, ts, "alice-token", challengeValue(5))
	id := body["id"].(string)
	if fake.count() != 1 {
		t.Fatalf("setup: fake holds %d records, want 1", fake.count())
	}
	// Force the challenge past its lifetime, then poll it: the GET
	// retires it and removes the provider record.
	if err := s.store.UpdateChallenge(id, func(ch *DNSChallenge) {
		ch.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	}); err != nil {
		t.Fatalf("UpdateChallenge: %v", err)
	}
	status, body := doJSON(t, http.MethodGet, ts.URL+"/api/v1/certificates/dns-challenges/"+id, nil, bearer("alice-token"))
	if status != http.StatusOK || body["status"] != "expired" {
		t.Fatalf("poll expired = %d %v, want 200 expired", status, body)
	}
	if fake.count() != 0 {
		t.Fatalf("expired challenge left %d provider records behind", fake.count())
	}
}
