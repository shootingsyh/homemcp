package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Stripe integration via the raw REST API (form-encoded), standard
// library only. tunneld talks to Stripe for exactly three things:
// creating Checkout Sessions (enrollment), creating Billing Portal
// sessions (self-service plan management), and reading a subscription
// when a webhook needs its authoritative status. Webhooks are the only
// inbound coupling: Stripe -> POST /webhooks/stripe.
//
// Everything degrades gracefully without keys: when Stripe is not
// configured the enrollment endpoint answers 503 stripe_not_configured
// and frps keeps working standalone (phase 1, owner-only).
//
// Secrets come from the environment only (STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET) and are never logged or persisted.

type stripeClient struct {
	secret string
	base   string
	http   *http.Client
}

func newStripeClient(cfg Config) *stripeClient {
	return &stripeClient{
		secret: cfg.StripeSecretKey,
		base:   cfg.StripeAPIBase,
		http:   &http.Client{Timeout: 20 * time.Second},
	}
}

// stripeSubscription is the subset of a Stripe Subscription we consume.
type stripeSubscription struct {
	ID               string
	Status           string
	CustomerID       string
	CurrentPeriodEnd time.Time
}

type stripeError struct {
	Status  int
	Message string
}

func (e *stripeError) Error() string {
	return fmt.Sprintf("stripe: HTTP %d: %s", e.Status, e.Message)
}

func (c *stripeClient) do(req *http.Request) (map[string]any, error) {
	req.Header.Set("Authorization", "Bearer "+c.secret)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("stripe: request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("stripe: HTTP %d: unparseable response", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := ""
		if e, ok := obj["error"].(map[string]any); ok {
			msg, _ = e["message"].(string)
		}
		return nil, &stripeError{Status: resp.StatusCode, Message: msg}
	}
	return obj, nil
}

func (c *stripeClient) postForm(path string, form url.Values) (map[string]any, error) {
	req, err := http.NewRequest(http.MethodPost, c.base+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return c.do(req)
}

func (c *stripeClient) get(path string) (map[string]any, error) {
	req, err := http.NewRequest(http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	return c.do(req)
}

// createCheckoutSession builds the hosted Checkout Session for an
// enrollment. Pricing rules (set by the operator, 2026-10):
//   - annual ($9.99/yr): 7-day free trial via
//     subscription_data.trial_period_days=7, and
//     payment_method_collection=always so a card is on file *before*
//     the trial starts and converts automatically.
//   - monthly ($0.99/mo): no trial; the card is charged immediately
//     (Stripe's default collection behaviour for a paid session).
//
// client_reference_id carries the enrollment ID so the
// checkout.session.completed webhook can find the enrollment without
// tunneld keeping any session state of its own.
func (s *Server) createCheckoutSession(e Enrollment) (sessionID, checkoutURL string, err error) {
	cfg := s.cfg
	form := url.Values{}
	form.Set("mode", "subscription")
	form.Set("client_reference_id", e.ID)
	form.Set("metadata[enrollment_id]", e.ID)
	form.Set("line_items[0][price]", cfg.PriceFor(e.Plan))
	form.Set("line_items[0][quantity]", "1")
	landing := cfg.APIPublicBase + "/api/v1/enrollments/" + e.ID
	form.Set("success_url", landing+"?checkout=success")
	form.Set("cancel_url", landing+"?checkout=cancelled")
	switch e.Plan {
	case PlanAnnual:
		form.Set("subscription_data[trial_period_days]", "7")
		form.Set("payment_method_collection", "always")
	case PlanMonthly:
		// No trial: leave payment_method_collection at Stripe's default
		// (collect and charge now).
	}
	obj, err := s.stripe.postForm("/v1/checkout/sessions", form)
	if err != nil {
		return "", "", err
	}
	id, _ := obj["id"].(string)
	u, _ := obj["url"].(string)
	if id == "" || u == "" {
		return "", "", fmt.Errorf("stripe: checkout session response missing id/url")
	}
	return id, u, nil
}

// createPortalSession returns a Stripe Billing Portal URL so the user
// can update their card / cancel without tunneld handling card data.
func (s *Server) createPortalSession(customerID string) (string, error) {
	form := url.Values{}
	form.Set("customer", customerID)
	form.Set("return_url", s.cfg.APIPublicBase+"/api/v1/account")
	obj, err := s.stripe.postForm("/v1/billing_portal/sessions", form)
	if err != nil {
		return "", err
	}
	u, _ := obj["url"].(string)
	if u == "" {
		return "", fmt.Errorf("stripe: portal session response missing url")
	}
	return u, nil
}

// fetchSubscription reads a subscription's authoritative state.
func (s *Server) fetchSubscription(id string) (stripeSubscription, error) {
	obj, err := s.stripe.get("/v1/subscriptions/" + url.PathEscape(id))
	if err != nil {
		return stripeSubscription{}, err
	}
	return parseSubscription(obj), nil
}

// parseSubscription extracts the fields tunneld needs. current_period_end
// lives at the top level in older API versions and on the first
// subscription item in newer ones (2025+); accept both.
func parseSubscription(obj map[string]any) stripeSubscription {
	sub := stripeSubscription{}
	sub.ID, _ = obj["id"].(string)
	sub.Status, _ = obj["status"].(string)
	sub.CustomerID, _ = obj["customer"].(string)
	if v, ok := unixField(obj["current_period_end"]); ok {
		sub.CurrentPeriodEnd = v
		return sub
	}
	if items, ok := obj["items"].(map[string]any); ok {
		if data, ok := items["data"].([]any); ok && len(data) > 0 {
			if first, ok := data[0].(map[string]any); ok {
				if v, ok := unixField(first["current_period_end"]); ok {
					sub.CurrentPeriodEnd = v
				}
			}
		}
	}
	return sub
}

func unixField(v any) (time.Time, bool) {
	f, ok := v.(float64)
	if !ok || f <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(f), 0).UTC(), true
}

// mapStripeStatus translates a Stripe subscription status into the
// tunneld/client-contract status vocabulary.
func mapStripeStatus(stripeStatus string) string {
	switch stripeStatus {
	case "trialing":
		return SubStatusTrialing
	case "active":
		return SubStatusActive
	case "past_due", "unpaid", "paused":
		return SubStatusPastDue
	case "canceled", "incomplete_expired":
		return SubStatusCanceled
	case "incomplete":
		return SubStatusPending
	default:
		return SubStatusPending
	}
}

// verifyStripeSignature validates a Stripe-Signature header against the
// raw request body: v1 = HMAC-SHA256(webhookSecret, "<t>.<payload>"),
// with a timestamp tolerance (Stripe's own recommendation: 5 minutes).
// The raw body must be used exactly as received — any re-encoding breaks
// the signature, which the tamper tests rely on.
func verifyStripeSignature(payload []byte, header, secret string, now time.Time, tolerance time.Duration) error {
	var ts string
	var signatures []string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			ts = kv[1]
		case "v1":
			signatures = append(signatures, kv[1])
		}
	}
	if ts == "" || len(signatures) == 0 {
		return fmt.Errorf("stripe webhook: missing timestamp or v1 signature")
	}
	tUnix, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return fmt.Errorf("stripe webhook: bad timestamp")
	}
	if tolerance > 0 {
		age := now.Sub(time.Unix(tUnix, 0))
		if age > tolerance || age < -tolerance {
			return fmt.Errorf("stripe webhook: timestamp outside tolerance")
		}
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(payload)
	expected := mac.Sum(nil)
	for _, sig := range signatures {
		got, err := hex.DecodeString(sig)
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare(got, expected) == 1 {
			return nil
		}
	}
	return fmt.Errorf("stripe webhook: signature mismatch")
}

type stripeEvent struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data struct {
		Object map[string]any `json:"object"`
	} `json:"data"`
}

// handleStripeWebhook is POST /webhooks/stripe. tunneld stores no event
// log; each handler below is an idempotent state assignment, so Stripe
// redeliveries are harmless.
func (s *Server) handleStripeWebhook(w http.ResponseWriter, r *http.Request) {
	if s.cfg.StripeWebhookSecret == "" {
		writeAPIError(w, http.StatusServiceUnavailable, "stripe_not_configured", "Stripe webhooks are not configured on this server")
		return
	}
	payload, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "could not read request body")
		return
	}
	if err := verifyStripeSignature(payload, r.Header.Get("Stripe-Signature"), s.cfg.StripeWebhookSecret, time.Now().UTC(), 5*time.Minute); err != nil {
		log.Printf("stripe webhook rejected: %v", err)
		writeAPIError(w, http.StatusBadRequest, "invalid_signature", "webhook signature verification failed")
		return
	}
	var ev stripeEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "malformed event JSON")
		return
	}
	// Never log the payload: events carry customer/billing identifiers.
	log.Printf("stripe webhook received type=%s id=%s", ev.Type, ev.ID)
	switch ev.Type {
	case "checkout.session.completed":
		s.onCheckoutSessionCompleted(ev.Data.Object)
	case "invoice.paid":
		s.onInvoicePaid(ev.Data.Object)
	case "invoice.payment_failed":
		s.onInvoicePaymentFailed(ev.Data.Object)
	case "customer.subscription.created", "customer.subscription.updated":
		s.onSubscriptionSync(ev.Data.Object)
	case "customer.subscription.deleted":
		s.onSubscriptionDeleted(ev.Data.Object)
	default:
		// Ignored by design; still 200 so Stripe does not retry.
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": true})
}

func strField(obj map[string]any, key string) string {
	v, _ := obj[key].(string)
	return v
}

// onCheckoutSessionCompleted links an enrollment to the Stripe customer
// and subscription, creates the user record, and marks the enrollment
// claimable. The user's subscription status comes from the subscription
// object itself (fetched fresh); if that fetch fails we fall back to the
// session's payment_status (paid -> active, no_payment_required ->
// trialing, which is exactly the annual-trial case).
func (s *Server) onCheckoutSessionCompleted(obj map[string]any) {
	enrollmentID := strField(obj, "client_reference_id")
	if enrollmentID == "" {
		if md, ok := obj["metadata"].(map[string]any); ok {
			enrollmentID = strField(md, "enrollment_id")
		}
	}
	enr, ok := s.store.GetEnrollment(enrollmentID)
	if !ok {
		log.Printf("stripe webhook: checkout completed for unknown enrollment %q", enrollmentID)
		return
	}
	customerID := strField(obj, "customer")
	subscriptionID := strField(obj, "subscription")

	if _, err := s.store.EnsureUser(enr.Username, enr.Plan, s.cfg.SubdomainFor(enr.Username)); err != nil {
		log.Printf("stripe webhook: ensure user %q: %v", enr.Username, err)
		return
	}

	status := ""
	var periodEnd time.Time
	if subscriptionID != "" && s.cfg.StripeSecretKey != "" {
		if sub, err := s.fetchSubscription(subscriptionID); err == nil {
			status = mapStripeStatus(sub.Status)
			periodEnd = sub.CurrentPeriodEnd
			if customerID == "" {
				customerID = sub.CustomerID
			}
		} else {
			log.Printf("stripe webhook: fetch subscription %s: %v", subscriptionID, err)
		}
	}
	if status == "" {
		switch strField(obj, "payment_status") {
		case "paid":
			status = SubStatusActive
		case "no_payment_required":
			status = SubStatusTrialing
		default:
			status = SubStatusPending
		}
	}

	if err := s.store.UpdateUser(enr.Username, func(u *User) {
		u.StripeCustomerID = customerID
		u.StripeSubscriptionID = subscriptionID
		u.SubStatus = status
		if !periodEnd.IsZero() {
			u.CurrentPeriodEnd = periodEnd
		}
		if status == SubStatusActive || status == SubStatusTrialing {
			u.GraceUntil = time.Time{}
		}
	}); err != nil {
		log.Printf("stripe webhook: update user %q: %v", enr.Username, err)
		return
	}
	if err := s.store.UpdateEnrollment(enr.ID, func(e *Enrollment) {
		e.StripeCheckoutSessionID = strField(obj, "id")
		e.Status = EnrollmentReady
	}); err != nil {
		log.Printf("stripe webhook: update enrollment %q: %v", enr.ID, err)
	}
}

// resolveUserForInvoice finds the user for an invoice event. Invoices
// always carry the customer; the subscription ID is present on older API
// versions (and nested under parent.subscription_details on newer ones),
// so the stored customer->user link is the reliable path.
func (s *Server) resolveUserForInvoice(obj map[string]any) (User, bool) {
	if subID := invoiceSubscriptionID(obj); subID != "" {
		if u, ok := s.store.FindUserBySubscription(subID); ok {
			return u, true
		}
	}
	customerID := strField(obj, "customer")
	if customerID == "" {
		return User{}, false
	}
	return s.store.FindUserByCustomer(customerID)
}

func invoiceSubscriptionID(obj map[string]any) string {
	if v := strField(obj, "subscription"); v != "" {
		return v
	}
	if parent, ok := obj["parent"].(map[string]any); ok {
		if details, ok := parent["subscription_details"].(map[string]any); ok {
			return strField(details, "subscription")
		}
	}
	return ""
}

// syncPeriodEnd fetches the subscription and refreshes the user's period
// end + status mapping. Best effort: failures leave stored state intact.
func (s *Server) syncFromSubscription(u User) {
	if u.StripeSubscriptionID == "" || s.cfg.StripeSecretKey == "" {
		return
	}
	sub, err := s.fetchSubscription(u.StripeSubscriptionID)
	if err != nil {
		log.Printf("stripe: fetch subscription %s for user %q: %v", u.StripeSubscriptionID, u.Username, err)
		return
	}
	status := mapStripeStatus(sub.Status)
	_ = s.store.UpdateUser(u.Username, func(x *User) {
		x.SubStatus = status
		if !sub.CurrentPeriodEnd.IsZero() {
			x.CurrentPeriodEnd = sub.CurrentPeriodEnd
		}
		switch status {
		case SubStatusActive, SubStatusTrialing:
			x.GraceUntil = time.Time{}
		case SubStatusPastDue:
			if x.GraceUntil.IsZero() {
				x.GraceUntil = time.Now().UTC().Add(GracePeriod)
			}
		}
	})
}

// onInvoicePaid: subscription is current again — active, grace cleared.
func (s *Server) onInvoicePaid(obj map[string]any) {
	u, ok := s.resolveUserForInvoice(obj)
	if !ok {
		log.Printf("stripe webhook: invoice.paid for unknown customer")
		return
	}
	_ = s.store.UpdateUser(u.Username, func(x *User) {
		x.SubStatus = SubStatusActive
		x.GraceUntil = time.Time{}
	})
	s.syncFromSubscription(u)
}

// onInvoicePaymentFailed: past_due with a 3-day grace window.
func (s *Server) onInvoicePaymentFailed(obj map[string]any) {
	u, ok := s.resolveUserForInvoice(obj)
	if !ok {
		log.Printf("stripe webhook: invoice.payment_failed for unknown customer")
		return
	}
	_ = s.store.UpdateUser(u.Username, func(x *User) {
		x.SubStatus = SubStatusPastDue
		x.GraceUntil = time.Now().UTC().Add(GracePeriod)
	})
}

// onSubscriptionSync mirrors customer.subscription.{created,updated}.
func (s *Server) onSubscriptionSync(obj map[string]any) {
	sub := parseSubscription(obj)
	u, ok := s.store.FindUserBySubscription(sub.ID)
	if !ok && sub.CustomerID != "" {
		u, ok = s.store.FindUserByCustomer(sub.CustomerID)
	}
	if !ok {
		log.Printf("stripe webhook: subscription event for unknown subscription %q", sub.ID)
		return
	}
	status := mapStripeStatus(sub.Status)
	_ = s.store.UpdateUser(u.Username, func(x *User) {
		x.SubStatus = status
		if sub.ID != "" {
			x.StripeSubscriptionID = sub.ID
		}
		if !sub.CurrentPeriodEnd.IsZero() {
			x.CurrentPeriodEnd = sub.CurrentPeriodEnd
		}
		switch status {
		case SubStatusActive, SubStatusTrialing:
			x.GraceUntil = time.Time{}
		case SubStatusPastDue:
			if x.GraceUntil.IsZero() {
				x.GraceUntil = time.Now().UTC().Add(GracePeriod)
			}
		}
	})
}

// onSubscriptionDeleted: the subscription is gone — cut access.
func (s *Server) onSubscriptionDeleted(obj map[string]any) {
	sub := parseSubscription(obj)
	u, ok := s.store.FindUserBySubscription(sub.ID)
	if !ok && sub.CustomerID != "" {
		u, ok = s.store.FindUserByCustomer(sub.CustomerID)
	}
	if !ok {
		log.Printf("stripe webhook: subscription.deleted for unknown subscription %q", sub.ID)
		return
	}
	_ = s.store.UpdateUser(u.Username, func(x *User) {
		x.SubStatus = SubStatusCanceled
		x.GraceUntil = time.Time{}
		if !sub.CurrentPeriodEnd.IsZero() {
			x.CurrentPeriodEnd = sub.CurrentPeriodEnd
		}
	})
}
