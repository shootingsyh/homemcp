// Command tunneld is the control plane for the HomeMCP multi-tenant
// tunnel relay (frps). It does three things and nothing else:
//
//   - answers frps server-plugin calls (Login / NewProxy) so each tenant
//     can only connect with their own credential and only claim their
//     own <username>.tunnel.homemcp.si hostname;
//   - serves the registration/account API used by the HomeMCP client
//     (enrollment -> Stripe Checkout -> credential claim);
//   - receives Stripe webhooks and mirrors subscription state into the
//     local user store.
//
// ZERO-KNOWLEDGE INVARIANT: tunneld never sees, proxies, logs, or stores
// user tunnel traffic. The data plane is frps doing TLS passthrough
// (SNI routing only, no TLS termination for user domains), and tunneld
// is not in that path. The only payloads tunneld handles are control
// metadata (usernames, domain names, billing state) and Stripe events.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// Server bundles the shared state for all handlers.
type Server struct {
	cfg    Config
	store  *Store
	stripe *stripeClient
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		// Used by the docker-compose healthcheck: the distroless image
		// has no shell/curl, so the binary probes its own /healthz.
		os.Exit(runHealthcheck(LoadConfig()))
	}

	cfg := LoadConfig()
	store, err := OpenStore(cfg.StorePath)
	if err != nil {
		log.Fatalf("tunneld: open store: %v", err)
	}
	srv := &Server{cfg: cfg, store: store, stripe: newStripeClient(cfg)}

	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()

	log.Printf("tunneld listening on %s (tunnel domain %s, stripe configured: %v, bandwidth cap: %q)",
		cfg.ListenAddr, cfg.TunnelDomain, cfg.StripeConfigured(), cfg.BandwidthLimit)
	if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("tunneld: serve: %v", err)
	}
}

// routes builds the HTTP routing table (shared by main and tests).
func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	// frps server plugin (compose-network only; never publish this port).
	mux.HandleFunc("POST /plugin/frp", s.handleFRPPlugin)
	// Public client API (no web pages anywhere).
	mux.HandleFunc("POST /api/v1/enrollments", s.handleCreateEnrollment)
	mux.HandleFunc("GET /api/v1/enrollments/{id}", s.handleGetEnrollment)
	mux.HandleFunc("GET /api/v1/account", s.handleGetAccount)
	mux.HandleFunc("POST /api/v1/account/portal", s.handlePortal)
	mux.HandleFunc("GET /api/v1/admin/users", s.handleAdminUsers)
	// Stripe webhooks.
	mux.HandleFunc("POST /webhooks/stripe", s.handleStripeWebhook)
	// Liveness for compose/orchestrators.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

// runHealthcheck probes the local /healthz endpoint; exit 0 = healthy.
func runHealthcheck(cfg Config) int {
	_, port, err := net.SplitHostPort(cfg.ListenAddr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: bad listen addr %q\n", cfg.ListenAddr)
		return 1
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck: HTTP %d\n", resp.StatusCode)
		return 1
	}
	return 0
}
