package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Test accounts (mock allowlist) are reusable: re-claiming a claimed
// enrollment rotates the token and returns fresh credentials. Real
// accounts are claim-once once the client confirms (acks) the claim;
// their recovery path is the operator reset endpoint. Both halves are
// pinned down here.

// claimViaAPI performs POST .../claim and returns the issued token.
func claimViaAPI(t *testing.T, ts *httptest.Server, enrollmentID string) string {
	t.Helper()
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/enrollments/"+enrollmentID+"/claim", nil, nil)
	if status != http.StatusOK {
		t.Fatalf("claim %s: status = %d; body %v", enrollmentID, status, body)
	}
	creds, ok := body["credentials"].(map[string]any)
	if !ok {
		t.Fatalf("claim %s: no credentials in response %v", enrollmentID, body)
	}
	token, _ := creds["token"].(string)
	if token == "" {
		t.Fatalf("claim %s: empty token", enrollmentID)
	}
	return token
}

// ackViaAPI performs POST .../claim/ack with the given token and
// requires success.
func ackViaAPI(t *testing.T, ts *httptest.Server, enrollmentID, token string) {
	t.Helper()
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/enrollments/"+enrollmentID+"/claim/ack",
		map[string]string{"token": token}, nil)
	if status != http.StatusOK || body["claim_acked"] != true {
		t.Fatalf("ack %s: status = %d; body %v", enrollmentID, status, body)
	}
}

func enrollAndClaim(t *testing.T, ts *httptest.Server, username string) (enrollmentID, token string) {
	t.Helper()
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/enrollments",
		map[string]any{"username": username, "plan": "monthly"}, nil)
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("enroll %s: status = %d; body %v", username, status, body)
	}
	enrollmentID, _ = body["enrollment_id"].(string)
	token = claimViaAPI(t, ts, enrollmentID)
	ackViaAPI(t, ts, enrollmentID, token)
	return enrollmentID, token
}

func TestMockEnrollmentReclaimRotates(t *testing.T) {
	s := testServer(t, testConfig(t))
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	admin := map[string]string{"X-Admin-Key": "test-admin-key"}
	status, _ := doJSON(t, http.MethodPut, ts.URL+"/api/v1/admin/mock-users/devreuse",
		map[string]any{"note": "client dev"}, admin)
	if status != http.StatusOK {
		t.Fatalf("allowlist PUT: status = %d", status)
	}

	eid, tokenA := enrollAndClaim(t, ts, "devreuse")

	// Reads never carry credentials any more — not even for mocks.
	status, body := doJSON(t, http.MethodGet, ts.URL+"/api/v1/enrollments/"+eid, nil, nil)
	if status != http.StatusOK {
		t.Fatalf("poll claimed: status = %d", status)
	}
	if _, has := body["credentials"]; has {
		t.Fatalf("status read leaked credentials: %v", body)
	}

	// But a mock account can always CLAIM again: fresh credentials
	// (rotated), even though the previous claim was acked.
	tokenB := claimViaAPI(t, ts, eid)
	ackViaAPI(t, ts, eid, tokenB)
	if tokenB == tokenA {
		t.Fatal("re-claim did not rotate the token")
	}

	// The old token is dead everywhere; the new one works.
	if resp := s.pluginLogin(loginContentJSON("devreuse", tokenA)); !resp.Reject {
		t.Fatal("old token still accepted by plugin after rotation")
	}
	if resp := s.pluginLogin(loginContentJSON("devreuse", tokenB)); resp.Reject {
		t.Fatalf("new token rejected by plugin: %q", resp.RejectReason)
	}
	status, _ = doJSON(t, http.MethodGet, ts.URL+"/api/v1/account", nil, bearer(tokenB))
	if status != http.StatusOK {
		t.Fatalf("account with rotated token: status = %d, want 200", status)
	}

	// And it can be re-claimed yet again (dev loops are unbounded).
	tokenC := claimViaAPI(t, ts, eid)
	if tokenC == tokenB {
		t.Fatal("second re-claim did not rotate")
	}
}

func TestRealEnrollmentStaysClaimOnce(t *testing.T) {
	s := testServer(t, testConfig(t))
	ts := httptest.NewServer(s.routes())
	defer ts.Close()

	// A real (non-mock) account with an already-claimed enrollment,
	// assembled at store level in the same end state the Stripe
	// funnel produces: enrollment claimed, user active, token hash
	// installed.
	now := time.Now().UTC()
	if err := s.store.CreateEnrollment(Enrollment{
		ID: "enr_real_1", Username: "realuser", Plan: PlanMonthly,
		Status: EnrollmentReady, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("CreateEnrollment: %v", err)
	}
	if _, err := s.store.EnsureUser("realuser", PlanMonthly, "realuser.tunnel.homemcp.si"); err != nil {
		t.Fatalf("EnsureUser: %v", err)
	}
	if err := s.store.UpdateUser("realuser", func(u *User) { u.SubStatus = SubStatusActive }); err != nil {
		t.Fatalf("UpdateUser: %v", err)
	}
	if _, _, err := s.store.ClaimAndIssue("enr_real_1", hashToken("real-token-1")); err != nil {
		t.Fatalf("ClaimAndIssue: %v", err)
	}
	// The client persisted the credentials and confirmed the claim:
	// the terminal state this test pins down.
	if _, err := s.store.AckClaim("enr_real_1", hashToken("real-token-1")); err != nil {
		t.Fatalf("AckClaim: %v", err)
	}

	status, body := doJSON(t, http.MethodGet, ts.URL+"/api/v1/enrollments/enr_real_1", nil, nil)
	if status != http.StatusOK {
		t.Fatalf("poll claimed enrollment: status = %d", status)
	}
	if _, has := body["credentials"]; has {
		t.Fatalf("real account status read leaked credentials: %v", body)
	}
	// A further claim is refused outright once the claim is acked.
	status, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/enrollments/enr_real_1/claim", nil, nil)
	if status != http.StatusConflict || body["error"].(map[string]any)["code"] != "already_claimed" {
		t.Fatalf("real account re-claim: status = %d body %v, want 409 already_claimed", status, body)
	}
	// The original token is untouched: it still passes the plugin.
	if resp := s.pluginLogin(loginContentJSON("realuser", "real-token-1")); resp.Reject {
		t.Fatalf("real user's token broke after an enrollment poll: %q", resp.RejectReason)
	}
}

func TestAdminDeleteMockUser(t *testing.T) {
	s := testServer(t, testConfig(t))
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	admin := map[string]string{"X-Admin-Key": "test-admin-key"}

	status, _ := doJSON(t, http.MethodPut, ts.URL+"/api/v1/admin/mock-users/devclean",
		map[string]any{"note": "cleanup test"}, admin)
	if status != http.StatusOK {
		t.Fatalf("allowlist PUT: status = %d", status)
	}
	eid, token := enrollAndClaim(t, ts, "devclean")
	if resp := s.pluginLogin(loginContentJSON("devclean", token)); resp.Reject {
		t.Fatalf("setup: claimed token rejected: %q", resp.RejectReason)
	}

	// No admin key: refused.
	status, _ = doJSON(t, http.MethodDelete, ts.URL+"/api/v1/admin/users/devclean", nil, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("delete without key: status = %d, want 401", status)
	}
	// A real account cannot be deleted through this endpoint.
	addUser(t, s, "realalice", "real-alice-token", SubStatusActive, time.Time{})
	status, body := doJSON(t, http.MethodDelete, ts.URL+"/api/v1/admin/users/realalice", nil, admin)
	if status != http.StatusConflict || body["error"].(map[string]any)["code"] != "not_mock_account" {
		t.Fatalf("delete real account: status = %d body %v, want 409 not_mock_account", status, body)
	}

	// Delete the mock account: everything goes.
	status, body = doJSON(t, http.MethodDelete, ts.URL+"/api/v1/admin/users/devclean", nil, admin)
	if status != http.StatusOK || body["deleted"] != "devclean" {
		t.Fatalf("delete mock account: status = %d body %v", status, body)
	}
	if resp := s.pluginLogin(loginContentJSON("devclean", token)); !resp.Reject {
		t.Fatal("deleted user's token still accepted")
	}
	status, _ = doJSON(t, http.MethodGet, ts.URL+"/api/v1/enrollments/"+eid, nil, nil)
	if status != http.StatusNotFound {
		t.Fatalf("deleted user's enrollment: status = %d, want 404", status)
	}

	// The allowlist entry survives on purpose: the same username
	// re-enrolls payment-free and the full loop starts over.
	status, body = doJSON(t, http.MethodGet, ts.URL+"/api/v1/admin/mock-users", nil, admin)
	if status != http.StatusOK {
		t.Fatalf("list mock users: status = %d", status)
	}
	found := false
	for _, entry := range body["mock_users"].([]any) {
		if entry.(map[string]any)["username"] == "devclean" {
			found = true
		}
	}
	if !found {
		t.Fatalf("allowlist entry for devclean vanished after account deletion: %v", body)
	}
	_, token2 := enrollAndClaim(t, ts, "devclean")
	if resp := s.pluginLogin(loginContentJSON("devclean", token2)); resp.Reject {
		t.Fatalf("re-enrolled token rejected: %q", resp.RejectReason)
	}
}

func TestMockAccountSelfDelete(t *testing.T) {
	s := testServer(t, testConfig(t))
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	admin := map[string]string{"X-Admin-Key": "test-admin-key"}

	status, _ := doJSON(t, http.MethodPut, ts.URL+"/api/v1/admin/mock-users/devself",
		map[string]any{"note": "self delete test"}, admin)
	if status != http.StatusOK {
		t.Fatalf("allowlist PUT: status = %d", status)
	}
	eid, token := enrollAndClaim(t, ts, "devself")

	// A real account gets 409, and survives.
	addUser(t, s, "realbob", "real-bob-token", SubStatusActive, time.Time{})
	status, body := doJSON(t, http.MethodDelete, ts.URL+"/api/v1/account", nil, bearer("real-bob-token"))
	if status != http.StatusConflict || body["error"].(map[string]any)["code"] != "not_mock_account" {
		t.Fatalf("real account self-delete: status = %d body %v, want 409 not_mock_account", status, body)
	}
	if _, ok := s.store.GetUser("realbob"); !ok {
		t.Fatal("real account was deleted by the self-delete endpoint")
	}

	// The mock account deletes itself with its own token.
	status, body = doJSON(t, http.MethodDelete, ts.URL+"/api/v1/account", nil, bearer(token))
	if status != http.StatusOK || body["deleted"] != "devself" {
		t.Fatalf("self-delete: status = %d body %v", status, body)
	}
	// Token, account and enrollment are all gone.
	status, _ = doJSON(t, http.MethodGet, ts.URL+"/api/v1/account", nil, bearer(token))
	if status != http.StatusUnauthorized {
		t.Fatalf("account after self-delete: status = %d, want 401", status)
	}
	status, _ = doJSON(t, http.MethodGet, ts.URL+"/api/v1/enrollments/"+eid, nil, nil)
	if status != http.StatusNotFound {
		t.Fatalf("enrollment after self-delete: status = %d, want 404", status)
	}
	if resp := s.pluginLogin(loginContentJSON("devself", token)); !resp.Reject {
		t.Fatal("self-deleted account's token still accepted by plugin")
	}
	// And the username starts over cleanly (allowlist entry kept).
	_, token2 := enrollAndClaim(t, ts, "devself")
	if resp := s.pluginLogin(loginContentJSON("devself", token2)); resp.Reject {
		t.Fatalf("re-enrolled token after self-delete rejected: %q", resp.RejectReason)
	}
}

func TestAdminResetCredentials(t *testing.T) {
	s := testServer(t, testConfig(t))
	ts := httptest.NewServer(s.routes())
	defer ts.Close()
	addUser(t, s, "alice", "alice-old-token", SubStatusActive, time.Time{})

	// No key / wrong key.
	status, _ := doJSON(t, http.MethodPost, ts.URL+"/api/v1/admin/users/alice/reset-credentials", nil, nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("no-key reset: status = %d, want 401", status)
	}
	status, _ = doJSON(t, http.MethodPost, ts.URL+"/api/v1/admin/users/alice/reset-credentials",
		nil, map[string]string{"X-Admin-Key": "wrong"})
	if status != http.StatusUnauthorized {
		t.Fatalf("wrong-key reset: status = %d, want 401", status)
	}
	// Unknown user.
	status, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/admin/users/nobody/reset-credentials",
		nil, map[string]string{"X-Admin-Key": "test-admin-key"})
	if status != http.StatusNotFound || body["error"].(map[string]any)["code"] != "user_not_found" {
		t.Fatalf("unknown-user reset: status = %d body %v, want 404 user_not_found", status, body)
	}
	// Success: fresh credentials, old token dead, new token live.
	status, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/admin/users/alice/reset-credentials",
		nil, map[string]string{"X-Admin-Key": "test-admin-key"})
	if status != http.StatusOK {
		t.Fatalf("reset: status = %d; body %v", status, body)
	}
	newToken, _ := body["token"].(string)
	if newToken == "" || newToken == "alice-old-token" {
		t.Fatalf("reset token = %q, want a fresh token", newToken)
	}
	if body["frpc_config"] == "" || body["subdomain"] != "alice.tunnel.homemcp.si" {
		t.Fatalf("reset response incomplete: %v", body)
	}
	if resp := s.pluginLogin(loginContentJSON("alice", "alice-old-token")); !resp.Reject {
		t.Fatal("old token still works after admin reset")
	}
	if resp := s.pluginLogin(loginContentJSON("alice", newToken)); resp.Reject {
		t.Fatalf("new token rejected after admin reset: %q", resp.RejectReason)
	}
}
