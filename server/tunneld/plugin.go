package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// frps server-plugin endpoint.
//
// Protocol implemented against frp v0.68.0 source (pkg/plugin/server):
//   - frps POSTs JSON {"version":"0.1.0","op":"Login"|"NewProxy","content":{...}}
//     to {httpPlugins.addr}{httpPlugins.path}?version=0.1.0&op=<Op>
//     (source: pkg/plugin/server/http.go, plugin.go: APIVersion = "0.1.0").
//   - The plugin must answer HTTP 200 with
//     {"reject":bool,"reject_reason":string,"unchange":bool,"content":object}.
//     reject=true fails the operation with reject_reason shown to frpc.
//     unchange=false makes frps parse "content" back into the operation's
//     content struct and use it in place of the original (manager.go).
//   - Login content is msg.Login flattened (fields: user, metas, run_id,
//     hostname, ...) plus client_address (pkg/plugin/server/types.go:
//     LoginContent). The per-user credential rides in content.metas.token;
//     content.user is the frpc "user" field (the tenant username).
//   - NewProxy content is {"user":{user,metas,run_id}, ...msg.NewProxy
//     flattened}: proxy_name, proxy_type, custom_domains, subdomain,
//     remote_port, bandwidth_limit, bandwidth_limit_mode, ...
//
// ZERO-KNOWLEDGE NOTE: these payloads are pure control-plane metadata —
// usernames, proxy names, domain names, limits. No byte of user tunnel
// traffic ever reaches tunneld: frps routes TLS by SNI and forwards the
// opaque stream straight to frpc. tunneld is not in that path at all.
// Do not add logging of request bodies here beyond op + username +
// decision; never log metas (it carries the per-user token).

const frpPluginAPIVersion = "0.1.0"

type pluginRequest struct {
	Version string          `json:"version"`
	Op      string          `json:"op"`
	Content json.RawMessage `json:"content"`
}

type pluginResponse struct {
	Reject       bool            `json:"reject"`
	RejectReason string          `json:"reject_reason,omitempty"`
	Unchange     bool            `json:"unchange"`
	Content      json.RawMessage `json:"content,omitempty"`
}

func pluginReject(reason string) pluginResponse {
	return pluginResponse{Reject: true, RejectReason: reason, Unchange: true}
}

func pluginAcceptUnchanged() pluginResponse {
	return pluginResponse{Reject: false, Unchange: true}
}

// loginContent mirrors frp's LoginContent (msg.Login + client_address);
// only the fields tunneld needs are decoded.
type loginContent struct {
	User         string            `json:"user"`
	Metas        map[string]string `json:"metas"`
	RunID        string            `json:"run_id"`
	ClientAddr   string            `json:"client_address"`
	PrivilegeKey string            `json:"privilege_key"` // checked by frps itself, ignored here
}

// userInfo mirrors frp's plugin UserInfo (login session identity).
type userInfo struct {
	User  string            `json:"user"`
	Metas map[string]string `json:"metas"`
	RunID string            `json:"run_id"`
}

// newProxyContent mirrors the fields of frp's NewProxyContent that
// tunneld polices. The full original JSON is retained separately for the
// bandwidth rewrite so no field frps understands is ever dropped.
type newProxyContent struct {
	User               userInfo `json:"user"`
	ProxyName          string   `json:"proxy_name"`
	ProxyType          string   `json:"proxy_type"`
	CustomDomains      []string `json:"custom_domains"`
	SubDomain          string   `json:"subdomain"`
	RemotePort         int      `json:"remote_port"`
	BandwidthLimit     string   `json:"bandwidth_limit"`
	BandwidthLimitMode string   `json:"bandwidth_limit_mode"`
}

// handleFRPPlugin is the HTTP entry point frps calls for Login/NewProxy.
func (s *Server) handleFRPPlugin(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
	if err != nil {
		// Fail closed: a non-200 makes frps abort the operation too, but
		// an in-band reject gives frpc a readable reason.
		writePluginResponse(w, pluginReject("tunneld: unreadable plugin request"))
		return
	}
	var req pluginRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writePluginResponse(w, pluginReject("tunneld: malformed plugin request"))
		return
	}
	op := req.Op
	if op == "" {
		op = r.URL.Query().Get("op")
	}
	var resp pluginResponse
	switch op {
	case "Login":
		resp = s.pluginLogin(req.Content)
	case "NewProxy":
		resp = s.pluginNewProxy(req.Content)
	default:
		// We only register for Login/NewProxy in frps.toml; anything
		// else arriving here is a misconfiguration — fail closed.
		resp = pluginReject("tunneld: unsupported op " + op)
	}
	writePluginResponse(w, resp)
}

func writePluginResponse(w http.ResponseWriter, resp pluginResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// authorizeUser validates a (username, per-user token) pair and the
// subscription gate shared by Login and NewProxy. It returns the user on
// success, or a plugin reject response on failure.
func (s *Server) authorizeUser(username, token string) (User, *pluginResponse) {
	reject := func(reason string) (User, *pluginResponse) {
		r := pluginReject(reason)
		return User{}, &r
	}
	if username == "" {
		return reject("tunneld: missing user")
	}
	if token == "" {
		return reject("tunneld: missing per-user token (metas.token)")
	}
	u, ok := s.store.GetUser(username)
	if !ok {
		return reject("tunneld: unknown user")
	}
	if u.TokenHash == "" {
		return reject("tunneld: user has no issued credentials")
	}
	got := hashToken(token)
	if subtle.ConstantTimeCompare([]byte(got), []byte(u.TokenHash)) != 1 {
		return reject("tunneld: invalid per-user token")
	}
	if ok, reason := subscriptionAllows(u, time.Now().UTC()); !ok {
		return reject(reason)
	}
	return u, nil
}

// subscriptionAllows is the billing gate for tunnel access.
// trialing/active: allowed. past_due: allowed only inside the grace
// window. Anything else: denied. NewProxy re-checks this on every proxy
// registration, so a cancellation takes effect at the next frpc
// reconnect/proxy registration even mid-session.
func subscriptionAllows(u User, now time.Time) (bool, string) {
	switch u.SubStatus {
	case SubStatusActive, SubStatusTrialing:
		return true, ""
	case SubStatusPastDue:
		if !u.GraceUntil.IsZero() && now.Before(u.GraceUntil) {
			return true, ""
		}
		return false, "tunneld: subscription past_due and grace period has ended; update payment method"
	case SubStatusCanceled:
		return false, "tunneld: subscription canceled"
	case SubStatusPending:
		return false, "tunneld: subscription not yet active"
	default:
		return false, "tunneld: subscription status " + u.SubStatus + " does not allow connections"
	}
}

// pluginLogin implements the frp Login op: identity + billing gate only.
// The shared bootstrap token (privilege key) has already been verified by
// frps itself before this call; the per-user token in metas is the real
// tenant credential and is checked against its stored SHA-256 hash.
func (s *Server) pluginLogin(content json.RawMessage) pluginResponse {
	var c loginContent
	if err := json.Unmarshal(content, &c); err != nil {
		return pluginReject("tunneld: malformed Login content")
	}
	u, rej := s.authorizeUser(c.User, c.Metas["token"])
	if rej != nil {
		log.Printf("plugin Login reject user=%q reason=%q", c.User, rej.RejectReason)
		return *rej
	}
	log.Printf("plugin Login accept user=%q status=%s", u.Username, u.SubStatus)
	return pluginAcceptUnchanged()
}

// pluginNewProxy implements the frp NewProxy op: tenant isolation for
// proxy registrations.
//   - identity is re-verified (user + metas.token + billing gate);
//   - only proxy_type "https" is allowed (TLS passthrough; no http
//     vhost exists on this relay, and tcp/udp/stcp/etc. could squat
//     ports or other tenants' names);
//   - custom_domains must be exactly ["<username>.<TUNNEL_DOMAIN>"] —
//     a tenant can never claim another tenant's (or any other) hostname;
//   - subdomain and remote_port must be unset;
//   - bandwidth_limit is rewritten to the configured per-user cap with
//     bandwidth_limit_mode=server so frps (not the tenant's frpc)
//     enforces it.
func (s *Server) pluginNewProxy(content json.RawMessage) pluginResponse {
	var c newProxyContent
	if err := json.Unmarshal(content, &c); err != nil {
		return pluginReject("tunneld: malformed NewProxy content")
	}
	u, rej := s.authorizeUser(c.User.User, c.User.Metas["token"])
	if rej != nil {
		log.Printf("plugin NewProxy reject user=%q proxy=%q reason=%q", c.User.User, c.ProxyName, rej.RejectReason)
		return *rej
	}
	if c.ProxyType != "https" {
		return pluginReject("tunneld: only https proxies are allowed (got " + c.ProxyType + ")")
	}
	if c.SubDomain != "" {
		return pluginReject("tunneld: subdomain field is not allowed; use custom_domains")
	}
	if c.RemotePort != 0 {
		return pluginReject("tunneld: remote_port is not allowed for https proxies")
	}
	wantDomain := s.cfg.SubdomainFor(u.Username)
	if len(c.CustomDomains) != 1 || !strings.EqualFold(strings.TrimSpace(c.CustomDomains[0]), wantDomain) {
		return pluginReject("tunneld: custom_domains must be exactly [\"" + wantDomain + "\"]")
	}
	if s.cfg.BandwidthLimit == "" {
		return pluginAcceptUnchanged()
	}
	// Rewrite the bandwidth fields on the *original* JSON so every
	// other field frps sent survives untouched, then return it with
	// unchange=false; frps parses it back into NewProxyContent and
	// registers the proxy with our values.
	dec := json.NewDecoder(bytes.NewReader(content))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return pluginReject("tunneld: malformed NewProxy content")
	}
	raw["bandwidth_limit"] = s.cfg.BandwidthLimit
	raw["bandwidth_limit_mode"] = "server"
	modified, err := json.Marshal(raw)
	if err != nil {
		return pluginReject("tunneld: internal rewrite error")
	}
	log.Printf("plugin NewProxy accept user=%q proxy=%q domain=%s bandwidth=%s(server)", u.Username, c.ProxyName, wantDomain, s.cfg.BandwidthLimit)
	return pluginResponse{Reject: false, Unchange: false, Content: modified}
}
