package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Cloudflare DNS client (API v4), standard library only. Its single
// job is managing ACME DNS-01 challenge TXT records (certs.go), which
// is why it exposes exactly two operations: create TXT, delete record.
//
// CREDENTIAL HYGIENE: the API token is zone-scoped (Zone:DNS Edit on
// the one zone) and comes from tunneld's environment only. It is never
// sent to clients, never written to the store, and never logged. A
// tunneld compromise yields DNS-edit rights on the tunnel zone — it
// does NOT yield any user's TLS private key (those never leave the
// client) or any user's tunnel credential (hashes only, store.go).

type cloudflareClient struct {
	token  string
	zoneID string
	base   string
	http   *http.Client
}

func newCloudflareClient(cfg Config) *cloudflareClient {
	return &cloudflareClient{
		token:  cfg.CloudflareAPIToken,
		zoneID: cfg.CloudflareZoneID,
		base:   cfg.CloudflareAPIBase,
		http:   &http.Client{Timeout: 20 * time.Second},
	}
}

type cloudflareError struct {
	Status  int
	Message string
}

func (e *cloudflareError) Error() string {
	return fmt.Sprintf("cloudflare: HTTP %d: %s", e.Status, e.Message)
}

// cfResponse is the Cloudflare v4 envelope.
type cfResponse struct {
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

func (c *cloudflareClient) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloudflare: request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var env cfResponse
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, &cloudflareError{Status: resp.StatusCode, Message: "unparseable response"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !env.Success {
		msg := ""
		if len(env.Errors) > 0 {
			msg = env.Errors[0].Message
		}
		return nil, &cloudflareError{Status: resp.StatusCode, Message: msg}
	}
	return env.Result, nil
}

// createTXTRecord publishes one TXT record and returns its record ID.
// TTL 60s: challenge records are short-lived by design, and a low TTL
// keeps ACME resolvers from caching a stale value across renewals.
func (c *cloudflareClient) createTXTRecord(ctx context.Context, name, content string) (string, error) {
	result, err := c.do(ctx, http.MethodPost,
		"/zones/"+c.zoneID+"/dns_records",
		map[string]any{"type": "TXT", "name": name, "content": content, "ttl": 60})
	if err != nil {
		return "", err
	}
	var rec struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(result, &rec); err != nil || rec.ID == "" {
		return "", fmt.Errorf("cloudflare: create record response missing id")
	}
	return rec.ID, nil
}

// deleteRecord removes a DNS record by ID. A 404 (already gone — e.g.
// an operator cleaned it in the dashboard) is success: the desired end
// state, "no such record", holds either way.
func (c *cloudflareClient) deleteRecord(ctx context.Context, recordID string) error {
	_, err := c.do(ctx, http.MethodDelete,
		"/zones/"+c.zoneID+"/dns_records/"+recordID, nil)
	if err != nil {
		if ce, ok := err.(*cloudflareError); ok && ce.Status == http.StatusNotFound {
			return nil
		}
		return err
	}
	return nil
}
