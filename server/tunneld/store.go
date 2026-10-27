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
	"sort"
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
	Username  string `json:"username"`
	TokenHash string `json:"token_hash,omitempty"` // hex SHA-256 of the per-user token
	Subdomain string `json:"subdomain"`
	Plan      string `json:"plan"` // annual | monthly
	// Mock marks an account that was activated WITHOUT a real payment
	// (mock allowlist or mock-pay page — see mockpay.go). Mock accounts
	// are operator-granted test accounts: they carry no Stripe linkage
	// and must be excluded from any revenue accounting.
	Mock                 bool      `json:"mock,omitempty"`
	StripeCustomerID     string    `json:"stripe_customer_id,omitempty"`
	StripeSubscriptionID string    `json:"stripe_subscription_id,omitempty"`
	SubStatus            string    `json:"sub_status"`
	GraceUntil           time.Time `json:"grace_until,omitempty"`
	TrialEnd             time.Time `json:"trial_end,omitempty"` // set while trialing
	CurrentPeriodEnd     time.Time `json:"current_period_end,omitempty"`
	CreatedAt            time.Time `json:"created_at"`
}

// MockUserEntry is one name on the operator's mock allowlist (see
// mockpay.go): when this username enrolls, the server activates it
// without any payment, on any instance, Stripe configured or not.
type MockUserEntry struct {
	Username string    `json:"username"`
	Note     string    `json:"note,omitempty"` // operator note: who/why
	AddedAt  time.Time `json:"added_at"`
}

// Enrollment is a registration in progress/completed. The enrollment ID is
// the claim capability: whoever presents it after payment receives the
// credentials. Treat it like a secret link (see CLIENT_CONTRACT.md).
type Enrollment struct {
	ID                      string `json:"id"`
	Username                string `json:"username"`
	Plan                    string `json:"plan"`
	Status                  string `json:"status"`
	StripeCheckoutSessionID string `json:"stripe_checkout_session_id,omitempty"`
	CredentialsIssued       bool   `json:"credentials_issued"`
	// ClaimAcked is set when the client confirms (POST claim/ack,
	// presenting the token) that it has PERSISTED the credentials.
	// Until then the claim is recoverable: a repeated claim ROTATES
	// the token and re-issues, so a client that crashed or failed to
	// save can simply claim again. After the ack, a real account's
	// claim is final (recovery = operator reset); mock accounts may
	// still re-claim (rotation) for client development.
	ClaimAcked bool      `json:"claim_acked,omitempty"`
	ClaimedAt  time.Time `json:"claimed_at,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// DNSChallenge is one ACME DNS-01 challenge tunneld is maintaining
// for a user (certs.go). The Value is the ACME key-authorization
// digest the client asked tunneld to publish — a hash of public
// material, not a secret; it is stored so tunneld can verify
// propagation and clean the record up. The TLS private key itself
// NEVER leaves the client: publishing this TXT is the one thing the
// client cannot do itself, and it is all tunneld ever does for certs.
type DNSChallenge struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Value        string    `json:"value"`
	CFRecordID   string    `json:"cf_record_id,omitempty"`
	Status       string    `json:"status"` // active | cleaned | expired
	CreatedAt    time.Time `json:"created_at"`
	ExpiresAt    time.Time `json:"expires_at"`
	PropagatedAt time.Time `json:"propagated_at,omitempty"`
}

type storeData struct {
	Users       map[string]*User          `json:"users"`
	Enrollments map[string]*Enrollment    `json:"enrollments"`
	MockUsers   map[string]*MockUserEntry `json:"mock_users,omitempty"`
	Challenges  map[string]*DNSChallenge  `json:"challenges,omitempty"`
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
	s.data.MockUsers = map[string]*MockUserEntry{}
	s.data.Challenges = map[string]*DNSChallenge{}
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
			if s.data.MockUsers == nil {
				s.data.MockUsers = map[string]*MockUserEntry{}
			}
			if s.data.Challenges == nil {
				s.data.Challenges = map[string]*DNSChallenge{}
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

// IsMockUser reports whether username is on the operator's mock
// allowlist: its enrollment will be activated without payment.
func (s *Store) IsMockUser(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data.MockUsers[username]
	return ok
}

// AddMockUser puts username on the mock allowlist (or refreshes its
// note). added_at is preserved across refreshes.
func (s *Store) AddMockUser(username, note string) (MockUserEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.data.MockUsers[username]; ok {
		e.Note = note
		if err := s.saveLocked(); err != nil {
			return MockUserEntry{}, err
		}
		return *e, nil
	}
	e := &MockUserEntry{Username: username, Note: note, AddedAt: time.Now().UTC()}
	s.data.MockUsers[username] = e
	if err := s.saveLocked(); err != nil {
		return MockUserEntry{}, err
	}
	return *e, nil
}

// RemoveMockUser takes username off the mock allowlist. It does NOT
// touch an already-activated account — cancel that via the
// subscription-event hook or a future admin action.
func (s *Store) RemoveMockUser(username string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.data.MockUsers[username]; !ok {
		return false, nil
	}
	delete(s.data.MockUsers, username)
	if err := s.saveLocked(); err != nil {
		return false, err
	}
	return true, nil
}

// ListMockUsers returns the mock allowlist, sorted by username.
func (s *Store) ListMockUsers() []MockUserEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]MockUserEntry, 0, len(s.data.MockUsers))
	for _, e := range s.data.MockUsers {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
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
	ErrUsernameTaken    = errors.New("username taken")
	ErrNotFound         = errors.New("not found")
	ErrAlreadyClaimed   = errors.New("credentials already issued")
	ErrNotReady         = errors.New("enrollment not ready")
	ErrNotClaimed       = errors.New("credentials not claimed")
	ErrStaleClaim       = errors.New("claim superseded by a newer claim")
	ErrChallengeLimit   = errors.New("too many active challenges")
	ErrChallengeRateCap = errors.New("challenge creation rate exceeded")
)

// CreateChallenge records a new DNS-01 challenge, enforcing the
// per-user abuse caps atomically under the write lock: at most
// maxActive simultaneously active challenges, and at most maxPerWindow
// created within the trailing window (counted from CreatedAt, so the
// cap survives restarts).
func (s *Store) CreateChallenge(ch DNSChallenge, maxActive, maxPerWindow int, windowStart time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	active, recent := 0, 0
	for _, existing := range s.data.Challenges {
		if existing.Username != ch.Username {
			continue
		}
		if existing.Status == "active" {
			active++
		}
		if existing.CreatedAt.After(windowStart) {
			recent++
		}
	}
	if active >= maxActive {
		return ErrChallengeLimit
	}
	if recent >= maxPerWindow {
		return ErrChallengeRateCap
	}
	cp := ch
	s.data.Challenges[ch.ID] = &cp
	return s.saveLocked()
}

// GetChallenge returns a copy of a challenge.
func (s *Store) GetChallenge(id string) (DNSChallenge, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.data.Challenges[id]
	if !ok {
		return DNSChallenge{}, false
	}
	return *ch, true
}

// UpdateChallenge mutates a challenge under the write lock and persists.
func (s *Store) UpdateChallenge(id string, fn func(*DNSChallenge)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch, ok := s.data.Challenges[id]
	if !ok {
		return ErrNotFound
	}
	fn(ch)
	return s.saveLocked()
}

// ListActiveChallenges returns copies of all still-active challenges
// (the expiry sweeper's work list).
func (s *Store) ListActiveChallenges() []DNSChallenge {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]DNSChallenge, 0)
	for _, ch := range s.data.Challenges {
		if ch.Status == "active" {
			out = append(out, *ch)
		}
	}
	return out
}

// newChallengeID mints an unguessable challenge ID.
func newChallengeID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "dns_" + hex.EncodeToString(b), nil
}

// ClaimAndIssue installs the hash of a freshly generated token on the
// user of a ready enrollment and marks the enrollment claimed. It backs
// POST /api/v1/enrollments/{id}/claim — the ONLY issuance path (reads
// never issue; see api.go).
//
// Claim states and retries (the recoverable-claim protocol):
//   - ready: first issuance.
//   - claimed, not yet acked: the client never confirmed it persisted
//     the credentials (crash, network loss, save failure), so a repeat
//     claim ROTATES — the new hash replaces the old, the un-persisted
//     token dies, and the client saves the fresh credentials instead.
//     Concurrent claims are safe for the same reason: every claim
//     returns a then-current token, exactly one token is ever live,
//     and the client converges by acking the newest one it saved.
//   - claimed and acked: final for real accounts (ErrAlreadyClaimed;
//     recovery is the operator reset endpoint). Mock (test) accounts
//     deliberately stay re-claimable — rotation again — so client
//     development can wipe local state and start over at will.
func (s *Store) ClaimAndIssue(enrollmentID, tokenHash string) (Enrollment, User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data.Enrollments[enrollmentID]
	if !ok {
		return Enrollment{}, User{}, ErrNotFound
	}
	// Status gate first: a pending enrollment has no user yet (the
	// user is created by the payment funnel), so the readiness check
	// must not depend on the user lookup.
	if e.Status == EnrollmentPendingPayment {
		return Enrollment{}, User{}, ErrNotReady
	}
	if e.Status != EnrollmentReady && e.Status != EnrollmentClaimed {
		return Enrollment{}, User{}, ErrNotFound
	}
	u, ok := s.data.Users[e.Username]
	if !ok {
		return Enrollment{}, User{}, ErrNotFound
	}
	if e.Status == EnrollmentClaimed && e.ClaimAcked && !u.Mock {
		return Enrollment{}, User{}, ErrAlreadyClaimed
	}
	u.TokenHash = tokenHash
	e.Status = EnrollmentClaimed
	e.CredentialsIssued = true
	e.ClaimAcked = false
	e.ClaimedAt = time.Now().UTC()
	e.UpdatedAt = time.Now().UTC()
	if err := s.saveLocked(); err != nil {
		return Enrollment{}, User{}, err
	}
	return *e, *u, nil
}

// AckClaim confirms that the client persisted the credentials issued
// for an enrollment: the caller presents the token it saved, and the
// ack lands only if that token is still the current one (its hash
// matches the user's). A mismatch means a newer claim rotated the
// token after the caller saved — the caller must claim again and ack
// the newest credentials instead (ErrStaleClaim). Acking is idempotent:
// repeating an ack with the current token succeeds.
func (s *Store) AckClaim(enrollmentID, tokenHash string) (Enrollment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.data.Enrollments[enrollmentID]
	if !ok {
		return Enrollment{}, ErrNotFound
	}
	if e.Status != EnrollmentClaimed || !e.CredentialsIssued {
		return Enrollment{}, ErrNotClaimed
	}
	u, ok := s.data.Users[e.Username]
	if !ok {
		return Enrollment{}, ErrNotFound
	}
	if u.TokenHash != tokenHash {
		return Enrollment{}, ErrStaleClaim
	}
	e.ClaimAcked = true
	e.UpdatedAt = time.Now().UTC()
	if err := s.saveLocked(); err != nil {
		return Enrollment{}, err
	}
	return *e, nil
}

// RotateUserToken replaces a user's token hash with a fresh one
// (credential recovery, and re-issue for reusable test accounts). The
// previous token stops working immediately: the frp plugin compares
// against this hash on every Login and NewProxy.
func (s *Store) RotateUserToken(username, tokenHash string) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.data.Users[username]
	if !ok {
		return User{}, ErrNotFound
	}
	u.TokenHash = tokenHash
	if err := s.saveLocked(); err != nil {
		return User{}, err
	}
	return *u, nil
}

// DeleteUser removes a user and everything attached to it — its
// enrollments and DNS challenges — and returns the challenges that
// were still active, so the caller can remove their TXT records at
// the DNS provider. It backs test-account cleanup (the API layer
// restricts it to mock accounts): after deletion the username can be
// enrolled again from a clean slate.
func (s *Store) DeleteUser(username string) (User, []DNSChallenge, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.data.Users[username]
	if !ok {
		return User{}, nil, ErrNotFound
	}
	var active []DNSChallenge
	for id, ch := range s.data.Challenges {
		if ch.Username == username {
			if ch.Status == ChallengeActive {
				active = append(active, *ch)
			}
			delete(s.data.Challenges, id)
		}
	}
	for id, e := range s.data.Enrollments {
		if e.Username == username {
			delete(s.data.Enrollments, id)
		}
	}
	delete(s.data.Users, username)
	if err := s.saveLocked(); err != nil {
		return User{}, nil, err
	}
	return *u, active, nil
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
