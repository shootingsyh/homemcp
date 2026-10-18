package main

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// GracePeriod is how long a past_due subscriber keeps tunnel access after a
// failed payment before the frp plugin starts rejecting their logins.
const GracePeriod = 3 * 24 * time.Hour

// Config holds all runtime configuration for tunneld. Everything is sourced
// from environment variables so the same binary runs on a bare host, in a
// container, and in tests.
//
// Note on the FRP bootstrap token: tunneld deliberately does NOT know it.
// The shared bootstrap token (FRP_TOKEN in .env) is checked by frps itself
// (auth.token / privilege key) before the plugin is ever called. tunneld
// enforces the *per-user* credential that frpc carries in metas.token.
// Keeping the bootstrap token out of tunneld means a tunneld compromise
// alone does not yield a working frpc credential set, and vice versa.
type Config struct {
	// ListenAddr is where tunneld serves the plugin endpoint, the public
	// API and the Stripe webhook. Default binds localhost only; in the
	// docker-compose deployment it is 0.0.0.0:7200 *inside* the compose
	// network with no published ports (see docker-compose.yml).
	ListenAddr string
	// StorePath is the JSON user store file (see store.go).
	StorePath string
	// TunnelDomain is the parent domain for user subdomains:
	// <username>.<TunnelDomain>.
	TunnelDomain string
	// APIPublicBase is the public base URL of this API, used to build
	// Stripe success/cancel/return URLs. No trailing slash.
	APIPublicBase string
	// AdminKey gates GET /api/v1/admin/users via the X-Admin-Key header.
	// Empty disables the admin endpoint entirely.
	AdminKey string

	// MockPay enables the internal mock payment provider
	// (TUNNELD_MOCK_PAY=1/true): enrollments return a local
	// /mock-pay/<enrollment_id> checkout URL instead of a Stripe
	// Checkout Session, and admin-only subscription-event hooks are
	// registered for client development. It takes precedence over
	// Stripe when both are set. NEVER enable in production — anyone
	// holding an enrollment link can self-activate for free.
	MockPay bool

	// FRPSAddr / FRPSPort locate the frps control port for the frpc
	// configs tunneld hands to clients at claim time.
	FRPSAddr string
	FRPSPort int

	// Stripe. All empty in phase 1 (owner-only frps); enrollment then
	// returns 503 stripe_not_configured.
	StripeSecretKey     string
	StripeWebhookSecret string
	StripePriceAnnual   string // $9.99/year, 7-day trial, card collected upfront
	StripePriceMonthly  string // $0.99/month, no trial, charged immediately
	// StripeAPIBase is overridable for tests; production is api.stripe.com.
	StripeAPIBase string

	// BandwidthLimit is the per-user frp bandwidth cap rewritten into
	// every accepted NewProxy (frp syntax, e.g. "10MB", "512KB").
	// Enforced server-side (bandwidth_limit_mode=server). Empty string
	// disables the rewrite (not recommended for multi-tenant use).
	BandwidthLimit string
}

// LoadConfig reads configuration from the process environment.
func LoadConfig() Config {
	return LoadConfigFrom(os.Getenv)
}

// LoadConfigFrom is LoadConfig with an injectable env lookup (tests).
func LoadConfigFrom(getenv func(string) string) Config {
	cfg := Config{
		ListenAddr:          envOr(getenv, "TUNNELD_LISTEN", "127.0.0.1:7200"),
		StorePath:           envOr(getenv, "TUNNELD_STORE_PATH", "tunneld.json"),
		TunnelDomain:        envOr(getenv, "TUNNEL_DOMAIN", "tunnel.homemcp.si"),
		APIPublicBase:       strings.TrimRight(envOr(getenv, "API_PUBLIC_BASE", "https://api.homemcp.si"), "/"),
		AdminKey:            getenv("TUNNELD_ADMIN_KEY"),
		MockPay:             parseBoolEnv(getenv("TUNNELD_MOCK_PAY")),
		StripeSecretKey:     getenv("STRIPE_SECRET_KEY"),
		StripeWebhookSecret: getenv("STRIPE_WEBHOOK_SECRET"),
		StripePriceAnnual:   getenv("STRIPE_PRICE_ANNUAL"),
		StripePriceMonthly:  getenv("STRIPE_PRICE_MONTHLY"),
		StripeAPIBase:       strings.TrimRight(envOr(getenv, "STRIPE_API_BASE", "https://api.stripe.com"), "/"),
		BandwidthLimit:      envOr(getenv, "USER_BANDWIDTH_LIMIT", "10MB"),
	}
	cfg.FRPSAddr = envOr(getenv, "FRPS_ADDR", cfg.TunnelDomain)
	cfg.FRPSPort = 7000
	if v := getenv("FRPS_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			cfg.FRPSPort = n
		}
	}
	return cfg
}

func envOr(getenv func(string) string, key, def string) string {
	if v := getenv(key); v != "" {
		return v
	}
	return def
}

// parseBoolEnv interprets the small set of truthy env spellings tunneld
// accepts ("1", "true", case-insensitive). Everything else is false.
func parseBoolEnv(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true":
		return true
	}
	return false
}

// StripeConfigured reports whether checkout can be created at all.
func (c Config) StripeConfigured() bool {
	return c.StripeSecretKey != "" && c.StripePriceAnnual != "" && c.StripePriceMonthly != ""
}

// PriceFor returns the configured Stripe price ID for a plan.
func (c Config) PriceFor(plan string) string {
	switch plan {
	case PlanAnnual:
		return c.StripePriceAnnual
	case PlanMonthly:
		return c.StripePriceMonthly
	}
	return ""
}

// SubdomainFor returns the fully qualified tunnel hostname for a username.
func (c Config) SubdomainFor(username string) string {
	return username + "." + c.TunnelDomain
}
