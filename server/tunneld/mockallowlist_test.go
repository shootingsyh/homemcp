package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---------- mock allowlist (per-username, server-side) ----------
//
// The allowlist is the production-safe mock: it works with global mock
// mode OFF and Stripe completely UNCONFIGURED. Only the named
// usernames skip payment; everyone else gets the normal gates.

// prodLikeServer: no global mock, no Stripe — like the production
// instance before Stripe activation.
func prodLikeServer(t *testing.T) *Server {
	t.Helper()
	return testServer(t, testConfig(t))
}

var adminHdr = map[string]string{"X-Admin-Key": "test-admin-key"}

func TestMockAllowlistAdminCRUD(t *testing.T) {
	s := prodLikeServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	listURL := ts.URL + "/api/v1/admin/mock-users"

	// Admin gate: no key / wrong key -> 401.
	if status, _ := doJSON(t, "GET", listURL, nil, nil); status != http.StatusUnauthorized {
		t.Errorf("list without key: HTTP %d, want 401", status)
	}
	if status, _ := doJSON(t, "PUT", listURL+"/yiliu", map[string]string{"note": "x"},
		map[string]string{"X-Admin-Key": "wrong"}); status != http.StatusUnauthorized {
		t.Errorf("add with wrong key: HTTP %d, want 401", status)
	}

	// Empty at first.
	status, resp := doJSON(t, "GET", listURL, nil, adminHdr)
	if status != 200 {
		t.Fatalf("list: HTTP %d: %v", status, resp)
	}
	if arr, _ := resp["mock_users"].([]any); len(arr) != 0 {
		t.Fatalf("allowlist should start empty: %v", resp)
	}

	// Add yiliu with a note.
	status, resp = doJSON(t, "PUT", listURL+"/yiliu", map[string]string{"note": "friend tester"}, adminHdr)
	if status != 200 || resp["username"] != "yiliu" || resp["subdomain"] != "yiliu.tunnel.homemcp.si" || resp["note"] != "friend tester" {
		t.Fatalf("add yiliu: %d %v", status, resp)
	}
	if resp["added_at"] == nil || resp["added_at"] == "" {
		t.Errorf("add response missing added_at: %v", resp)
	}
	firstAddedAt := resp["added_at"]

	// Re-add refreshes the note, keeps added_at, no duplicate.
	status, resp = doJSON(t, "PUT", listURL+"/yiliu", map[string]string{"note": "updated"}, adminHdr)
	if status != 200 || resp["note"] != "updated" || resp["added_at"] != firstAddedAt {
		t.Fatalf("re-add: %d %v", status, resp)
	}
	status, resp = doJSON(t, "GET", listURL, nil, adminHdr)
	if arr, _ := resp["mock_users"].([]any); status != 200 || len(arr) != 1 {
		t.Fatalf("list after re-add: %d %v", status, resp)
	}

	// Invalid / reserved usernames are refused.
	if status, _ := doJSON(t, "PUT", listURL+"/bad_name", nil, adminHdr); status != http.StatusUnprocessableEntity {
		t.Errorf("add invalid username: HTTP %d, want 422", status)
	}
	if status, _ := doJSON(t, "PUT", listURL+"/admin", nil, adminHdr); status != http.StatusUnprocessableEntity {
		t.Errorf("add reserved username: HTTP %d, want 422", status)
	}

	// Remove; second remove -> 404.
	if status, _ := doJSON(t, "DELETE", listURL+"/yiliu", nil, adminHdr); status != 200 {
		t.Errorf("remove: HTTP %d, want 200", status)
	}
	if s.store.IsMockUser("yiliu") {
		t.Error("yiliu still on allowlist after DELETE")
	}
	if status, _ := doJSON(t, "DELETE", listURL+"/yiliu", nil, adminHdr); status != http.StatusNotFound {
		t.Errorf("remove again: HTTP %d, want 404", status)
	}
}

func TestMockAllowlistEnrollmentAnnual(t *testing.T) {
	s := prodLikeServer(t) // MockPay OFF, Stripe unconfigured
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	if status, _ := doJSON(t, "PUT", ts.URL+"/api/v1/admin/mock-users/yiliu",
		map[string]string{"note": "friend tester"}, adminHdr); status != 200 {
		t.Fatalf("allowlist add: HTTP %d", status)
	}

	// A non-listed user still hits the stripe_not_configured gate.
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "mallory", "plan": "annual",
	}, nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("non-listed enroll: HTTP %d, want 503: %v", status, resp)
	}

	// The listed user enrolls: payment is skipped server-side, the
	// enrollment is already "ready", and there is no checkout URL.
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "yiliu", "plan": "annual",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("listed enroll: HTTP %d: %v", status, resp)
	}
	if resp["checkout_url"] != "" {
		t.Errorf("checkout_url = %v, want empty for allowlisted enrollment", resp["checkout_url"])
	}
	if resp["status"] != EnrollmentReady {
		t.Errorf("status = %v, want ready (activated at enrollment time)", resp["status"])
	}
	enrollmentID, _ := resp["enrollment_id"].(string)

	// Account state mirrors the real annual plan: trialing, ~7 days,
	// flagged mock, no Stripe linkage.
	u, ok := s.store.GetUser("yiliu")
	if !ok {
		t.Fatal("allowlisted user not created")
	}
	if !u.Mock {
		t.Error("user not flagged Mock")
	}
	if u.SubStatus != SubStatusTrialing {
		t.Errorf("sub_status = %q, want trialing", u.SubStatus)
	}
	if until := time.Until(u.TrialEnd); until < 6*24*time.Hour || until > 8*24*time.Hour {
		t.Errorf("trial_end %v from now, want ~7 days", until)
	}
	if u.StripeCustomerID != "" || u.StripeSubscriptionID != "" {
		t.Errorf("mock user unexpectedly has Stripe IDs: %+v", u)
	}

	// Claim works (explicit POST + ack) and the plugin lets the
	// user in.
	token := claimViaAPI(t, ts, enrollmentID)
	ackViaAPI(t, ts, enrollmentID, token)
	if loginResp := s.pluginLogin(loginContentJSON("yiliu", token)); loginResp.Reject {
		t.Errorf("plugin login rejected for allowlisted user: %q", loginResp.RejectReason)
	}

	// Account view carries the mock flag.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/account", nil, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if status != 200 || resp["mock"] != true || resp["sub_status"] != SubStatusTrialing {
		t.Fatalf("account view: %d %v", status, resp)
	}

	// Admin user list flags the account as mock too.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/admin/users", nil, adminHdr)
	if status != 200 {
		t.Fatalf("admin users: HTTP %d", status)
	}
	users, _ := resp["users"].([]any)
	if len(users) != 1 {
		t.Fatalf("admin users len = %v", resp)
	}
	if first, _ := users[0].(map[string]any); first["mock"] != true {
		t.Errorf("admin user view missing mock flag: %v", first)
	}
}

func TestMockAllowlistMonthlyAndRemoval(t *testing.T) {
	s := prodLikeServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	// Monthly: active immediately, no trial.
	if status, _ := doJSON(t, "PUT", ts.URL+"/api/v1/admin/mock-users/zoe", nil, adminHdr); status != 200 {
		t.Fatalf("allowlist add zoe: HTTP %d", status)
	}
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "zoe", "plan": "monthly",
	}, nil)
	if status != http.StatusCreated || resp["status"] != EnrollmentReady {
		t.Fatalf("zoe enroll: %d %v", status, resp)
	}
	u, ok := s.store.GetUser("zoe")
	if !ok || u.SubStatus != SubStatusActive || !u.TrialEnd.IsZero() || !u.Mock {
		t.Errorf("zoe after monthly mock activation: %+v ok=%v", u, ok)
	}

	// Removal restores the normal gate for names that have NOT
	// enrolled yet.
	if status, _ := doJSON(t, "PUT", ts.URL+"/api/v1/admin/mock-users/kim", nil, adminHdr); status != 200 {
		t.Fatalf("allowlist add kim: HTTP %d", status)
	}
	if status, _ := doJSON(t, "DELETE", ts.URL+"/api/v1/admin/mock-users/kim", nil, adminHdr); status != 200 {
		t.Fatalf("allowlist remove kim: HTTP %d", status)
	}
	status, _ = doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "kim", "plan": "monthly",
	}, nil)
	if status != http.StatusServiceUnavailable {
		t.Errorf("kim enroll after removal: HTTP %d, want 503 (normal gate)", status)
	}
}

func TestMockAllowlistSubscriptionEventWithoutGlobalMock(t *testing.T) {
	s := prodLikeServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	// Allowlisted user activates as trialing.
	if status, _ := doJSON(t, "PUT", ts.URL+"/api/v1/admin/mock-users/yiliu", nil, adminHdr); status != 200 {
		t.Fatalf("allowlist add: HTTP %d", status)
	}
	if status, _ := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "yiliu", "plan": "annual",
	}, nil); status != http.StatusCreated {
		t.Fatalf("enroll: HTTP %d", status)
	}
	eventURL := ts.URL + "/api/v1/mock/users/yiliu/subscription-event"

	// Lifecycle hook works for the mock account even with global
	// mock mode OFF: payment_failed -> past_due + ~3d grace.
	status, resp := doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.payment_failed"}, adminHdr)
	if status != 200 || resp["sub_status"] != SubStatusPastDue || resp["grace_until"] == nil {
		t.Fatalf("payment_failed on mock account: %d %v", status, resp)
	}
	// trial.end / invoice.paid / deleted transitions too.
	status, resp = doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.paid"}, adminHdr)
	if status != 200 || resp["sub_status"] != SubStatusActive {
		t.Fatalf("invoice.paid on mock account: %d %v", status, resp)
	}

	// A REAL (non-mock) account is not reachable through the hook
	// when global mock mode is off: same 404 as an unknown user.
	addUser(t, s, "paying-pete", "tok-pete", SubStatusActive, time.Time{})
	status, _ = doJSON(t, "POST", ts.URL+"/api/v1/mock/users/paying-pete/subscription-event",
		map[string]string{"event": "subscription.deleted"}, adminHdr)
	if status != http.StatusNotFound {
		t.Errorf("event on real account (mock off): HTTP %d, want 404", status)
	}
	if u, _ := s.store.GetUser("paying-pete"); u.SubStatus != SubStatusActive {
		t.Errorf("real account mutated by mock hook: %+v", u)
	}
}
