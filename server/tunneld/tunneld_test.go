package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------- helpers ----------

func testConfig(t *testing.T) Config {
	t.Helper()
	return Config{
		ListenAddr:     "127.0.0.1:0",
		StorePath:      filepath.Join(t.TempDir(), "tunneld.json"),
		TunnelDomain:   "tunnel.homemcp.si",
		APIPublicBase:  "https://api.homemcp.si",
		AdminKey:       "test-admin-key",
		FRPSAddr:       "tunnel.homemcp.si",
		FRPSPort:       7000,
		BandwidthLimit: "5MB",
	}
}

func testServer(t *testing.T, cfg Config) *Server {
	t.Helper()
	store, err := OpenStore(cfg.StorePath)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	return &Server{cfg: cfg, store: store, stripe: newStripeClient(cfg)}
}

// addUser creates a user with a known plaintext token and status.
func addUser(t *testing.T, s *Server, username, token, status string, graceUntil time.Time) {
	t.Helper()
	if _, err := s.store.EnsureUser(username, PlanAnnual, s.cfg.SubdomainFor(username)); err != nil {
		t.Fatalf("EnsureUser: %v", err)
	}
	err := s.store.UpdateUser(username, func(u *User) {
		u.TokenHash = hashToken(token)
		u.SubStatus = status
		u.GraceUntil = graceUntil
	})
	if err != nil {
		t.Fatalf("UpdateUser: %v", err)
	}
}

func loginContentJSON(username, token string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"version": "0.68.0",
		"user":    username,
		"metas":   map[string]string{"token": token},
		"run_id":  "run-1",
	})
	return raw
}

func newProxyContentJSON(username, token, proxyType string, domains []string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{
		"user":           map[string]any{"user": username, "metas": map[string]string{"token": token}, "run_id": "run-1"},
		"proxy_name":     "homemcp",
		"proxy_type":     proxyType,
		"custom_domains": domains,
	})
	return raw
}

// ---------- username validation ----------

func TestValidateUsername(t *testing.T) {
	cases := []struct {
		in   string
		want string // normalized username when ok
		code string // expected error code when not ok
	}{
		{"alice", "alice", ""},
		{"Alice", "alice", ""}, // lowercased
		{"a1-b2", "a1-b2", ""},
		{"ab", "", "invalid_username"},                    // too short
		{"a", "", "invalid_username"},                     // way too short
		{"-alice", "", "invalid_username"},                // leading hyphen
		{"alice-", "", "invalid_username"},                // trailing hyphen
		{"al--ice", "", "invalid_username"},               // double hyphen
		{"al_ice", "", "invalid_username"},                // underscore not allowed
		{"al ice", "", "invalid_username"},                // space
		{"al.ice", "", "invalid_username"},                // dot
		{strings.Repeat("a", 31), "", "invalid_username"}, // too long
		{"www", "", "username_reserved"},
		{"admin", "", "username_reserved"},
		{"api", "", "username_reserved"},
		{"homemcp", "", "username_reserved"},
	}
	for _, c := range cases {
		got, code, ok := validateUsername(c.in)
		if c.code == "" {
			if !ok || got != c.want {
				t.Errorf("validateUsername(%q) = (%q, ok=%v), want %q", c.in, got, ok, c.want)
			}
		} else {
			if ok || code != c.code {
				t.Errorf("validateUsername(%q) ok=%v code=%q, want code %q", c.in, ok, code, c.code)
			}
		}
	}
}

// ---------- store roundtrip ----------

func TestStoreRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "store.json")
	st, err := OpenStore(path)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	enr := Enrollment{
		ID: "enr_abc", Username: "alice", Plan: PlanAnnual,
		Status: EnrollmentPendingPayment, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if err := st.CreateEnrollment(enr); err != nil {
		t.Fatalf("CreateEnrollment: %v", err)
	}
	if err := st.CreateEnrollment(enr); err == nil {
		t.Fatalf("duplicate CreateEnrollment should fail (username taken)")
	}
	if _, err := st.EnsureUser("alice", PlanAnnual, "alice.tunnel.homemcp.si"); err != nil {
		t.Fatalf("EnsureUser: %v", err)
	}
	if err := st.UpdateUser("alice", func(u *User) {
		u.TokenHash = hashToken("secret-token")
		u.SubStatus = SubStatusActive
		u.StripeCustomerID = "cus_1"
	}); err != nil {
		t.Fatalf("UpdateUser: %v", err)
	}

	// Reopen from disk and verify everything survived.
	st2, err := OpenStore(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	u, ok := st2.GetUser("alice")
	if !ok {
		t.Fatal("user lost after roundtrip")
	}
	if u.TokenHash != hashToken("secret-token") || u.SubStatus != SubStatusActive || u.StripeCustomerID != "cus_1" {
		t.Errorf("user fields wrong after roundtrip: %+v", u)
	}
	e, ok := st2.GetEnrollment("enr_abc")
	if !ok || e.Username != "alice" || e.Status != EnrollmentPendingPayment {
		t.Errorf("enrollment wrong after roundtrip: %+v ok=%v", e, ok)
	}
	if !st2.UsernameTaken("alice") {
		t.Error("UsernameTaken should be true")
	}
	if st2.UsernameTaken("bob") {
		t.Error("UsernameTaken should be false for bob")
	}
	// Token must never be recoverable from the store file.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("secret-token")) {
		t.Error("plaintext token found in store file")
	}
}

// ---------- plugin Login matrix ----------

func TestPluginLoginMatrix(t *testing.T) {
	s := testServer(t, testConfig(t))
	now := time.Now().UTC()
	addUser(t, s, "active-user", "tok-active", SubStatusActive, time.Time{})
	addUser(t, s, "trial-user", "tok-trial", SubStatusTrialing, time.Time{})
	addUser(t, s, "grace-user", "tok-grace", SubStatusPastDue, now.Add(24*time.Hour))
	addUser(t, s, "expired-user", "tok-expired", SubStatusPastDue, now.Add(-time.Hour))
	addUser(t, s, "canceled-user", "tok-canceled", SubStatusCanceled, time.Time{})
	addUser(t, s, "pending-user", "tok-pending", SubStatusPending, time.Time{})

	cases := []struct {
		name     string
		username string
		token    string
		accept   bool
	}{
		{"active ok", "active-user", "tok-active", true},
		{"trialing ok", "trial-user", "tok-trial", true},
		{"past_due in grace ok", "grace-user", "tok-grace", true},
		{"past_due grace over", "expired-user", "tok-expired", false},
		{"canceled", "canceled-user", "tok-canceled", false},
		{"pending", "pending-user", "tok-pending", false},
		{"wrong token", "active-user", "tok-WRONG", false},
		{"missing token", "active-user", "", false},
		{"unknown user", "nobody", "tok-active", false},
		{"empty user", "", "tok-active", false},
	}
	for _, c := range cases {
		resp := s.pluginLogin(loginContentJSON(c.username, c.token))
		if c.accept && resp.Reject {
			t.Errorf("%s: expected accept, got reject %q", c.name, resp.RejectReason)
		}
		if !c.accept && !resp.Reject {
			t.Errorf("%s: expected reject, got accept", c.name)
		}
		if !c.accept && resp.RejectReason == "" {
			t.Errorf("%s: reject without reason", c.name)
		}
	}
}

// ---------- plugin NewProxy ----------

func TestPluginNewProxy(t *testing.T) {
	s := testServer(t, testConfig(t))
	addUser(t, s, "alice", "tok-alice", SubStatusActive, time.Time{})
	addUser(t, s, "bob", "tok-bob", SubStatusActive, time.Time{})
	own := []string{"alice.tunnel.homemcp.si"}

	// Accept: bandwidth rewritten server-side, all other fields preserved.
	resp := s.pluginNewProxy(newProxyContentJSON("alice", "tok-alice", "https", own))
	if resp.Reject {
		t.Fatalf("valid NewProxy rejected: %q", resp.RejectReason)
	}
	if resp.Unchange {
		t.Fatal("expected unchange=false (bandwidth rewrite)")
	}
	var modified map[string]any
	if err := json.Unmarshal(resp.Content, &modified); err != nil {
		t.Fatalf("modified content not JSON: %v", err)
	}
	if modified["bandwidth_limit"] != "5MB" {
		t.Errorf("bandwidth_limit = %v, want 5MB", modified["bandwidth_limit"])
	}
	if modified["bandwidth_limit_mode"] != "server" {
		t.Errorf("bandwidth_limit_mode = %v, want server", modified["bandwidth_limit_mode"])
	}
	if modified["proxy_name"] != "homemcp" || modified["proxy_type"] != "https" {
		t.Errorf("original fields not preserved: %v", modified)
	}
	if domains, _ := modified["custom_domains"].([]any); len(domains) != 1 || domains[0] != "alice.tunnel.homemcp.si" {
		t.Errorf("custom_domains mangled: %v", modified["custom_domains"])
	}

	rejects := []struct {
		name    string
		content json.RawMessage
	}{
		{"tcp proxy", newProxyContentJSON("alice", "tok-alice", "tcp", own)},
		{"http proxy", newProxyContentJSON("alice", "tok-alice", "http", own)},
		{"stcp proxy", newProxyContentJSON("alice", "tok-alice", "stcp", own)},
		{"other tenant domain", newProxyContentJSON("alice", "tok-alice", "https", []string{"bob.tunnel.homemcp.si"})},
		{"foreign domain", newProxyContentJSON("alice", "tok-alice", "https", []string{"evil.example.com"})},
		{"extra domain", newProxyContentJSON("alice", "tok-alice", "https", []string{"alice.tunnel.homemcp.si", "bob.tunnel.homemcp.si"})},
		{"no domains", newProxyContentJSON("alice", "tok-alice", "https", nil)},
		{"bare parent domain", newProxyContentJSON("alice", "tok-alice", "https", []string{"tunnel.homemcp.si"})},
		{"bad token", newProxyContentJSON("alice", "tok-WRONG", "https", own)},
		{"unknown user", newProxyContentJSON("mallory", "tok-x", "https", []string{"mallory.tunnel.homemcp.si"})},
	}
	for _, c := range rejects {
		resp := s.pluginNewProxy(c.content)
		if !resp.Reject {
			t.Errorf("%s: expected reject, got accept", c.name)
		}
		if resp.RejectReason == "" {
			t.Errorf("%s: reject without reason", c.name)
		}
	}

	// subdomain field set -> reject.
	rawSub, _ := json.Marshal(map[string]any{
		"user":           map[string]any{"user": "alice", "metas": map[string]string{"token": "tok-alice"}, "run_id": "r"},
		"proxy_name":     "homemcp",
		"proxy_type":     "https",
		"subdomain":      "alice",
		"custom_domains": own,
	})
	if resp := s.pluginNewProxy(rawSub); !resp.Reject {
		t.Error("subdomain set: expected reject")
	}
	// remote_port set -> reject.
	rawPort, _ := json.Marshal(map[string]any{
		"user":           map[string]any{"user": "alice", "metas": map[string]string{"token": "tok-alice"}, "run_id": "r"},
		"proxy_name":     "homemcp",
		"proxy_type":     "https",
		"remote_port":    8443,
		"custom_domains": own,
	})
	if resp := s.pluginNewProxy(rawPort); !resp.Reject {
		t.Error("remote_port set: expected reject")
	}
	// Case-insensitive domain match is fine (DNS), but must still be own.
	resp = s.pluginNewProxy(newProxyContentJSON("alice", "tok-alice", "https", []string{"ALICE.TUNNEL.HOMEMCP.SI"}))
	if resp.Reject {
		t.Errorf("uppercase own domain should be accepted, rejected: %q", resp.RejectReason)
	}
}

// ---------- Stripe webhook signature ----------

func stripeSign(payload []byte, secret string, ts time.Time) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts.Unix(), 10)))
	mac.Write([]byte("."))
	mac.Write(payload)
	return fmt.Sprintf("t=%d,v1=%s", ts.Unix(), hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifyStripeSignature(t *testing.T) {
	secret := "whsec_test_secret"
	payload := []byte(`{"id":"evt_1","type":"invoice.paid"}`)
	now := time.Now().UTC()

	good := stripeSign(payload, secret, now)
	if err := verifyStripeSignature(payload, good, secret, now, 5*time.Minute); err != nil {
		t.Errorf("valid signature rejected: %v", err)
	}
	// Tampered payload.
	if err := verifyStripeSignature([]byte(`{"id":"evt_2","type":"invoice.paid"}`), good, secret, now, 5*time.Minute); err == nil {
		t.Error("tampered payload accepted")
	}
	// Wrong secret.
	if err := verifyStripeSignature(payload, good, "whsec_other", now, 5*time.Minute); err == nil {
		t.Error("signature with wrong secret accepted")
	}
	// Stale timestamp.
	stale := stripeSign(payload, secret, now.Add(-10*time.Minute))
	if err := verifyStripeSignature(payload, stale, secret, now, 5*time.Minute); err == nil {
		t.Error("stale timestamp accepted")
	}
	// Garbage header.
	if err := verifyStripeSignature(payload, "not-a-signature", secret, now, 5*time.Minute); err == nil {
		t.Error("garbage header accepted")
	}
}

// ---------- full enrollment flow against a fake Stripe ----------

type fakeStripe struct {
	checkoutForms []url.Values
}

func (f *fakeStripe) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/checkout/sessions", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", 400)
			return
		}
		f.checkoutForms = append(f.checkoutForms, r.Form)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id":  "cs_test_123",
			"url": "https://checkout.stripe.com/c/pay/cs_test_123",
		})
	})
	mux.HandleFunc("GET /v1/subscriptions/sub_123", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "sub_123", "status": "trialing", "customer": "cus_123",
			"current_period_end": 2000000000,
		})
	})
	mux.HandleFunc("POST /v1/billing_portal/sessions", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"url": "https://billing.stripe.com/p/session_123",
		})
	})
	return mux
}

func configuredTestServer(t *testing.T) (*Server, *httptest.Server, *fakeStripe) {
	t.Helper()
	fake := &fakeStripe{}
	fakeSrv := httptest.NewServer(fake.handler())
	t.Cleanup(fakeSrv.Close)
	cfg := testConfig(t)
	cfg.StripeSecretKey = "sk_test_fake"
	cfg.StripeWebhookSecret = "whsec_test_fake"
	cfg.StripePriceAnnual = "price_annual"
	cfg.StripePriceMonthly = "price_monthly"
	cfg.StripeAPIBase = fakeSrv.URL
	return testServer(t, cfg), fakeSrv, fake
}

func doJSON(t *testing.T, method, url string, body any, headers map[string]string) (int, map[string]any) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
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
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func TestEnrollmentFlowAnnualTrialAndClaim(t *testing.T) {
	s, _, fake := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	// 1) Create enrollment (annual).
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "alice", "plan": "annual",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("create enrollment: HTTP %d: %v", status, resp)
	}
	enrollmentID, _ := resp["enrollment_id"].(string)
	if enrollmentID == "" || resp["checkout_url"] == "" {
		t.Fatalf("missing enrollment_id/checkout_url: %v", resp)
	}
	if resp["subdomain"] != "alice.tunnel.homemcp.si" {
		t.Errorf("subdomain = %v", resp["subdomain"])
	}
	// Stripe form must carry the annual trial rules.
	if len(fake.checkoutForms) != 1 {
		t.Fatalf("expected 1 checkout call, got %d", len(fake.checkoutForms))
	}
	form := fake.checkoutForms[0]
	if form.Get("subscription_data[trial_period_days]") != "7" {
		t.Errorf("annual trial_period_days = %q, want 7", form.Get("subscription_data[trial_period_days]"))
	}
	if form.Get("payment_method_collection") != "always" {
		t.Errorf("annual payment_method_collection = %q, want always", form.Get("payment_method_collection"))
	}
	if form.Get("client_reference_id") != enrollmentID {
		t.Errorf("client_reference_id = %q, want %q", form.Get("client_reference_id"), enrollmentID)
	}
	if form.Get("line_items[0][price]") != "price_annual" {
		t.Errorf("price = %q, want price_annual", form.Get("line_items[0][price]"))
	}
	if form.Get("mode") != "subscription" {
		t.Errorf("mode = %q", form.Get("mode"))
	}

	// 2) Before the webhook, enrollment is pending and no creds leak.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/enrollments/"+enrollmentID, nil, nil)
	if status != 200 || resp["status"] != EnrollmentPendingPayment || resp["credentials"] != nil {
		t.Fatalf("pre-webhook enrollment view wrong: %d %v", status, resp)
	}

	// 3) Webhook: checkout.session.completed (signed).
	event := map[string]any{
		"id": "evt_1", "type": "checkout.session.completed",
		"data": map[string]any{"object": map[string]any{
			"id": "cs_test_123", "client_reference_id": enrollmentID,
			"customer": "cus_123", "subscription": "sub_123",
			"payment_status": "no_payment_required",
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

	// Unsigned webhook must fail.
	req2, _ := http.NewRequest("POST", ts.URL+"/webhooks/stripe", bytes.NewReader(rawEvent))
	wresp2, _ := http.DefaultClient.Do(req2)
	wresp2.Body.Close()
	if wresp2.StatusCode == 200 {
		t.Fatal("unsigned webhook accepted")
	}

	// User activated as trialing by the subscription fetch.
	u, ok := s.store.GetUser("alice")
	if !ok {
		t.Fatal("user not created by webhook")
	}
	if u.SubStatus != SubStatusTrialing || u.StripeCustomerID != "cus_123" || u.StripeSubscriptionID != "sub_123" {
		t.Errorf("user after webhook: %+v", u)
	}

	// 4) Claim: first GET returns credentials exactly once.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/enrollments/"+enrollmentID, nil, nil)
	if status != 200 || resp["status"] != EnrollmentClaimed {
		t.Fatalf("claim: %d %v", status, resp)
	}
	creds, _ := resp["credentials"].(map[string]any)
	if creds == nil {
		t.Fatalf("claim returned no credentials: %v", resp)
	}
	token, _ := creds["token"].(string)
	if token == "" || creds["username"] != "alice" || creds["subdomain"] != "alice.tunnel.homemcp.si" {
		t.Errorf("credentials wrong: %v", creds)
	}
	frpc, _ := creds["frpc_config"].(string)
	if !strings.Contains(frpc, token) || !strings.Contains(frpc, "alice.tunnel.homemcp.si") || !strings.Contains(frpc, `type = "https"`) {
		t.Errorf("frpc_config incomplete:\n%s", frpc)
	}

	// Second GET: status only, token never re-issued.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/enrollments/"+enrollmentID, nil, nil)
	if status != 200 || resp["credentials"] != nil {
		t.Fatalf("second claim leaked credentials: %d %v", status, resp)
	}

	// 5) Account endpoint with the issued token; plugin accepts login.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/account", nil, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if status != 200 || resp["sub_status"] != SubStatusTrialing || resp["tunnel_allowed"] != true {
		t.Fatalf("account view: %d %v", status, resp)
	}
	if loginResp := s.pluginLogin(loginContentJSON("alice", token)); loginResp.Reject {
		t.Errorf("plugin login with claimed token rejected: %q", loginResp.RejectReason)
	}
	// Wrong token -> 401.
	status, _ = doJSON(t, "GET", ts.URL+"/api/v1/account", nil, map[string]string{
		"Authorization": "Bearer nope",
	})
	if status != http.StatusUnauthorized {
		t.Errorf("wrong token account HTTP %d, want 401", status)
	}

	// 6) Billing portal.
	status, resp = doJSON(t, "POST", ts.URL+"/api/v1/account/portal", nil, map[string]string{
		"Authorization": "Bearer " + token,
	})
	if status != 200 || resp["url"] == "" {
		t.Errorf("portal: %d %v", status, resp)
	}

	// 7) Admin list must not contain token hashes.
	status, resp = doJSON(t, "GET", ts.URL+"/api/v1/admin/users", nil, map[string]string{
		"X-Admin-Key": "test-admin-key",
	})
	if status != 200 {
		t.Fatalf("admin list HTTP %d", status)
	}
	rawAdmin, _ := json.Marshal(resp)
	if bytes.Contains(rawAdmin, []byte("token_hash")) || bytes.Contains(rawAdmin, []byte(hashToken(token))) {
		t.Error("admin output leaks token hash")
	}
	// Admin without key -> 401.
	status, _ = doJSON(t, "GET", ts.URL+"/api/v1/admin/users", nil, nil)
	if status != http.StatusUnauthorized {
		t.Errorf("admin without key HTTP %d, want 401", status)
	}
}

func TestEnrollmentMonthlyHasNoTrial(t *testing.T) {
	s, _, fake := configuredTestServer(t)
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	status, _ := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "bob", "plan": "monthly",
	}, nil)
	if status != http.StatusCreated {
		t.Fatalf("create monthly enrollment HTTP %d", status)
	}
	form := fake.checkoutForms[0]
	if _, present := form["subscription_data[trial_period_days]"]; present {
		t.Error("monthly checkout must not set trial_period_days")
	}
	if form.Get("payment_method_collection") == "always" {
		t.Error("monthly checkout should use default payment collection, not always")
	}
	if form.Get("line_items[0][price]") != "price_monthly" {
		t.Errorf("price = %q, want price_monthly", form.Get("line_items[0][price]"))
	}
	// Username is now reserved by the pending enrollment.
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "bob", "plan": "monthly",
	}, nil)
	if status != http.StatusConflict {
		t.Errorf("duplicate username HTTP %d (%v), want 409", status, resp)
	}
}

func TestEnrollmentStripeNotConfigured(t *testing.T) {
	s := testServer(t, testConfig(t)) // no Stripe keys at all
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	status, resp := doJSON(t, "POST", ts.URL+"/api/v1/enrollments", map[string]string{
		"username": "carol", "plan": "annual",
	}, nil)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("HTTP %d, want 503: %v", status, resp)
	}
	errObj, _ := resp["error"].(map[string]any)
	if errObj["code"] != "stripe_not_configured" {
		t.Errorf("error code = %v", errObj["code"])
	}
	// And the username must NOT have been squatted by the failed attempt.
	if s.store.UsernameTaken("carol") {
		t.Error("failed enrollment should not reserve the username")
	}
}
