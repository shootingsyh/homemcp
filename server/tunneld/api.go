package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Public registration/account API. There are deliberately NO web pages:
// registration lives inside the HomeMCP client; the only browser surface
// is Stripe's hosted Checkout/Billing Portal. See docs/CLIENT_CONTRACT.md
// for the wire contract this file implements.
//
// Error vocabulary (stable, machine-readable):
//   bad_request, invalid_username, username_reserved, username_taken,
//   invalid_plan, enrollment_not_found, credentials_not_ready,
//   unauthorized, no_billing_account, stripe_not_configured,
//   admin_disabled, internal.

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
// Order matters: validate first, then Stripe-config check (so an
// unconfigured server fails with 503 without squatting the username),
// then reserve the enrollment, then create the Checkout Session.
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
	if !s.cfg.StripeConfigured() {
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
	Credentials       *credentialsView `json:"credentials,omitempty"`
}

// handleGetEnrollment is GET /api/v1/enrollments/{id}. The enrollment ID
// is the claim capability: after the webhook marks the enrollment ready,
// the FIRST GET generates the per-user token, stores only its hash, and
// returns the credentials exactly once. Later GETs report status without
// the token (it is unrecoverable by design; see CLIENT_CONTRACT.md).
func (s *Server) handleGetEnrollment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	enr, ok := s.store.GetEnrollment(id)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "enrollment_not_found", "no such enrollment")
		return
	}
	view := enrollmentView{
		EnrollmentID:      enr.ID,
		Status:            enr.Status,
		Username:          enr.Username,
		Plan:              enr.Plan,
		Subdomain:         s.cfg.SubdomainFor(enr.Username),
		CredentialsIssued: enr.CredentialsIssued,
	}
	if u, ok := s.store.GetUser(enr.Username); ok {
		view.SubStatus = u.SubStatus
	}
	if enr.Status != EnrollmentReady {
		// pending_payment, or already claimed (credentials gone for good).
		writeJSON(w, http.StatusOK, view)
		return
	}
	token, err := generateToken()
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not generate credentials")
		return
	}
	_, user, err := s.store.ClaimAndIssue(enr.ID, hashToken(token))
	if err != nil {
		if errors.Is(err, ErrAlreadyClaimed) {
			// Lost a race with a concurrent claim: report claimed
			// state without credentials.
			view.Status = EnrollmentClaimed
			view.CredentialsIssued = true
			writeJSON(w, http.StatusOK, view)
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "internal", "could not issue credentials")
		return
	}
	view.Status = EnrollmentClaimed
	view.CredentialsIssued = true
	view.SubStatus = user.SubStatus
	view.Credentials = &credentialsView{
		Username:   user.Username,
		Token:      token,
		Subdomain:  user.Subdomain,
		FRPCConfig: s.renderFRPCConfig(user, token),
	}
	writeJSON(w, http.StatusOK, view)
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
	CurrentPeriodEnd string `json:"current_period_end,omitempty"` // RFC3339, when known
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
		TunnelAllowed: allowed,
	}
	if !u.CurrentPeriodEnd.IsZero() {
		v.CurrentPeriodEnd = u.CurrentPeriodEnd.Format(time.RFC3339)
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
	StripeCustomerID     string `json:"stripe_customer_id,omitempty"`
	StripeSubscriptionID string `json:"stripe_subscription_id,omitempty"`
	CurrentPeriodEnd     string `json:"current_period_end,omitempty"`
	GraceUntil           string `json:"grace_until,omitempty"`
	CreatedAt            string `json:"created_at"`
}

// handleAdminUsers is GET /api/v1/admin/users (X-Admin-Key). Token
// hashes are never exposed — the view struct simply has no field for them.
func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AdminKey == "" {
		writeAPIError(w, http.StatusServiceUnavailable, "admin_disabled", "admin API is disabled (no TUNNELD_ADMIN_KEY set)")
		return
	}
	got := r.Header.Get("X-Admin-Key")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.AdminKey)) != 1 {
		writeAPIError(w, http.StatusUnauthorized, "unauthorized", "invalid admin key")
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
			StripeCustomerID:     u.StripeCustomerID,
			StripeSubscriptionID: u.StripeSubscriptionID,
			CreatedAt:            u.CreatedAt.Format(time.RFC3339),
		}
		if !u.CurrentPeriodEnd.IsZero() {
			v.CurrentPeriodEnd = u.CurrentPeriodEnd.Format(time.RFC3339)
		}
		if !u.GraceUntil.IsZero() {
			v.GraceUntil = u.GraceUntil.Format(time.RFC3339)
		}
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": views})
}
