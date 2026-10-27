package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---------- mock pay helpers ----------

func mockTestServer(t *testing.T) *Server {
	t.Helper()
	cfg := testConfig(t)
	cfg.MockPay = true
	// Deliberately NO Stripe keys: mock mode must work without any
	// Stripe configuration at all.
	return testServer(t, cfg)
}

func doRaw(t *testing.T, method, url string, headers map[string]string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

// mockEnrollAndPay runs enroll -> POST mock-pay for a fresh user and
// returns (enrollmentID, claimToken).
func mockEnrollAndPay(t *testing.T, ts *httptest.Server, username, plan string) (string, string) {
	t.Helper()
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": username, "plan": plan,
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("mock enroll %s: HTTP %d: %v", username, status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)
	checkoutURL, _ := resp["checkout_url"].(string)
	if checkoutURL != "https://api.homemcp.si/mock-pay/"+enrollmentID {
		t.Fatalf("checkout_url = %q, want mock-pay URL", checkoutURL)
	}
	if code, _ := doRaw(t, "POST", ts.URL+"/mock-pay/"+enrollmentID, nil); code != 200 {
		t.Fatalf("mock pay POST: HTTP %d", code)
	}
	token := claimViaAPI(t, ts, enrollmentID)
	ackViaAPI(t, ts, enrollmentID, token)
	return enrollmentID, token
}

// ---------- mock enrollment ----------

func TestMockEnrollmentSkipsStripe(t *testing.T) {
	s := mockTestServer(t) // MockPay on, Stripe completely unconfigured
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "alice", "plan": "annual",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("mock enrollment: HTTP %d: %v (must not 503 without Stripe)", status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)
	if enrollmentID == "" {
		t.Fatalf("missing enrollment_id: %v", resp)
	}
	want := "https://api.homemcp.si/mock-pay/" + enrollmentID
	if resp["checkout_url"] != want {
		t.Errorf("checkout_url = %v, want %v", resp["checkout_url"], want)
	}
	if resp["status"] != EnrollmentPendingPayment {
		t.Errorf("status = %v, want pending_payment", resp["status"])
	}
	// Nothing was activated yet: claim must not leak credentials.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/enrollments/"+enrollmentID, nil, nil)
	if status != 200 || resp["status"] != EnrollmentPendingPayment || resp["credentials"] != nil {
		t.Fatalf("pre-pay enrollment view wrong: %d %v", status, resp)
	}
}

// ---------- full mock flow, annual (trial) ----------

func TestMockPayFlowAnnualTrial(t *testing.T) {
	s := mockTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "alice", "plan": "annual",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("enroll: HTTP %d: %v", status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)

	// Checkout page renders, branded and with the annual wording.
	code, body := doRaw(t, "GET", ts.URL+"/mock-pay/"+enrollmentID, nil)
	if code != 200 {
		t.Fatalf("mock pay page HTTP %d", code)
	}
	for _, want := range []string{"MOCK PAY", "NO REAL CHARGE", "$9.99", "7-day free trial", "card on file (mock)", "Pay (mock)", "alice.tunnel.homemcp.si"} {
		if !strings.Contains(body, want) {
			t.Errorf("mock pay page missing %q", want)
		}
	}

	// Pay (mock) -> activated as trialing.
	code, body = doRaw(t, "POST", ts.URL+"/mock-pay/"+enrollmentID, nil)
	if code != 200 || !strings.Contains(body, "Mock payment complete") {
		t.Fatalf("mock pay POST: HTTP %d, body missing completion:\n%s", code, body)
	}
	u, ok := s.store.GetUser("alice")
	if !ok {
		t.Fatal("user not created by mock activation")
	}
	if u.SubStatus != SubStatusTrialing {
		t.Errorf("sub_status = %q, want trialing", u.SubStatus)
	}
	if u.TrialEnd.IsZero() {
		t.Fatal("trial_end not recorded for annual mock activation")
	}
	if until := time.Until(u.TrialEnd); until < 6*24*time.Hour || until > 8*24*time.Hour {
		t.Errorf("trial_end is %v from now, want ~7 days", until)
	}
	if !u.CurrentPeriodEnd.Equal(u.TrialEnd) {
		t.Errorf("current_period_end %v should equal trial end %v during trial", u.CurrentPeriodEnd, u.TrialEnd)
	}
	// Mock users carry no Stripe linkage (portal/account flows rely on it).
	if u.StripeCustomerID != "" || u.StripeSubscriptionID != "" {
		t.Errorf("mock user unexpectedly has Stripe IDs: %+v", u)
	}

	// Claim issues the token. Mock accounts are reusable test
	// accounts: claiming again ROTATES the token and returns fresh
	// credentials (real accounts are claim-once after the ack — see
	// reclaim_test.go). The first token dies at rotation.
	firstToken := claimViaAPI(t, ts, enrollmentID)
	token := claimViaAPI(t, ts, enrollmentID)
	if token == firstToken {
		t.Fatal("mock re-claim should return a fresh rotated token")
	}
	if loginResp := s.pluginLogin(loginContentJSON("alice", firstToken)); !loginResp.Reject {
		t.Fatal("pre-rotation token still accepted after mock re-claim")
	}

	// Account view: trialing, tunnel allowed, trial_end exposed.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/account", nil, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if status != 200 || resp["sub_status"] != SubStatusTrialing || resp["tunnel_allowed"] != true {
		t.Fatalf("account view: %d %v", status, resp)
	}
	if resp["trial_end"] == nil || resp["trial_end"] == "" {
		t.Errorf("account view missing trial_end while trialing: %v", resp)
	}
	if loginResp := s.pluginLogin(loginContentJSON("alice", token)); loginResp.Reject {
		t.Errorf("plugin login rejected for mock-claimed token: %q", loginResp.RejectReason)
	}
}

// ---------- full mock flow, monthly (no trial) ----------

func TestMockPayMonthlyActiveNoTrial(t *testing.T) {
	s := mockTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "bob", "plan": "monthly",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("enroll: HTTP %d: %v", status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)

	code, body := doRaw(t, "GET", ts.URL+"/mock-pay/"+enrollmentID, nil)
	if code != 200 {
		t.Fatalf("mock pay page HTTP %d", code)
	}
	for _, want := range []string{"$0.99", "charged immediately (mock)"} {
		if !strings.Contains(body, want) {
			t.Errorf("monthly mock page missing %q", want)
		}
	}
	if strings.Contains(body, "free trial") {
		t.Error("monthly mock page must not mention a free trial")
	}

	if code, _ := doRaw(t, "POST", ts.URL+"/mock-pay/"+enrollmentID, nil); code != 200 {
		t.Fatalf("mock pay POST HTTP %d", code)
	}
	u, ok := s.store.GetUser("bob")
	if !ok {
		t.Fatal("user not created by mock activation")
	}
	if u.SubStatus != SubStatusActive {
		t.Errorf("sub_status = %q, want active", u.SubStatus)
	}
	if !u.TrialEnd.IsZero() {
		t.Errorf("monthly user must have no trial_end, got %v", u.TrialEnd)
	}

	_, token := mockClaimOnly(t, ts, enrollmentID)
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/account", nil, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if status != 200 || resp["sub_status"] != SubStatusActive || resp["trial_end"] != nil {
		t.Fatalf("monthly account view: %d %v", status, resp)
	}
}

// mockClaimOnly performs just the claim POST and returns the token.
func mockClaimOnly(t *testing.T, ts *httptest.Server, enrollmentID string) (string, string) {
	t.Helper()
	token := claimViaAPI(t, ts, enrollmentID)
	ackViaAPI(t, ts, enrollmentID, token)
	return enrollmentID, token
}

// ---------- idempotency / unknown enrollment ----------

func TestMockPayIdempotentAndUnknown(t *testing.T) {
	s := mockTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	if code, _ := doRaw(t, "GET", ts.URL+"/mock-pay/enr_doesnotexist", nil); code != http.StatusNotFound {
		t.Errorf("GET unknown mock-pay HTTP %d, want 404", code)
	}
	if code, _ := doRaw(t, "POST", ts.URL+"/mock-pay/enr_doesnotexist", nil); code != http.StatusNotFound {
		t.Errorf("POST unknown mock-pay HTTP %d, want 404", code)
	}

	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "carol", "plan": "annual",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("enroll: HTTP %d: %v", status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)

	if code, body := doRaw(t, "POST", ts.URL+"/mock-pay/"+enrollmentID, nil); code != 200 || !strings.Contains(body, "Mock payment complete") {
		t.Fatalf("first POST: HTTP %d:\n%s", code, body)
	}
	first, _ := s.store.GetUser("carol")
	// Second POST: no error, page says already activated, state unchanged.
	code, body := doRaw(t, "POST", ts.URL+"/mock-pay/"+enrollmentID, nil)
	if code != 200 || !strings.Contains(body, "Already activated") {
		t.Fatalf("second POST should be idempotent 'already activated': HTTP %d:\n%s", code, body)
	}
	second, _ := s.store.GetUser("carol")
	if second.SubStatus != first.SubStatus || !second.TrialEnd.Equal(first.TrialEnd) {
		t.Errorf("second POST mutated state: %+v -> %+v", first, second)
	}
	// GET on a completed enrollment also shows the activated state.
	if code, body := doRaw(t, "GET", ts.URL+"/mock-pay/"+enrollmentID, nil); code != 200 || !strings.Contains(body, "Already activated") {
		t.Errorf("GET completed enrollment: HTTP %d, want 'already activated' page", code)
	}
}

// ---------- routes absent when mock disabled ----------

func TestMockRoutesDisabledWhenOff(t *testing.T) {
	// Even with Stripe fully configured and an admin key set, mock
	// routes must not exist when TUNNELD_MOCK_PAY is off.
	s, _, _ := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	if code, _ := doRaw(t, "GET", ts.URL+"/mock-pay/enr_anything", nil); code != http.StatusNotFound {
		t.Errorf("GET /mock-pay with mock disabled: HTTP %d, want 404", code)
	}
	if code, _ := doRaw(t, "POST", ts.URL+"/mock-pay/enr_anything", nil); code != http.StatusNotFound {
		t.Errorf("POST /mock-pay with mock disabled: HTTP %d, want 404", code)
	}
	status, _ := doJSON(t, "POST", ts.URL+"/api/v1/mock/users/alice/subscription-event",
		map[string]string{"event": "invoice.paid"},
		map[string]string{"X-Admin-Key": "test-admin-key"})
	if status != http.StatusNotFound {
		t.Errorf("subscription-event with mock disabled: HTTP %d, want 404", status)
	}
}

// ---------- subscription-event test hook ----------

func TestMockSubscriptionEvents(t *testing.T) {
	s := mockTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	_, token := mockEnrollAndPay(t, ts, "dave", "annual")
	eventURL := ts.URL + "/api/v1/mock/users/dave/subscription-event"
	admin := map[string]string{"X-Admin-Key": "test-admin-key"}

	// Admin gate matches the admin API: no key -> 401, wrong key -> 401.
	status, _ := doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.paid"}, nil)
	if status != http.StatusUnauthorized {
		t.Errorf("event without admin key: HTTP %d, want 401", status)
	}
	status, _ = doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.paid"},
		map[string]string{"X-Admin-Key": "wrong"})
	if status != http.StatusUnauthorized {
		t.Errorf("event with wrong admin key: HTTP %d, want 401", status)
	}
	// Unknown user -> 404; unknown event -> 422.
	status, _ = doJSON(t, "POST", ts.URL+"/api/v1/mock/users/nobody/subscription-event",
		map[string]string{"event": "invoice.paid"}, admin)
	if status != http.StatusNotFound {
		t.Errorf("event for unknown user: HTTP %d, want 404", status)
	}
	status, resp := doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.mysterious"}, admin)
	if status != http.StatusUnprocessableEntity {
		t.Errorf("unknown event: HTTP %d, want 422: %v", status, resp)
	}

	// trial.end: trialing -> active (trial conversion).
	status, resp = doJSON(t, "POST", eventURL, map[string]string{"event": "trial.end"}, admin)
	if status != 200 || resp["sub_status"] != SubStatusActive {
		t.Fatalf("trial.end: %d %v", status, resp)
	}

	// invoice.payment_failed: past_due with a ~3-day grace window, and
	// the tunnel still works inside grace.
	before := time.Now().UTC()
	status, resp = doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.payment_failed"}, admin)
	if status != 200 || resp["sub_status"] != SubStatusPastDue {
		t.Fatalf("payment_failed: %d %v", status, resp)
	}
	graceStr, _ := resp["grace_until"].(string)
	grace, err := time.Parse(time.RFC3339, graceStr)
	if err != nil {
		t.Fatalf("grace_until %q unparseable: %v", graceStr, err)
	}
	if grace.Before(before.Add(2*24*time.Hour)) || grace.After(time.Now().UTC().Add(4*24*time.Hour)) {
		t.Errorf("grace_until %v not ~3 days out", grace)
	}
	if resp["tunnel_allowed"] != true {
		t.Errorf("past_due in grace should still allow tunnel: %v", resp)
	}

	// invoice.paid: back to active, grace cleared.
	status, resp = doJSON(t, "POST", eventURL, map[string]string{"event": "invoice.paid"}, admin)
	if status != 200 || resp["sub_status"] != SubStatusActive || resp["grace_until"] != nil {
		t.Fatalf("invoice.paid restore: %d %v", status, resp)
	}

	// subscription.deleted: canceled, and the plugin now refuses login.
	status, resp = doJSON(t, "POST", eventURL, map[string]string{"event": "subscription.deleted"}, admin)
	if status != 200 || resp["sub_status"] != SubStatusCanceled || resp["tunnel_allowed"] != false {
		t.Fatalf("subscription.deleted: %d %v", status, resp)
	}
	if loginResp := s.pluginLogin(loginContentJSON("dave", token)); !loginResp.Reject {
		t.Error("plugin login should reject a canceled (mock) user")
	}
}
