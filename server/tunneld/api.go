package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Public registration/account API. Registration lives inside the
// HomeMCP client; the browser surfaces are Stripe's hosted
// Checkout/Billing Portal plus tunneld's one static checkout-return
// page (handleCheckoutComplete), which only reports status and never
// issues credentials. See docs/CLIENT_CONTRACT.md for the wire
// contract this file implements.
//
// Error vocabulary (stable, machine-readable):
//   bad_request, invalid_username, username_reserved, username_taken,
//   invalid_plan, enrollment_not_found, credentials_not_ready,
//   already_claimed, not_claimed, stale_claim,
//   unauthorized, no_billing_account, stripe_not_configured,
//   admin_disabled, user_not_found, invalid_event, not_mock_account,
//   cert_dns_not_configured, subscription_inactive, invalid_txt_value,
//   challenge_not_found, challenge_limit, challenge_rate_limited,
//   dns_provider_error, internal.

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}

// usernamePattern: 3-30 chars, lowercase alnum, hyphens allowed inside.
// It becomes a DNS label (<username>.tunnel.homemcp.si), so the rules are
// DNS-label rules with margin.
var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`)

// reservedUsernames can never be registered: service names, roles, and
// anything that would collide with operator infrastructure.
var reservedUsernames = map[string]bool{
	"www": true, "api": true, "admin": true, "administrator": true,
	"mail": true, "smtp": true, "imap": true, "pop": true, "pop3": true,
	"ftp": true, "ns1": true, "ns2": true, "dns": true, "mx": true,
	"edge": true, "relay": true, "frp": true, "frps": true, "frpc": true,
	"tunnel": true, "tunneld": true, "proxy": true, "vpn": true,
	"support": true, "help": true, "billing": true, "pay": true,
	"payments": true, "stripe": true, "status": true, "app": true,
	"dashboard": true, "login": true, "logout": true, "register": true,
	"signup": true, "signin": true, "account": true, "accounts": true,
	"user": true, "users": true, "root": true, "system": true,
	"homemcp": true, "owner": true, "operator": true, "official": true,
	"test": true, "demo": true, "null": true, "undefined": true,
	"default": true, "public": true, "static": true, "assets": true,
	"cdn": true, "blog": true, "shop": true, "store": true, "news": true,
	"auth": true, "oauth": true, "webhook": true, "webhooks": true,
	"abuse": true, "security": true, "legal": true, "privacy": true,
	"terms": true, "about": true, "contact": true, "info": true,
	"api-ingress": true, // the operator's frps ingress account (plugin.go)
}

// validateUsername normalizes (trim + lowercase; DNS is case-insensitive)
// and validates a desired username. The returned code is the API error
// code to surface.
func validateUsername(raw string) (normalized string, code string, ok bool) {
	name := strings.ToLower(strings.TrimSpace(raw))
	if !usernamePattern.MatchString(name) {
		return "", "invalid_username", false
	}
	if strings.Contains(name, "--") {
		return "", "invalid_username", false
	}
	if reservedUsernames[name] {
		return "", "username_reserved", false
	}
	return name, "", true
}

type createEnrollmentRequest struct {
	Username string `json:"username"`
	Plan     string `json:"plan"`
}

type createEnrollmentResponse struct {
	EnrollmentID string `json:"enrollment_id"`
	CheckoutURL  string `json:"checkout_url"`
	Status       string `json:"status"`
	Username     string `json:"username"`
	Plan         string `json:"plan"`
	Subdomain    string `json:"subdomain"`
}

// handleCreateEnrollment is POST /api/v1/enrollments.
// Order matters: validate first, then the payment-config check (so an
// unconfigured server fails with 503 without squatting the username),
// then reserve the enrollment, then create the checkout. With mock pay
// enabled (internal testing only) the config check is skipped and the
// "checkout" is tunneld's own /mock-pay/<id> page instead of Stripe.
//
// Exception to the config check: a username on the operator's mock
// allowlist (store.MockUsers, admin-managed) skips payment entirely on
// ANY instance — no Stripe, no mock page. The enrollment is activated
// server-side the moment it is created and the response carries an
// empty checkout_url with status "ready"; the client just polls.
// Payment is ALWAYS decided here on the server: a client can never
// assert "I paid" (see mockpay.go for the allowlist endpoints).
func (s *Server) handleCreateEnrollment(w http.ResponseWriter, r *http.Request) {
	var req createEnrollmentRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	if err := dec.Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "request body must be JSON {username, plan}")
		return
	}
	username, code, ok := validateUsername(req.Username)
	if !ok {
		msg := "username must be 3-30 chars of [a-z0-9-], starting and ending with a letter or digit"
		if code == "username_reserved" {
			msg = "this username is reserved"
		}
		writeAPIError(w, http.StatusUnprocessableEntity, code, msg)
		return
	}
	if req.Plan != PlanAnnual && req.Plan != PlanMonthly {
		writeAPIError(w, http.StatusUnprocessableEntity, "invalid_plan", "plan must be \"annual\" or \"monthly\"")
		return
	}
	mockListed := s.store.IsMockUser(username)
	if !mockListed && !s.cfg.MockPay && !s.cfg.StripeConfigured() {
		writeAPIError(w, http.StatusServiceUnavailable, "stripe_not_configured", "billing is not configured on this server yet")
		return
	}
	if s.store.UsernameTaken(username) {
		writeAPIError(w, http.StatusConflict, "username_taken", "this username is already registered or being registered")
		return
	}
	id, err := newEnrollmentID()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not allocate enrollment")
		return
	}
	enr := Enrollment{
		ID:        id,
		Username:  username,
		Plan:      req.Plan,
		Status:    EnrollmentPendingPayment,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := s.store.CreateEnrollment(enr); err != nil {
		if errors.Is(err, ErrUsernameTaken) {
			writeAPIError(w, http.StatusConflict, "username_taken", "this username is already registered or being registered")
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not store enrollment")
		return
	}
	if mockListed {
		// Operator allowlist: pretend the payment already happened.
		// Activation goes through the same funnel + plan semantics as
		// a completed checkout; no URL is handed out because there is
		// nothing for the user to do in a browser.
		s.activateMockEnrollment(enr)
		log.Printf("mock allowlist: enrollment %s for %q (%s) activated without payment", enr.ID, username, req.Plan)
		enr, _ = s.store.GetEnrollment(enr.ID)
		writeJSON(w, http.StatusCreated, createEnrollmentResponse{
			EnrollmentID: enr.ID,
			CheckoutURL:  "",
			Status:       enr.Status,
			Username:     username,
			Plan:         req.Plan,
			Subdomain:    s.cfg.SubdomainFor(username),
		})
		return
	}
	if s.cfg.MockPay {
		// Mock checkout: no Stripe call, no session ID. The client
		// opens this URL in a browser exactly like a Stripe Checkout
		// URL; the page there activates the enrollment through the
		// same funnel a webhook would (see mockpay.go).
		writeJSON(w, http.StatusCreated, createEnrollmentResponse{
			EnrollmentID: enr.ID,
			CheckoutURL:  s.cfg.APIPublicBase + "/mock-pay/" + enr.ID,
			Status:       enr.Status,
			Username:     username,
			Plan:         req.Plan,
			Subdomain:    s.cfg.SubdomainFor(username),
		})
		return
	}
	sessionID, checkoutURL, err := s.createCheckoutSession(enr)
	if err != nil {
		// The enrollment stays pending_payment; the client may retry
		// checkout creation later via a fresh enrollment only if the
		// operator cleans up — for now report the failure plainly.
		log.Printf("create checkout session for enrollment %s: %v", enr.ID, err)
		writeAPIError(w, http.StatusBadGateway, "stripe_error", "payment provider could not create a checkout session")
		return
	}
	_ = s.store.UpdateEnrollment(enr.ID, func(e *Enrollment) {
		e.StripeCheckoutSessionID = sessionID
	})
	writeJSON(w, http.StatusCreated, createEnrollmentResponse{
		EnrollmentID: enr.ID,
		CheckoutURL:  checkoutURL,
		Status:       enr.Status,
		Username:     username,
		Plan:         req.Plan,
		Subdomain:    s.cfg.SubdomainFor(username),
	})
}

type credentialsView struct {
	Username   string `json:"username"`
	Token      string `json:"token"`
	Subdomain  string `json:"subdomain"`
	FRPCConfig string `json:"frpc_config"`
}

type enrollmentView struct {
	EnrollmentID      string           `json:"enrollment_id"`
	Status            string           `json:"status"`
	Username          string           `json:"username"`
	Plan              string           `json:"plan"`
	Subdomain         string           `json:"subdomain"`
	SubStatus         string           `json:"sub_status,omitempty"`
	CredentialsIssued bool             `json:"credentials_issued"`
	ClaimAcked        bool             `json:"claim_acked"`
	Credentials       *credentialsView `json:"credentials,omitempty"`
}

// enrollmentViewOf renders the read-only status view of an enrollment.
// It NEVER carries credentials: issuance happens only in
// handleClaimEnrollment.
func (s *Server) enrollmentViewOf(enr Enrollment) enrollmentView {
	view := enrollmentView{
		EnrollmentID:      enr.ID,
		Status:            enr.Status,
		Username:          enr.Username,
		Plan:              enr.Plan,
		Subdomain:         s.cfg.SubdomainFor(enr.Username),
		CredentialsIssued: enr.CredentialsIssued,
		ClaimAcked:        enr.ClaimAcked,
	}
	if u, ok := s.store.GetUser(enr.Username); ok {
		view.SubStatus = u.SubStatus
	}
	return view
}

// handleGetEnrollment is GET /api/v1/enrollments/{id}: a pure status
// read. It never generates, issues, rotates or otherwise consumes
// credentials, so it is safe for anyone to poll or refresh any number
// of times — the client polls it while waiting for the payment
// webhook, and nothing a browser does can burn the one claim. (This
// handler originally issued credentials on the first read; combined
// with Stripe's success_url pointing at it, a browser return or
// refresh could consume the claim before the client ever saved the
// credentials. Issuance now lives behind POST .../claim only.)
func (s *Server) handleGetEnrollment(w http.ResponseWriter, r *http.Request) {
	enr, ok := s.store.GetEnrollment(r.PathValue("id"))
	if !ok {
		writeAPIError(w, http.StatusNotFound, "enrollment_not_found", "no such enrollment")
		return
	}
	writeJSON(w, http.StatusOK, s.enrollmentViewOf(enr))
}

// handleClaimEnrollment is POST /api/v1/enrollments/{id}/claim: the one
// and only credential-issuance path. The enrollment ID is the claim
// capability. The claim is RECOVERABLE until the client confirms it
// persisted the credentials (POST .../claim/ack): claiming an
// already-claimed-but-unacked enrollment rotates the token and returns
// fresh credentials, so a client that crashed, lost the response, or
// failed to save can simply claim again. Once acked, a real account's
// claim is final (409 already_claimed; recovery is the operator reset
// endpoint). Mock (test) accounts may re-claim even after the ack —
// rotation again — so client development can restart at will.
func (s *Server) handleClaimEnrollment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := s.store.GetEnrollment(id); !ok {
		writeAPIError(w, http.StatusNotFound, "enrollment_not_found", "no such enrollment")
		return
	}
	token, err := generateToken()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not generate credentials")
		return
	}
	enr, user, err := s.store.ClaimAndIssue(id, hashToken(token))
	if err != nil {
		switch {
		case errors.Is(err, ErrNotReady):
			writeAPIError(w, http.StatusConflict, "credentials_not_ready", "payment has not completed yet; poll the enrollment status and claim once it is ready")
		case errors.Is(err, ErrAlreadyClaimed):
			writeAPIError(w, http.StatusConflict, "already_claimed", "credentials were already claimed and confirmed; ask support to reset them if they are lost")
		case errors.Is(err, ErrNotFound):
			writeAPIError(w, http.StatusNotFound, "enrollment_not_found", "no such enrollment")
		default:
			writeAPIError(w, http.StatusInternalServerError, "internal", "could not issue credentials")
		}
		return
	}
	log.Printf("enrollment %s: credentials issued for %q (claim)", enr.ID, user.Username)
	view := s.enrollmentViewOf(enr)
	view.Credentials = &credentialsView{
		Username:   user.Username,
		Token:      token,
		Subdomain:  user.Subdomain,
		FRPCConfig: s.renderFRPCConfig(user, token),
	}
	writeJSON(w, http.StatusOK, view)
}

type claimAckRequest struct {
	Token string `json:"token"`
}

// handleClaimAck is POST /api/v1/enrollments/{id}/claim/ack: the
// client confirms it has PERSISTED the credentials from its claim by
// presenting the token it saved. The ack lands only if that token is
// still the current one — if a newer claim rotated it in the meantime
// the ack fails with 409 stale_claim and the client must claim again
// and ack the newest credentials. After a successful ack the claim is
// final (see handleClaimEnrollment).
func (s *Server) handleClaimAck(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req claimAckRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	if err := dec.Decode(&req); err != nil || strings.TrimSpace(req.Token) == "" {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "request body must be JSON {token} with the token from the claim response")
		return
	}
	enr, err := s.store.AckClaim(id, hashToken(strings.TrimSpace(req.Token)))
	if err != nil {
		switch {
		case errors.Is(err, ErrNotFound):
			writeAPIError(w, http.StatusNotFound, "enrollment_not_found", "no such enrollment")
		case errors.Is(err, ErrNotClaimed):
			writeAPIError(w, http.StatusConflict, "not_claimed", "no credentials have been claimed for this enrollment yet")
		case errors.Is(err, ErrStaleClaim):
			writeAPIError(w, http.StatusConflict, "stale_claim", "a newer claim superseded this token; claim again and confirm the newest credentials")
		default:
			writeAPIError(w, http.StatusInternalServerError, "internal", "could not confirm the claim")
		}
		return
	}
	log.Printf("enrollment %s: claim confirmed by client (credentials persisted)", enr.ID)
	writeJSON(w, http.StatusOK, s.enrollmentViewOf(enr))
}

// handleCheckoutComplete is GET /checkout/complete: the static page
// Stripe returns the browser to after hosted Checkout (success_url /
// cancel_url). It ONLY reports where things stand and tells the user
// to go back to the HomeMCP app — it never issues, rotates or consumes
// credentials, so refreshing it (or a mail/link scanner prefetching
// it) is harmless. The app itself learns the outcome by polling the
// enrollment status and claiming over the API.
func (s *Server) handleCheckoutComplete(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	heading := "Return to the HomeMCP app"
	message := "You can close this tab and return to the HomeMCP app to check your signup status."
	if q.Get("checkout") == "cancelled" {
		heading = "Checkout cancelled"
		message = "No charge was made. You can close this tab, return to the HomeMCP app, and try again whenever you're ready."
	} else if enr, ok := s.store.GetEnrollment(q.Get("enrollment")); ok {
		switch enr.Status {
		case EnrollmentReady, EnrollmentClaimed:
			heading = "Payment received"
			message = "Your tunnel is ready. Close this tab and return to the HomeMCP app — it will finish setting up automatically."
		case EnrollmentPendingPayment:
			heading = "Payment is being confirmed"
			message = "Stripe is still confirming your payment. Close this tab and return to the HomeMCP app — it will continue automatically once the confirmation lands."
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>HomeMCP Tunnel</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3em auto; max-width: 34em; padding: 0 1em; line-height: 1.5;">
<h1>%s</h1>
<p>%s</p>
</body>
</html>
`, html.EscapeString(heading), html.EscapeString(message))
}

// renderFRPCConfig produces the ready-to-use frpc.toml a client receives
// at claim time. The shared bootstrap token is intentionally a named
// placeholder: frps checks it, tunneld never knows it, and the HomeMCP
// app ships it embedded in its own config (it is printed in
// frpc.example.toml the same way). The per-user metas.token below is the
// credential the plugin enforces.
func (s *Server) renderFRPCConfig(u User, token string) string {
	return fmt.Sprintf(`# HomeMCP tunnel client config for %s — keep this file private.
serverAddr = %q
serverPort = %d
user = %q

# Shared bootstrap token: verified by frps itself. The HomeMCP app fills
# this in from its embedded value; it is NOT your personal credential.
auth.method = "token"
auth.token = "BOOTSTRAP_TOKEN_EMBEDDED_IN_HOMEMCP_APP"

# Your personal credential: verified by the tunneld plugin on Login and
# on every proxy registration. Losing it means contacting support — the
# server stores only a hash and cannot show it again.
metadatas.token = %q

transport.tls.enable = true

[[proxies]]
name = "homemcp"
type = "https"
customDomains = [%q]
localIP = "127.0.0.1"
localPort = 8443
# localPort must serve HTTPS with a publicly trusted certificate for
# %s. TLS is terminated here, on your machine — never on the relay.
`, u.Username, s.cfg.FRPSAddr, s.cfg.FRPSPort, u.Username, token, u.Subdomain, u.Subdomain)
}

// bearerUser authenticates Authorization: Bearer <per-user token>.
func (s *Server) bearerUser(w http.ResponseWriter, r *http.Request) (User, bool) {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized", "missing bearer token")
		return User{}, false
	}
	token := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	if token == "" {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized", "empty bearer token")
		return User{}, false
	}
	u, ok := s.store.FindUserByTokenHash(hashToken(token))
	if !ok {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized", "invalid token")
		return User{}, false
	}
	return u, true
}

type accountView struct {
	Username         string `json:"username"`
	Subdomain        string `json:"subdomain"`
	Plan             string `json:"plan"`
	SubStatus        string `json:"sub_status"`
	Mock             bool   `json:"mock,omitempty"`               // operator-granted account, no real payment
	CurrentPeriodEnd string `json:"current_period_end,omitempty"` // RFC3339, when known
	TrialEnd         string `json:"trial_end,omitempty"`          // set only while trialing, when known
	GraceUntil       string `json:"grace_until,omitempty"`        // set only while past_due
	TunnelAllowed    bool   `json:"tunnel_allowed"`
}

func accountViewOf(u User) accountView {
	allowed, _ := subscriptionAllows(u, time.Now().UTC())
	v := accountView{
		Username:      u.Username,
		Subdomain:     u.Subdomain,
		Plan:          u.Plan,
		SubStatus:     u.SubStatus,
		Mock:          u.Mock,
		TunnelAllowed: allowed,
	}
	if !u.CurrentPeriodEnd.IsZero() {
		v.CurrentPeriodEnd = u.CurrentPeriodEnd.Format(time.RFC3339)
	}
	if u.SubStatus == SubStatusTrialing && !u.TrialEnd.IsZero() {
		v.TrialEnd = u.TrialEnd.Format(time.RFC3339)
	}
	if u.SubStatus == SubStatusPastDue && !u.GraceUntil.IsZero() {
		v.GraceUntil = u.GraceUntil.Format(time.RFC3339)
	}
	return v
}

// handleGetAccount is GET /api/v1/account (Bearer per-user token).
func (s *Server) handleGetAccount(w http.ResponseWriter, r *http.Request) {
	u, ok := s.bearerUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, accountViewOf(u))
}

// handlePortal is POST /api/v1/account/portal (Bearer): a Stripe Billing
// Portal session URL for self-service card updates and cancellation.
func (s *Server) handlePortal(w http.ResponseWriter, r *http.Request) {
	u, ok := s.bearerUser(w, r)
	if !ok {
		return
	}
	if s.cfg.StripeSecretKey == "" {
		writeAPIError(w, http.StatusServiceUnavailable, "stripe_not_configured", "billing is not configured on this server yet")
		return
	}
	if u.StripeCustomerID == "" {
		writeAPIError(w, http.StatusConflict, "no_billing_account", "this account has no billing profile yet")
		return
	}
	url, err := s.createPortalSession(u.StripeCustomerID)
	if err != nil {
		log.Printf("create portal session for user %q: %v", u.Username, err)
		writeAPIError(w, http.StatusBadGateway, "stripe_error", "payment provider could not create a portal session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

type adminUserView struct {
	Username             string `json:"username"`
	Subdomain            string `json:"subdomain"`
	Plan                 string `json:"plan"`
	SubStatus            string `json:"sub_status"`
	Mock                 bool   `json:"mock,omitempty"` // activated without a real payment
	StripeCustomerID     string `json:"stripe_customer_id,omitempty"`
	StripeSubscriptionID string `json:"stripe_subscription_id,omitempty"`
	CurrentPeriodEnd     string `json:"current_period_end,omitempty"`
	TrialEnd             string `json:"trial_end,omitempty"`
	GraceUntil           string `json:"grace_until,omitempty"`
	CreatedAt            string `json:"created_at"`
}

// requireAdmin enforces the X-Admin-Key gate shared by the admin API
// and the mock-pay test hooks. On failure it writes the error response
// (503 admin_disabled when no key is configured, 401 unauthorized on a
// missing/wrong key) and returns false.
func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.AdminKey == "" {
		writeAPIError(w, http.StatusServiceUnavailable, "admin_disabled", "admin API is disabled (no TUNNELD_ADMIN_KEY set)")
		return false
	}
	got := r.Header.Get("X-Admin-Key")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.AdminKey)) != 1 {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized", "invalid admin key")
		return false
	}
	return true
}

// handleAdminUsers is GET /api/v1/admin/users (X-Admin-Key). Token
// hashes are never exposed — the view struct simply has no field for them.
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	users := s.store.ListUsers()
	views := make([]adminUserView, 0, len(users))
	for _, u := range users {
		v := adminUserView{
			Username:             u.Username,
			Subdomain:            u.Subdomain,
			Plan:                 u.Plan,
			SubStatus:            u.SubStatus,
			Mock:                 u.Mock,
			StripeCustomerID:     u.StripeCustomerID,
			StripeSubscriptionID: u.StripeSubscriptionID,
			CreatedAt:            u.CreatedAt.Format(time.RFC3339),
		}
		if !u.CurrentPeriodEnd.IsZero() {
			v.CurrentPeriodEnd = u.CurrentPeriodEnd.Format(time.RFC3339)
		}
		if !u.TrialEnd.IsZero() {
			v.TrialEnd = u.TrialEnd.Format(time.RFC3339)
		}
		if !u.GraceUntil.IsZero() {
			v.GraceUntil = u.GraceUntil.Format(time.RFC3339)
		}
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": views})
}

// handleAdminResetCredentials is POST
// /api/v1/admin/users/{username}/reset-credentials (X-Admin-Key). It
// is the credential-recovery path for hash-only storage: the stored
// token can never be shown again, so recovery means ROTATION — a
// fresh token is generated, its hash replaces the old one (the old
// token dies immediately), and the new credentials are returned once,
// in this admin response, for the operator to relay to the user
// through a trusted channel. The HomeMCP client then stores the new
// token and reconnects; nothing else about the account changes.
func (s *Server) handleAdminResetCredentials(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	username := r.PathValue("username")
	if _, ok := s.store.GetUser(username); !ok {
		writeAPIError(w, http.StatusNotFound, "user_not_found", "no such user")
		return
	}
	token, err := generateToken()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not generate credentials")
		return
	}
	user, err := s.store.RotateUserToken(username, hashToken(token))
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not rotate credentials")
		return
	}
	log.Printf("admin: credentials reset for user %q (old token invalidated)", username)
	writeJSON(w, http.StatusOK, credentialsView{
		Username:   user.Username,
		Token:      token,
		Subdomain:  user.Subdomain,
		FRPCConfig: s.renderFRPCConfig(user, token),
	})
}

// handleAdminDeleteUser is DELETE /api/v1/admin/users/{username}
// (X-Admin-Key): complete cleanup of a MOCK (test) account — the
// user, its enrollments and its DNS challenges are removed, and any
// still-active challenge TXT records are deleted at the provider.
// The username can then be enrolled again from a clean slate. The
// mock allowlist entry is deliberately KEPT (re-enrollment stays
// payment-free); removing it is the separate
// DELETE /api/v1/admin/mock-users/{username} endpoint. Real (paying)
// accounts are refused with 409 not_mock_account: deleting one is a
// billing operation, not test hygiene.
func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	username := r.PathValue("username")
	u, ok := s.store.GetUser(username)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "user_not_found", "no such user")
		return
	}
	if !u.Mock {
		writeAPIError(w, http.StatusConflict, "not_mock_account", "only mock (test) accounts can be deleted via the API")
		return
	}
	if err := s.deleteAccountFully(r, username); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not delete user")
		return
	}
	log.Printf("admin: mock user %q deleted (account, enrollments, challenges cleaned up)", username)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": username})
}

// deleteAccountFully removes a user with all its state and
// best-effort deletes any still-active challenge TXT records at the
// DNS provider. Shared by the admin delete and the self-delete.
func (s *Server) deleteAccountFully(r *http.Request, username string) error {
	_, active, err := s.store.DeleteUser(username)
	if err != nil {
		return err
	}
	if s.cfg.CertDNSConfigured() {
		for _, ch := range active {
			if ch.CFRecordID != "" {
				// The account is gone either way; a leftover TXT
				// also expires with the record's TTL.
				_ = s.cfClient().deleteRecord(r.Context(), ch.CFRecordID)
			}
		}
	}
	return nil
}

// handleDeleteAccount is DELETE /api/v1/account (Bearer per-user
// token): a MOCK (test) account deleting ITSELF. Client development
// uses it to wipe a test account after a run — token, enrollments and
// challenges all go, and the username can immediately be enrolled
// again from a clean slate (the mock allowlist entry, an operator
// setting, is not the account's to remove and stays). Real accounts
// are refused with 409 not_mock_account: a paying user's exit path
// is cancelling in the billing portal, after which the webhook
// lifecycle closes the tunnel — self-service hard deletion of
// billing accounts is deliberately not offered.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	u, ok := s.bearerUser(w, r)
	if !ok {
		return
	}
	if !u.Mock {
		writeAPIError(w, http.StatusConflict, "not_mock_account", "only mock (test) accounts can delete themselves")
		return
	}
	if err := s.deleteAccountFully(r, u.Username); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not delete account")
		return
	}
	log.Printf("mock account %q self-deleted (test cleanup)", u.Username)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": u.Username})
}
