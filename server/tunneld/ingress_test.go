package main

import (
	"testing"
	"time"
)

// The operator API-ingress account (plugin.go): a normal token-checked
// user whose NewProxy rights are confined to exactly the API hostname.

func TestPluginIngressAcceptsOnlyAPIHost(t *testing.T) {
	s := testServer(t, testConfig(t))
	addUser(t, s, apiIngressUsername, "tok-ingress", SubStatusActive, time.Time{})

	// Login goes through the standard identity + billing gate.
	if resp := s.pluginLogin(loginContentJSON(apiIngressUsername, "tok-ingress")); resp.Reject {
		t.Fatalf("ingress login rejected: %q", resp.RejectReason)
	}
	if resp := s.pluginLogin(loginContentJSON(apiIngressUsername, "wrong-token")); !resp.Reject {
		t.Fatal("ingress login with wrong token accepted")
	}

	// The one allowed registration: https for api.homemcp.si,
	// accepted unchanged (no bandwidth rewrite for operator traffic).
	resp := s.pluginNewProxy(newProxyContentJSON(apiIngressUsername, "tok-ingress", "https",
		[]string{"api.homemcp.si"}))
	if resp.Reject {
		t.Fatalf("ingress NewProxy for API host rejected: %q", resp.RejectReason)
	}
	if !resp.Unchange {
		t.Fatal("ingress NewProxy should be accepted unchanged")
	}

	// Everything else is refused: tenant names, look-alike names,
	// the API host plus extra domains, other proxy types.
	for _, tc := range []struct {
		name    string
		typ     string
		domains []string
	}{
		{"tenant domain", "https", []string{"alice.tunnel.homemcp.si"}},
		{"own subdomain shape", "https", []string{"api-ingress.tunnel.homemcp.si"}},
		{"api host plus extra", "https", []string{"api.homemcp.si", "alice.tunnel.homemcp.si"}},
		{"suffix look-alike", "https", []string{"api.homemcp.si.evil.example"}},
		{"tcp proxy", "tcp", []string{"api.homemcp.si"}},
		{"no domains", "https", nil},
	} {
		resp := s.pluginNewProxy(newProxyContentJSON(apiIngressUsername, "tok-ingress", tc.typ, tc.domains))
		if !resp.Reject {
			t.Errorf("%s: NewProxy accepted, want reject", tc.name)
		}
	}
}

func TestPluginTenantCannotClaimAPIHost(t *testing.T) {
	s := testServer(t, testConfig(t))
	addUser(t, s, "alice", "tok-alice", SubStatusActive, time.Time{})

	resp := s.pluginNewProxy(newProxyContentJSON("alice", "tok-alice", "https",
		[]string{"api.homemcp.si"}))
	if !resp.Reject {
		t.Fatal("tenant alice claimed the API hostname")
	}
}

func TestIngressUsernameReserved(t *testing.T) {
	if _, code, ok := validateUsername(apiIngressUsername); ok || code != "username_reserved" {
		t.Fatalf("validateUsername(%q) = ok=%v code=%q, want username_reserved", apiIngressUsername, ok, code)
	}
}
