package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Plans and subscription statuses. These strings are part of the client
// contract (see docs/CLIENT_CONTRACT.md) — do not rename casually.
const (
	PlanAnnual  = "annual"
	PlanMonthly = "monthly"
)

const (
	SubStatusPending  = "pending"  // enrollment created, subscription not yet active
	SubStatusTrialing = "trialing" // annual plan in its 7-day free trial (card on file)
	SubStatusActive   = "active"   // paid and current
	SubStatusPastDue  = "past_due" // payment failed; access continues until GraceUntil
	SubStatusCanceled = "canceled" // subscription ended; no access
)

// Enrollment lifecycle: pending_payment -> ready -> claimed.
const (
	EnrollmentPendingPayment = "pending_payment"
	EnrollmentReady          = "ready"   // paid via webhook; credentials can be claimed
	EnrollmentClaimed        = "claimed" // per-user token issued exactly once
)

// User is one tunnel subscriber. Only the SHA-256 hash of the per-user
// token is ever stored; the plaintext token exists only in the claim
// response (and on the user's machine after that).
type User struct {
	Username             string    `json:"username"`
	TokenHash            string    `json:"token_hash,omitempty"` // hex SHA-256 of the per-user token
	Subdomain            string    `json:"subdomain"`
	Plan                 string    `json:"plan"` // annual | monthly
	StripeCustomerID     string    `json:"stripe_customer_id,omitempty"`
	StripeSubscriptionID string    `json:"stripe_subscription_id,omitempty"`
	SubStatus            string    `json:"sub_status"`
	GraceUntil           time.Time `json:"grace_until,omitempty"`
	CurrentPeriodEnd     time.Time `json:"current_period_end,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
}

// Enrollment is a registration in progress/completed. The enrollment ID is
// the claim capability: whoever presents it after payment receives the
// credentials. Treat it like a secret link (see CLIENT_CONTRACT.md).
type Enrollment struct {
	ID                      string    `json:"id"`
	Username                string    `json:"username"`
	Plan                    string    `json:"plan"`
	Status                  string    `json:"status"`
	StripeCheckoutSessionID string    `json:"stripe_checkout_session_id,omitempty"`
	CredentialsIssued       bool      `json:"credentials_issued"`
	CreatedAt               time.Time `json:"created_at"`
	UpdatedAt               time.Time `json:"updated_at"`
}

type storeData struct {
	Users       map[string]*User       `json:"users"`
	Enrollments map[string]*Enrollment `json:"enrollments"`
}

// Store is the tunneld persistence layer.
//
// STORAGE CHOICE (deliberate): a single JSON document on disk, rewritten
// atomically (write temp file + fsync + rename) on every mutation, guarded
// by one in-process mutex. This is enough for the expected scale (one
// relay, hundreds of subscribers, a handful of writes per minute at peak)
// and keeps the deployment to one static binary plus one data file — no
// database to run or back up separately. Limits: single tunneld instance
// only (no horizontal scaling), every write is O(store size), and a crash
// between mutation and rename loses at most the last write. If subscriber
// count or write rate ever outgrows this, swap this file for SQLite
// behind the same method set; nothing else in tunneld touches the file.
type Store struct {
	mu   sync.Mutex
	path string
	data storeData
}

// OpenStore loads the store at path, creating an empty one if absent.
func OpenStore(path string) (*Store, error) {
	s := &Store{path: path}
	s.data.Users = map[string]*User{}
	s.data.Enrollments = map[string]*Enrollment{}
	raw, err := os.ReadFile(path)
	switch {
	case err == nil:
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &s.data); err != nil {
				return nil, fmt.Errorf("parse store %s: %w", path, err)
			}
			if s.data.Users == nil {
				s.data.Users = map[string]*User{}
			}
			if s.data.Enrollments == nil {
				s.data.Enrollments = map[string]*Enrollment{}
			}
		}
	case errors.Is(err, os.ErrNotExist):
		if err := s.saveLocked(); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	return s, nil
}

// saveLocked persists the store atomically. Caller holds s.mu (or is in
// OpenStore before the store is shared).
func (s *Store) saveLocked() error {
	raw, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	tmp, err := os.CreateTemp(dir, ".tunneld-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

// UsernameTaken reports whether a username is held by a user or by any
// enrollment (a pending checkout still reserves the name; abandoned
// enrollments are an operator cleanup task, see README).
func (s *Store) UsernameTaken(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data.Users[username]; ok {
		return true
	}
	for _, e := range s.data.Enrollments {
		if e.Username == username {
			return true
		}
	}
	return false
}

// CreateEnrollment records a new enrollment, failing if the username is
// already taken (checked again under the write lock).
func (s *Store) CreateEnrollment(e Enrollment) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data.Users[e.Username]; ok {
		return ErrUsernameTaken
	}
	for _, existing := range s.data.Enrollments {
		if existing.Username == e.Username {
			return ErrUsernameTaken
		}
	}
	cp := e
	s.data.Enrollments[e.ID] = &cp
	return s.saveLocked()
}

// GetEnrollment returns a copy of an enrollment.
func (s *Store) GetEnrollment(id string) (Enrollment, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data.Enrollments[id]
	if !ok {
		return Enrollment{}, false
	}
	return *e, true
}

// UpdateEnrollment mutates an enrollment under the write lock and persists.
func (s *Store) UpdateEnrollment(id string, fn func(*Enrollment)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data.Enrollments[id]
	if !ok {
		return ErrNotFound
	}
	fn(e)
	e.UpdatedAt = time.Now().UTC()
	return s.saveLocked()
}

// GetUser returns a copy of a user.
func (s *Store) GetUser(username string) (User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.data.Users[username]
	if !ok {
		return User{}, false
	}
	return *u, true
}

// EnsureUser returns the user, creating a pending record if needed.
func (s *Store) EnsureUser(username, plan, subdomain string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok := s.data.Users[username]; ok {
		return *u, nil
	}
	u := &User{
		Username:  username,
		Subdomain: subdomain,
		Plan:      plan,
		SubStatus: SubStatusPending,
		CreatedAt: time.Now().UTC(),
	}
	s.data.Users[username] = u
	if err := s.saveLocked(); err != nil {
		return User{}, err
	}
	return *u, nil
}

// UpdateUser mutates a user under the write lock and persists.
func (s *Store) UpdateUser(username string, fn func(*User)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.data.Users[username]
	if !ok {
		return ErrNotFound
	}
	fn(u)
	return s.saveLocked()
}

// ListUsers returns copies of all users (admin view scrubs token hashes at
// the call site).
func (s *Store) ListUsers() []User {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]User, 0, len(s.data.Users))
	for _, u := range s.data.Users {
		out = append(out, *u)
	}
	return out
}

// FindUserByTokenHash locates a user by hex SHA-256 token hash.
func (s *Store) FindUserByTokenHash(hash string) (User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.data.Users {
		if u.TokenHash != "" && u.TokenHash == hash {
			return *u, true
		}
	}
	return User{}, false
}

// FindUserByCustomer locates a user by Stripe customer ID.
func (s *Store) FindUserByCustomer(customerID string) (User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.data.Users {
		if u.StripeCustomerID != "" && u.StripeCustomerID == customerID {
			return *u, true
		}
	}
	return User{}, false
}

// FindUserBySubscription locates a user by Stripe subscription ID.
func (s *Store) FindUserBySubscription(subscriptionID string) (User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, u := range s.data.Users {
		if u.StripeSubscriptionID != "" && u.StripeSubscriptionID == subscriptionID {
			return *u, true
		}
	}
	return User{}, false
}

var (
	ErrUsernameTaken  = errors.New("username taken")
	ErrNotFound       = errors.New("not found")
	ErrAlreadyClaimed = errors.New("credentials already issued")
)

// ClaimAndIssue atomically marks a ready enrollment claimed and installs
// the hash of the freshly generated token on the user. It is the only
// place a token hash is written, which guarantees issue-exactly-once even
// under concurrent claim requests.
func (s *Store) ClaimAndIssue(enrollmentID, tokenHash string) (Enrollment, User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data.Enrollments[enrollmentID]
	if !ok {
		return Enrollment{}, User{}, ErrNotFound
	}
	if e.Status == EnrollmentClaimed || e.CredentialsIssued {
		return Enrollment{}, User{}, ErrAlreadyClaimed
	}
	if e.Status != EnrollmentReady {
		return Enrollment{}, User{}, ErrNotFound
	}
	u, ok := s.data.Users[e.Username]
	if !ok {
		return Enrollment{}, User{}, ErrNotFound
	}
	u.TokenHash = tokenHash
	e.Status = EnrollmentClaimed
	e.CredentialsIssued = true
	e.UpdatedAt = time.Now().UTC()
	if err := s.saveLocked(); err != nil {
		return Enrollment{}, User{}, err
	}
	return *e, *u, nil
}

// hashToken returns the hex SHA-256 of a per-user token. Only this hash is
// ever persisted or compared.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// generateToken mints a new per-user token (256 bits, base64url).
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// newEnrollmentID mints an unguessable enrollment ID (the claim capability).
func newEnrollmentID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "enr_" + hex.EncodeToString(b), nil
}
