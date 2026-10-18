package main

import (
	"encoding/json"
	"html/template"
	"log"
	"net/http"
	"strings"
	"time"
)

// Mock pay: an internal, Stripe-shaped payment stand-in for client
// development, enabled only by TUNNELD_MOCK_PAY=1 (see config.go).
//
// It exists so the HomeMCP client's registration flow can be built and
// tested before any real Stripe account exists. To keep that honest,
// mock pay is NOT a parallel billing system: the checkout page finishes
// by calling the same activateEnrollment funnel a Stripe
// checkout.session.completed webhook calls, and the subscription-event
// hook drives the same markUser* transitions the webhook handlers use.
// Everything downstream — claim, account view, plugin gate — is the
// production code path, exercised unchanged.
//
// Endpoints (registered only in mock mode; 404 otherwise):
//
//	GET  /mock-pay/{enrollment_id}                mock checkout page
//	POST /mock-pay/{enrollment_id}                "pay" -> activate
//	POST /api/v1/mock/users/{username}/subscription-event
//	                                              admin-only test hook
//
// SECURITY: anyone holding an enrollment link can open the mock page
// and activate that account for free. That is acceptable ONLY on
// internal/dev deployments. Never enable in production (README has the
// warning in bigger letters).

// mockTrialLength mirrors the annual plan's Stripe trial
// (subscription_data.trial_period_days=7 on the real checkout).
const mockTrialLength = 7 * 24 * time.Hour

type mockPayView struct {
	Username   string
	Subdomain  string
	PlanTitle  string // "Annual plan" / "Monthly plan"
	PriceLine  string // "$9.99 / year" / "$0.99 / month"
	DetailLine string // trial / immediate-charge wording
	Done       bool   // payment already completed (incl. this POST)
	JustPaid   bool   // this very POST performed the activation
	SubStatus  string // after activation
	TrialEnd   string // human date, when trialing
}

var mockPayTemplate = template.Must(template.New("mockpay").Parse(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock Pay — HomeMCP Tunnel (test only)</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f6f6f4; color: #1c1c1a; }
  .banner { background: #b3261e; color: #fff; text-align: center; font-weight: 700;
            padding: 10px 12px; letter-spacing: .04em; }
  main { max-width: 30rem; margin: 2rem auto; background: #fff; border: 1px solid #ddd;
         border-radius: 12px; padding: 1.5rem; }
  .price { font-size: 1.6rem; font-weight: 700; margin: .2rem 0; }
  .muted { color: #5f5f5c; }
  .ok { background: #e6f4ea; border: 1px solid #34a853; border-radius: 8px; padding: .8rem; }
  button { background: #1c1c1a; color: #fff; border: 0; border-radius: 8px;
           font-size: 1rem; font-weight: 600; padding: .8rem 1.4rem; cursor: pointer; width: 100%; }
</style>
</head>
<body>
<div class="banner">MOCK PAY — INTERNAL TEST ONLY · NO REAL CHARGE</div>
<main>
  <h1>HomeMCP Tunnel — {{.PlanTitle}}</h1>
  <p class="price">{{.PriceLine}}</p>
  <p>{{.DetailLine}}</p>
  <p class="muted">Account: <strong>{{.Username}}</strong> · {{.Subdomain}}</p>
  {{if .Done}}
  <div class="ok">
    {{if .JustPaid}}<p><strong>Mock payment complete.</strong></p>{{else}}<p><strong>Already activated</strong> — this enrollment has already been paid (mock).</p>{{end}}
    <p>Subscription status: <strong>{{.SubStatus}}</strong>{{if .TrialEnd}} · free trial ends {{.TrialEnd}}{{end}}</p>
    <p>Return to the HomeMCP client and let it poll the enrollment — it
    will now be able to claim the account credentials.</p>
  </div>
  {{else}}
  <form method="post" action="">
    <button type="submit">Pay (mock)</button>
  </form>
  <p class="muted">This button simulates a completed Stripe Checkout.
  No card is collected and no money moves.</p>
  {{end}}
</main>
</body>
</html>
`))

func (s *Server) mockPayViewFor(enr Enrollment) mockPayView {
	v := mockPayView{
		Username:  enr.Username,
		Subdomain: s.cfg.SubdomainFor(enr.Username),
		Done:      enr.Status == EnrollmentReady || enr.Status == EnrollmentClaimed,
	}
	switch enr.Plan {
	case PlanAnnual:
		v.PlanTitle = "Annual plan"
		v.PriceLine = "$9.99 / year"
		v.DetailLine = "7-day free trial, card on file (mock) — in the real checkout a card is collected upfront and charged automatically when the trial ends."
	case PlanMonthly:
		v.PlanTitle = "Monthly plan"
		v.PriceLine = "$0.99 / month"
		v.DetailLine = "No trial — charged immediately (mock)."
	}
	if u, ok := s.store.GetUser(enr.Username); ok {
		v.SubStatus = u.SubStatus
		if !u.TrialEnd.IsZero() {
			v.TrialEnd = u.TrialEnd.Format("Jan 2, 2006")
		}
	}
	return v
}

func (s *Server) renderMockPay(w http.ResponseWriter, enr Enrollment, justPaid bool) {
	v := s.mockPayViewFor(enr)
	v.JustPaid = justPaid
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// The URL carries the enrollment capability; keep it out of caches.
	w.Header().Set("Cache-Control", "no-store")
	if err := mockPayTemplate.Execute(w, v); err != nil {
		log.Printf("mock pay: render page for enrollment %s: %v", enr.ID, err)
	}
}

// handleMockPayPage is GET /mock-pay/{id} (mock mode only).
func (s *Server) handleMockPayPage(w http.ResponseWriter, r *http.Request) {
	enr, ok := s.store.GetEnrollment(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	s.renderMockPay(w, enr, false)
}

// handleMockPaySubmit is POST /mock-pay/{id}: the "Pay (mock)" button.
// It activates a pending enrollment through activateEnrollment — the
// exact funnel the Stripe webhook uses — then re-renders the page in
// its completed state. Repeat POSTs are idempotent: an already-active
// enrollment is simply shown as activated again.
func (s *Server) handleMockPaySubmit(w http.ResponseWriter, r *http.Request) {
	enr, ok := s.store.GetEnrollment(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	justPaid := false
	if enr.Status == EnrollmentPendingPayment {
		s.activateMockEnrollment(enr)
		justPaid = true
		enr, _ = s.store.GetEnrollment(enr.ID)
	}
	s.renderMockPay(w, enr, justPaid)
}

// activateMockEnrollment computes the activation a real Stripe checkout
// would have produced for this plan and applies it via the shared
// funnel: annual starts the 7-day trial (trial_end recorded, period
// end = trial end, exactly like a trialing Stripe subscription);
// monthly is active immediately with a one-month period.
func (s *Server) activateMockEnrollment(enr Enrollment) {
	now := time.Now().UTC()
	act := activation{status: SubStatusActive, periodEnd: now.AddDate(0, 1, 0)}
	if enr.Plan == PlanAnnual {
		trialEnd := now.Add(mockTrialLength)
		act.status = SubStatusTrialing
		act.trialEnd = trialEnd
		act.periodEnd = trialEnd
	}
	s.activateEnrollment(enr, act)
}

type mockSubscriptionEventRequest struct {
	Event string `json:"event"`
}

// handleMockSubscriptionEvent is
// POST /api/v1/mock/users/{username}/subscription-event (mock mode
// only, X-Admin-Key required). It lets the client developer drive a
// user's subscription through the states real Stripe webhooks produce,
// using the same markUser* transitions:
//
//	"invoice.paid"           -> active, grace cleared
//	"invoice.payment_failed" -> past_due, grace_until = now + 3 days
//	"subscription.deleted"   -> canceled
//	"trial.end"              -> trialing becomes active (trial
//	                            conversion charge succeeded)
//
// The response is the resulting account view (same shape as
// GET /api/v1/account).
func (s *Server) handleMockSubscriptionEvent(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	username := strings.ToLower(strings.TrimSpace(r.PathValue("username")))
	u, ok := s.store.GetUser(username)
	if !ok {
		writeAPIError(w, http.StatusNotFound, "user_not_found", "no such user")
		return
	}
	var req mockSubscriptionEventRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	if err := dec.Decode(&req); err != nil {
		writeAPIError(w, http.StatusBadRequest, "bad_request", "request body must be JSON {event}")
		return
	}
	switch req.Event {
	case "invoice.paid":
		s.markUserActive(u)
	case "invoice.payment_failed":
		s.markUserPastDue(u)
	case "subscription.deleted":
		s.markUserCanceled(u, time.Time{})
	case "trial.end":
		s.markUserTrialEnded(u)
	default:
		writeAPIError(w, http.StatusUnprocessableEntity, "invalid_event",
			"event must be one of invoice.paid, invoice.payment_failed, subscription.deleted, trial.end")
		return
	}
	updated, _ := s.store.GetUser(username)
	writeJSON(w, http.StatusOK, accountViewOf(updated))
}
