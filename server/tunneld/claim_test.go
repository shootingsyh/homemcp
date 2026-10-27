package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// The recoverable-claim protocol, end to end. History: credential
// issuance used to happen on the first GET of the enrollment — the
// very URL Stripe's success_url returned the browser to — so a
// browser return/refresh consumed the one-time claim before the
// client app could save the credentials ("credentials were issued
// but never stored"). These tests pin the replacement protocol:
// reads are pure, claiming is an explicit POST, and a claim stays
// recoverable (rotation on re-claim) until the client acks that it
// persisted the credentials.

// paidEnrollment drives a real (Stripe-fake) enrollment to the ready
// state and returns its ID.
func paidEnrollment(t *testing.T, s *Server, ts *httptest.Server, username, plan string) string {
	t.Helper()
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": username, "plan": plan,
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("create enrollment: HTTP %d: %v", status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)
	event := map[string]any{
		"id": "evt_claim_" + enrollmentID, "type": "checkout.session.completed",
		"data": map[string]any{"object": map[string]any{
			"id": "cs_test_claim", "client_reference_id": enrollmentID,
			"customer": "cus_claim", "subscription": "sub_claim",
			"payment_status": "paid",
		}},
	}
	rawEvent, _ := json.Marshal(event)
	req, _ := http.NewRequest("POST", ts.URL+"/webhooks/stripe", bytes.NewReader(rawEvent))
	req.Header.Set("Stripe-Signature", stripeSign(rawEvent, "whsec_test_fake", time.Now().UTC()))
	wresp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	wresp.Body.Close()
	if wresp.StatusCode != 200 {
		t.Fatalf("webhook HTTP %d", wresp.StatusCode)
	}
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/enrollments/"+enrollmentID, nil, nil)
	if status != 200 || resp["status"] != EnrollmentReady {
		t.Fatalf("enrollment not ready after webhook: %d %v", status, resp)
	}
	return enrollmentID
}

// TestBrowserReturnAndRefreshDoNotConsumeClaim is the regression test
// for the original bug: the browser coming back from Stripe (and
// refreshing, and prefetchers following the link) must leave the
// enrollment claimable by the client app.
func TestBrowserReturnAndRefreshDoNotConsumeClaim(t *testing.T) {
	s, _, _ := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	eid := paidEnrollment(t, s, ts, "carol", "monthly")

	for i := 0; i < 3; i++ {
		code, page := doRaw(t, "GET", ts.URL+"/checkout/complete?enrollment="+eid+"&checkout=success", nil)
		if code != 200 || !strings.Contains(page, "Payment received") {
			t.Fatalf("return page hit %d: HTTP %d %q", i, code, page)
		}
		status, resp := doJSON(t, "GET", ts.URL+"/api/v1/enrollments/"+eid, nil, nil)
		if status != 200 || resp["status"] != EnrollmentReady || resp["credentials_issued"] != false || resp["credentials"] != nil {
			t.Fatalf("read %d changed claim state: %d %v", i, status, resp)
		}
	}
	// The cancelled-return variant renders too.
	code, page := doRaw(t, "GET", ts.URL+"/checkout/complete?enrollment="+eid+"&checkout=cancelled", nil)
	if code != 200 || !strings.Contains(page, "Checkout cancelled") {
		t.Fatalf("cancel page: HTTP %d %q", code, page)
	}

	// After all that browser noise the app can still claim — once.
	token := claimViaAPI(t, ts, eid)
	ackViaAPI(t, ts, eid, token)
}

// TestClaimRetryRotatesUntilAck covers the client-crash / save-failure
// path: claim, never ack, claim again. The second claim must succeed
// with FRESH credentials, the unsaved token must be dead, acking the
// stale token must fail, and acking the current one must finalize.
func TestClaimRetryRotatesUntilAck(t *testing.T) {
	s, _, _ := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	eid := paidEnrollment(t, s, ts, "dave", "monthly")

	token1 := claimViaAPI(t, ts, eid)
	token2 := claimViaAPI(t, ts, eid) // client "crashed" before ack
	if token2 == token1 {
		t.Fatal("re-claim before ack did not rotate")
	}
	// The unsaved token is dead; the fresh one is live.
	if status, _ := doJSON(t, "GET", ts.URL+"/api/v1/account", nil, bearer(token1)); status != http.StatusUnauthorized {
		t.Fatalf("stale token account: HTTP %d, want 401", status)
	}
	if status, _ := doJSON(t, "GET", ts.URL+"/api/v1/account", nil, bearer(token2)); status != 200 {
		t.Fatalf("current token account: HTTP %d, want 200", status)
	}
	if resp := s.pluginLogin(loginContentJSON("dave", token1)); !resp.Reject {
		t.Fatal("plugin accepted the rotated-out token")
	}
	// Acking the stale token fails; acking the current one lands and
	// is idempotent; afterwards the claim is final.
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments/"+eid+"/claim/ack",
		map[string]string{"token": token1}, nil)
	if status != http.StatusConflict || resp["error"].(map[string]any)["code"] != "stale_claim" {
		t.Fatalf("ack stale token: %d %v, want 409 stale_claim", status, resp)
	}
	ackViaAPI(t, ts, eid, token2)
	ackViaAPI(t, ts, eid, token2) // idempotent
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments/"+eid+"/claim", nil, nil)
	if status != http.StatusConflict || resp["error"].(map[string]any)["code"] != "already_claimed" {
		t.Fatalf("claim after ack: %d %v, want 409 already_claimed", status, resp)
	}
}

// TestConcurrentClaimsConverge fires parallel claims at one ready
// enrollment: every claim returns a token, but exactly one token is
// live at the end, and acking THAT one finalizes the claim.
func TestConcurrentClaimsConverge(t *testing.T) {
	s, _, _ := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	eid := paidEnrollment(t, s, ts, "erin", "annual")

	const n = 8
	tokens := make([]string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := http.Post(ts.URL+"/api/v1/enrollments/"+eid+"/claim", "application/json", nil)
			if err != nil {
				tokens[i] = fmt.Sprintf("error: %v", err)
				return
			}
			defer resp.Body.Close()
			var body map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != 200 {
				tokens[i] = fmt.Sprintf("bad response: %d %v", resp.StatusCode, err)
				return
			}
			creds, _ := body["credentials"].(map[string]any)
			tok, _ := creds["token"].(string)
			tokens[i] = tok
		}(i)
	}
	wg.Wait()

	seen := map[string]bool{}
	live := ""
	liveCount := 0
	for _, tok := range tokens {
		if tok == "" || strings.HasPrefix(tok, "error") || strings.HasPrefix(tok, "bad response") {
			t.Fatalf("a concurrent claim failed: %q (all: %v)", tok, tokens)
		}
		if seen[tok] {
			t.Fatalf("two claims returned the same token: %v", tokens)
		}
		seen[tok] = true
		if status, _ := doJSON(t, "GET", ts.URL+"/api/v1/account", nil, bearer(tok)); status == 200 {
			live, liveCount = tok, liveCount+1
		}
	}
	if liveCount != 1 {
		t.Fatalf("live tokens after concurrent claims = %d, want exactly 1", liveCount)
	}
	ackViaAPI(t, ts, eid, live)
	if status, _ := doJSON(t, "POST", ts.URL+"/api/v1/enrollments/"+eid+"/claim", nil, nil); status != http.StatusConflict {
		t.Fatalf("claim after convergence+ack: HTTP %d, want 409", status)
	}
}

// TestClaimGuards pins the refusal edges: too-early claims, ack
// before claim, unknown enrollments, and a missing token in the ack.
func TestClaimGuards(t *testing.T) {
	s, _, _ := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	// Unknown enrollment: claim and ack both 404.
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments/enr_nope/claim", nil, nil)
	if status != http.StatusNotFound || resp["error"].(map[string]any)["code"] != "enrollment_not_found" {
		t.Fatalf("claim unknown: %d %v", status, resp)
	}
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments/enr_nope/claim/ack",
		map[string]string{"token": "whatever"}, nil)
	if status != http.StatusNotFound {
		t.Fatalf("ack unknown: %d %v", status, resp)
	}

	// Pending enrollment: claim is 409 credentials_not_ready, ack is
	// 409 not_claimed.
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "frank", "plan": "monthly",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("create enrollment: HTTP %d: %v", status, resp)
	}
	eid, _ := resp["enrollment_id"].(string)
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments/"+eid+"/claim", nil, nil)
	if status != http.StatusConflict || resp["error"].(map[string]any)["code"] != "credentials_not_ready" {
		t.Fatalf("claim pending: %d %v, want 409 credentials_not_ready", status, resp)
	}
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments/"+eid+"/claim/ack",
		map[string]string{"token": "whatever"}, nil)
	if status != http.StatusConflict || resp["error"].(map[string]any)["code"] != "not_claimed" {
		t.Fatalf("ack unclaimed: %d %v, want 409 not_claimed", status, resp)
	}

	// Ack without a token is a plain bad request.
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments/"+eid+"/claim/ack",
		map[string]string{}, nil)
	if status != http.StatusBadRequest || resp["error"].(map[string]any)["code"] != "bad_request" {
		t.Fatalf("ack without token: %d %v, want 400 bad_request", status, resp)
	}
}
