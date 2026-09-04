package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// schemaDDL is also executed on every relay start, making upgrades safe when
// the postgres volume was initialized by an older image.
//
//go:embed schema.sql
var schemaDDL string

var (
	errDeviceNotFound     = errors.New("device_not_found")
	errDeviceUnauthorized = errors.New("device_unauthorized")
	errDeviceOwned        = errors.New("device_owned")
	errDeviceRevoked      = errors.New("device_revoked")
	errInvalidDeviceID    = errors.New("invalid_device_id")
	errAccountExists      = errors.New("account_exists")
	errInvalidAccount     = errors.New("invalid_account")
)

const maxEventBatchBytes = 32 << 20
const maxSessionListItems = 10_000
const maxDeviceListItems = 1_000

type deviceRecord struct {
	ID             string
	OwnerUser      string
	Name           string
	CredentialHash []byte
	RevokedAt      *time.Time
}

type store struct {
	pool            *pgxpool.Pool
	mu              sync.RWMutex
	memorySessions  map[string]sessionRecord
	memoryDevices   map[string]deviceRecord
	memoryEvents    map[string][]map[string]any
	memoryPairCodes map[string]pairCodeRecord
	memoryAccounts  map[string][]byte
}

var revokedTokens = struct {
	sync.RWMutex
	values map[string]time.Time
}{values: map[string]time.Time{}}

func (s *store) ready(ctx context.Context) error {
	if s.pool == nil {
		if os.Getenv("NODE_ENV") == "production" {
			return fmt.Errorf("postgres is not configured")
		}
		return nil
	}
	return s.pool.Ping(ctx)
}

func (s *store) createAccount(ctx context.Context, username, password string) error {
	if s.pool == nil {
		hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.memoryAccounts == nil {
			s.memoryAccounts = map[string][]byte{}
		}
		if _, exists := s.memoryAccounts[username]; exists {
			return errAccountExists
		}
		s.memoryAccounts[username] = hash
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	boundedCtx, cancel := context.WithTimeout(ctx, relayStorageOperationTimeout)
	defer cancel()
	result, err := s.pool.Exec(boundedCtx, `INSERT INTO relay_accounts(username,password_hash) VALUES($1,$2) ON CONFLICT(username) DO NOTHING`, username, string(hash))
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return errAccountExists
	}
	return nil
}

func (s *store) authenticateAccount(ctx context.Context, username, password string) (bool, error) {
	if s.pool == nil {
		s.mu.RLock()
		hash, exists := s.memoryAccounts[username]
		s.mu.RUnlock()
		if !exists {
			return false, nil
		}
		return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil, nil
	}
	var encoded string
	boundedCtx, cancel := context.WithTimeout(ctx, relayStorageOperationTimeout)
	defer cancel()
	err := s.pool.QueryRow(boundedCtx, `SELECT password_hash FROM relay_accounts WHERE username=$1`, username).Scan(&encoded)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return bcrypt.CompareHashAndPassword([]byte(encoded), []byte(password)) == nil, nil
}

func newStore(ctx context.Context) (*store, error) {
	s := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}, memoryEvents: map[string][]map[string]any{}, memoryPairCodes: map[string]pairCodeRecord{}, memoryAccounts: map[string][]byte{}}
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		if os.Getenv("NODE_ENV") == "production" {
			return nil, fmt.Errorf("DATABASE_URL is required in production")
		}
		return s, nil
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	pingCtx, cancelPing := context.WithTimeout(ctx, 10*time.Second)
	err = pool.Ping(pingCtx)
	cancelPing()
	if err != nil {
		pool.Close()
		return nil, err
	}
	// Keep automatic DDL for the self-contained stack, but allow production
	// operators to run migrations with a separate privileged role and grant
	// the Relay only runtime CRUD permissions.
	if os.Getenv("CODEHARBOR_AUTO_MIGRATE") != "false" {
		migrationCtx, cancelMigration := context.WithTimeout(ctx, 30*time.Second)
		_, err = pool.Exec(migrationCtx, schemaDDL)
		cancelMigration()
		if err != nil {
			pool.Close()
			return nil, fmt.Errorf("initialize schema: %w", err)
		}
	}
	s.pool = pool
	if err = s.loadRevocations(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("load token revocations: %w", err)
	}
	return s, nil
}

func (s *store) loadRevocations(ctx context.Context) error {
	if s.pool == nil {
		return nil
	}
	boundedCtx, cancel := context.WithTimeout(ctx, relayStorageOperationTimeout)
	defer cancel()
	rows, err := s.pool.Query(boundedCtx, `SELECT encode(token_hash,'hex'),expires_at FROM auth_token_revocations WHERE expires_at > now()`)
	if err != nil {
		return err
	}
	defer rows.Close()
	values := map[string]time.Time{}
	for rows.Next() {
		var hash string
		var expires time.Time
		if err := rows.Scan(&hash, &expires); err != nil {
			return err
		}
		values[hash] = expires
	}
	if err := rows.Err(); err != nil {
		return err
	}
	revokedTokens.Lock()
	for hash, expires := range values {
		revokedTokens.values[hash] = expires
	}
	revokedTokens.Unlock()
	return nil
}

// cleanupExpired removes one-time pairing records and token revocations after
// their validity window. Without periodic cleanup these high-churn tables and
// the in-memory revocation map would grow forever on a long-lived relay.
func (s *store) cleanupExpired(ctx context.Context) error {
	now := time.Now()
	if s.pool != nil {
		boundedCtx, cancel := context.WithTimeout(ctx, relayStorageOperationTimeout)
		defer cancel()
		if _, err := s.pool.Exec(boundedCtx, `DELETE FROM pair_codes WHERE expires_at <= now()`); err != nil {
			return err
		}
		if _, err := s.pool.Exec(boundedCtx, `DELETE FROM auth_token_revocations WHERE expires_at <= now()`); err != nil {
			return err
		}
		if retentionDays := configuredEventRetentionDays(); retentionDays > 0 {
			if _, err := s.pool.Exec(boundedCtx, `DELETE FROM gateway_events WHERE created_at < now() - make_interval(days => $1)`, retentionDays); err != nil {
				return err
			}
		}
	}
	revokedTokens.Lock()
	for hash, expiresAt := range revokedTokens.values {
		if !expiresAt.After(now) {
			delete(revokedTokens.values, hash)
		}
	}
	revokedTokens.Unlock()
	s.mu.Lock()
	for hash, record := range s.memoryPairCodes {
		if !record.ExpiresAt.After(now) {
			delete(s.memoryPairCodes, hash)
		}
	}
	s.mu.Unlock()
	return nil
}

// configuredEventRetentionDays is opt-in. Keeping the default at zero avoids
// silently invalidating a client's old event cursor; operators that enable
// retention must accept that events older than the window are unrecoverable.
func configuredEventRetentionDays() int {
	raw := strings.TrimSpace(os.Getenv("CODEHARBOR_EVENT_RETENTION_DAYS"))
	if raw == "" {
		return 0
	}
	days, err := strconv.Atoi(raw)
	if err != nil || days <= 0 {
		return 0
	}
	if days > 3650 {
		return 3650
	}
	return days
}

func (s *store) revokeToken(ctx context.Context, token string, expiresAt time.Time) error {
	hash := hashCredential(token)
	if s.pool != nil {
		if _, err := s.pool.Exec(ctx, `INSERT INTO auth_token_revocations(token_hash,expires_at) VALUES($1,$2) ON CONFLICT(token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at`, hash, expiresAt); err != nil {
			return err
		}
	}
	rememberRevokedHash(hex.EncodeToString(hash), expiresAt)
	return nil
}

func (s *store) upsertSession(ctx context.Context, session sessionRecord) error {
	if s.pool == nil {
		s.mu.Lock()
		if previous, ok := s.memorySessions[session.ID]; ok {
			if previous.OwnerUser != "" && session.OwnerUser != "" && previous.OwnerUser != session.OwnerUser {
				s.mu.Unlock()
				return errDeviceUnauthorized
			}
			if session.OwnerUser == "" {
				session.OwnerUser = previous.OwnerUser
			}
			if session.DeviceID == "" {
				session.DeviceID = previous.DeviceID
			}
			if session.WorkspacePath == "" {
				session.WorkspacePath = previous.WorkspacePath
			}
		}
		s.memorySessions[session.ID] = session
		s.mu.Unlock()
		return nil
	}
	var existingOwner *string
	if err := s.pool.QueryRow(ctx, `SELECT owner_user FROM sessions WHERE id=$1`, session.ID).Scan(&existingOwner); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if existingOwner != nil && *existingOwner != "" && session.OwnerUser != "" && *existingOwner != session.OwnerUser {
		return errDeviceUnauthorized
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO sessions(id,device_id,owner_user,status,title,workspace_path,updated_at,session_policy_mode)
		VALUES($1,NULLIF($2,''),NULLIF($3,''),$4,$5,NULLIF($6,''),$7,$8)
		ON CONFLICT(id) DO UPDATE SET
		 device_id=COALESCE(EXCLUDED.device_id,sessions.device_id),
		 owner_user=COALESCE(sessions.owner_user,EXCLUDED.owner_user),
		 status=EXCLUDED.status,title=EXCLUDED.title,
			 workspace_path=COALESCE(EXCLUDED.workspace_path,sessions.workspace_path),
			 updated_at=EXCLUDED.updated_at,
			 session_policy_mode=EXCLUDED.session_policy_mode`,
		session.ID, session.DeviceID, session.OwnerUser, session.Status, session.Title, session.WorkspacePath, session.UpdatedAt, session.SessionPolicyMode)
	return err
}

// listSessions is retained for migration callers; HTTP handlers use the
// account-scoped variant below.
func (s *store) listSessions(ctx context.Context) ([]sessionRecord, error) {
	if s.pool == nil {
		s.mu.RLock()
		defer s.mu.RUnlock()
		result := make([]sessionRecord, 0, len(s.memorySessions))
		for _, value := range s.memorySessions {
			result = append(result, value)
		}
		return result, nil
	}
	return s.querySessions(ctx, `SELECT id,COALESCE(device_id,''),COALESCE(owner_user,''),COALESCE(status,''),COALESCE(title,''),COALESCE(workspace_path,''),updated_at::text,COALESCE(session_policy_mode,'confirm') FROM sessions ORDER BY updated_at DESC`)
}

func (s *store) listSessionsForUser(ctx context.Context, user string) ([]sessionRecord, error) {
	if user == "" {
		return []sessionRecord{}, nil
	}
	if s.pool == nil {
		s.mu.RLock()
		defer s.mu.RUnlock()
		result := make([]sessionRecord, 0, maxSessionListItems+1)
		for _, value := range s.memorySessions {
			if value.OwnerUser == user {
				result = append(result, value)
				if len(result) > maxSessionListItems {
					break
				}
			}
		}
		sort.SliceStable(result, func(i, j int) bool { return result[i].UpdatedAt > result[j].UpdatedAt })
		return result, nil
	}
	return s.querySessions(ctx, `SELECT id,COALESCE(device_id,''),COALESCE(owner_user,''),COALESCE(status,''),COALESCE(title,''),COALESCE(workspace_path,''),updated_at::text,COALESCE(session_policy_mode,'confirm') FROM sessions WHERE owner_user=$1 ORDER BY updated_at DESC LIMIT $2`, user, maxSessionListItems+1)
}

func (s *store) querySessions(ctx context.Context, query string, args ...any) ([]sessionRecord, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []sessionRecord{}
	for rows.Next() {
		var value sessionRecord
		if err := rows.Scan(&value.ID, &value.DeviceID, &value.OwnerUser, &value.Status, &value.Title, &value.WorkspacePath, &value.UpdatedAt, &value.SessionPolicyMode); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}

func (s *store) appendEvent(ctx context.Context, sessionID string, event map[string]any) error {
	_, err := s.appendOwnedEvent(ctx, sessionID, "", event)
	return err
}

func (s *store) appendOwnedEvent(ctx context.Context, sessionID, ownerUser string, event map[string]any) (int64, error) {
	if s.pool == nil {
		s.mu.Lock()
		if existing, ok := s.memorySessions[sessionID]; ok && existing.OwnerUser != "" && existing.OwnerUser != ownerUser {
			s.mu.Unlock()
			return 0, errDeviceUnauthorized
		}
		if _, ok := s.memorySessions[sessionID]; !ok {
			s.memorySessions[sessionID] = sessionRecord{ID: sessionID, OwnerUser: ownerUser, UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
		}
		if s.memoryEvents == nil {
			s.memoryEvents = make(map[string][]map[string]any)
		}
		seq := int64(len(s.memoryEvents[sessionID]) + 1)
		stored := make(map[string]any, len(event)+1)
		for key, value := range event {
			stored[key] = value
		}
		stored["eventSeq"] = seq
		s.memoryEvents[sessionID] = append(s.memoryEvents[sessionID], stored)
		s.mu.Unlock()
		return seq, nil
	}
	data, err := json.Marshal(event)
	if err != nil {
		return 0, err
	}
	if len(data) > 4<<20 {
		return 0, fmt.Errorf("event_too_large")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO sessions(id,owner_user,updated_at) VALUES($1,NULLIF($2,''),now()) ON CONFLICT(id) DO UPDATE SET owner_user=COALESCE(sessions.owner_user,EXCLUDED.owner_user),updated_at=now()`, sessionID, ownerUser); err != nil {
		return 0, err
	}
	var storedOwner *string
	if err = tx.QueryRow(ctx, `SELECT owner_user FROM sessions WHERE id=$1`, sessionID).Scan(&storedOwner); err != nil {
		return 0, err
	}
	if ownerUser != "" && (storedOwner == nil || *storedOwner != ownerUser) {
		return 0, errDeviceUnauthorized
	}
	if _, err = tx.Exec(ctx, `INSERT INTO session_event_counters(session_id) VALUES($1) ON CONFLICT(session_id) DO NOTHING`, sessionID); err != nil {
		return 0, err
	}
	var seq int64
	if err = tx.QueryRow(ctx, `UPDATE session_event_counters SET last_seq=last_seq+1 WHERE session_id=$1 RETURNING last_seq`, sessionID).Scan(&seq); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO gateway_events(session_id,event_seq,event) VALUES($1,$2,$3)`, sessionID, seq, data); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return seq, nil
}

func (s *store) listEvents(ctx context.Context, sessionID string, after int64) ([]map[string]any, error) {
	if s.pool == nil {
		return s.memoryEventsAfter(sessionID, after), nil
	}
	return s.queryEvents(ctx, `SELECT event_seq,event FROM gateway_events WHERE session_id=$1 AND event_seq>$2 ORDER BY event_seq`, sessionID, after)
}

func (s *store) listEventsForUser(ctx context.Context, sessionID, user string, after int64) ([]map[string]any, error) {
	return s.listEventsForUserLimited(ctx, sessionID, user, after, 5000)
}

func (s *store) listEventsForUserLimited(ctx context.Context, sessionID, user string, after int64, limit int) ([]map[string]any, error) {
	page, err := s.listEventsForUserPage(ctx, sessionID, user, after, limit)
	return page.events, err
}

type eventPage struct {
	events    []map[string]any
	truncated bool
}

// eventBoundsForUser reports the first and last retained sequence for an
// account-owned session. A non-contiguous first sequence means an operator
// retention policy removed the prefix and a client cursor must be reset.
func (s *store) eventBoundsForUser(ctx context.Context, sessionID, user string) (int64, int64, error) {
	if user == "" {
		return 0, 0, errDeviceUnauthorized
	}
	if s.pool == nil {
		s.mu.RLock()
		defer s.mu.RUnlock()
		session, ok := s.memorySessions[sessionID]
		if !ok || session.OwnerUser != user {
			return 0, 0, errDeviceUnauthorized
		}
		events := s.memoryEvents[sessionID]
		if len(events) == 0 {
			return 0, 0, nil
		}
		first, _ := events[0]["eventSeq"].(int64)
		last, _ := events[len(events)-1]["eventSeq"].(int64)
		return first, last, nil
	}
	var first, last int64
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(MIN(e.event_seq),0),COALESCE(MAX(e.event_seq),0) FROM gateway_events e JOIN sessions s ON s.id=e.session_id WHERE e.session_id=$1 AND s.owner_user=$2`, sessionID, user).Scan(&first, &last)
	if err != nil {
		return 0, 0, err
	}
	if first == 0 || last == 0 {
		return 0, 0, nil
	}
	return first, last, nil
}

func (s *store) listEventsForUserPage(ctx context.Context, sessionID, user string, after int64, limit int) (eventPage, error) {
	if user == "" {
		return eventPage{}, errDeviceUnauthorized
	}
	// Callers may request one sentinel row beyond the public 5,000-row page
	// size so the HTTP layer can report an accurate truncated flag.
	if limit <= 0 || limit > 5001 {
		limit = 5000
	}
	if s.pool == nil {
		s.mu.RLock()
		session, ok := s.memorySessions[sessionID]
		if !ok || session.OwnerUser != user {
			s.mu.RUnlock()
			return eventPage{}, errDeviceUnauthorized
		}
		result := copyEventsAfter(s.memoryEvents[sessionID], after)
		truncated := len(result) > limit
		if truncated {
			result = result[:limit]
		}
		capped := capEventBatch(result)
		if len(capped) < len(result) {
			truncated = true
		}
		s.mu.RUnlock()
		return eventPage{events: capped, truncated: truncated}, nil
	}
	events, byteTruncated, err := s.queryEventsWithByteTruncation(ctx, `SELECT e.event_seq,e.event FROM gateway_events e JOIN sessions s ON s.id=e.session_id WHERE e.session_id=$1 AND s.owner_user=$2 AND e.event_seq>$3 ORDER BY e.event_seq LIMIT $4`, sessionID, user, after, limit)
	return eventPage{events: events, truncated: byteTruncated}, err
}

func (s *store) memoryEventsAfter(sessionID string, after int64) []map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return copyEventsAfter(s.memoryEvents[sessionID], after)
}

func copyEventsAfter(events []map[string]any, after int64) []map[string]any {
	result := make([]map[string]any, 0, len(events))
	for _, event := range events {
		seq, _ := event["eventSeq"].(int64)
		if seq <= after {
			continue
		}
		copy := make(map[string]any, len(event))
		for key, value := range event {
			copy[key] = value
		}
		result = append(result, copy)
	}
	return result
}

func (s *store) queryEvents(ctx context.Context, query string, args ...any) ([]map[string]any, error) {
	result, _, err := s.queryEventsWithByteTruncation(ctx, query, args...)
	return result, err
}

func (s *store) queryEventsWithByteTruncation(ctx context.Context, query string, args ...any) ([]map[string]any, bool, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	result := []map[string]any{}
	currentBytes := 0
	byteTruncated := false
	for rows.Next() {
		var seq int64
		var raw []byte
		if err := rows.Scan(&seq, &raw); err != nil {
			return nil, false, err
		}
		var event map[string]any
		if err := json.Unmarshal(raw, &event); err != nil {
			return nil, false, err
		}
		event["eventSeq"] = seq
		if currentBytes+len(raw) > maxEventBatchBytes {
			byteTruncated = true
			break
		}
		currentBytes += len(raw)
		result = append(result, event)
	}
	return result, byteTruncated, rows.Err()
}

func capEventBatch(events []map[string]any) []map[string]any {
	total := 0
	for index, event := range events {
		raw, err := json.Marshal(event)
		if err != nil || total+len(raw) > maxEventBatchBytes {
			return events[:index]
		}
		total += len(raw)
	}
	return events
}

func hashCredential(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func randomToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func randomDeviceID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(bytes[0:4]), hex.EncodeToString(bytes[4:6]), hex.EncodeToString(bytes[6:8]), hex.EncodeToString(bytes[8:10]), hex.EncodeToString(bytes[10:16])), nil
}

func (s *store) enrollDevice(ctx context.Context, user, requestedID, name string) (deviceRecord, string, error) {
	if user == "" {
		return deviceRecord{}, "", errDeviceUnauthorized
	}
	id, valid := normalizeDeviceID(requestedID)
	if requestedID != "" && !valid {
		return deviceRecord{}, "", errInvalidDeviceID
	}
	var err error
	if id == "" {
		id, err = randomDeviceID()
		if err != nil {
			return deviceRecord{}, "", err
		}
	}
	secret, err := randomToken()
	if err != nil {
		return deviceRecord{}, "", err
	}
	record := deviceRecord{ID: id, OwnerUser: user, Name: strings.TrimSpace(name), CredentialHash: hashCredential(secret)}
	if s.pool == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if existing, ok := s.memoryDevices[id]; ok {
			if existing.RevokedAt != nil {
				return deviceRecord{}, "", errDeviceRevoked
			}
			if existing.OwnerUser != "" && existing.OwnerUser != user {
				return deviceRecord{}, "", errDeviceOwned
			}
		}
		s.memoryDevices[id] = record
		return record, secret, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return deviceRecord{}, "", err
	}
	defer tx.Rollback(ctx)
	var owner string
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT COALESCE(owner_user,''),revoked_at FROM relay_devices WHERE id=$1 FOR UPDATE`, id).Scan(&owner, &revokedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return deviceRecord{}, "", err
	}
	if err == nil {
		if revokedAt != nil {
			return deviceRecord{}, "", errDeviceRevoked
		}
		if owner != "" && owner != user {
			return deviceRecord{}, "", errDeviceOwned
		}
		_, err = tx.Exec(ctx, `UPDATE relay_devices SET owner_user=$2,name=$3,credential_hash=$4,updated_at=now(),last_seen_at=now() WHERE id=$1`, id, user, record.Name, record.CredentialHash)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO relay_devices(id,owner_user,name,credential_hash,last_seen_at) VALUES($1,$2,$3,$4,now())`, id, user, record.Name, record.CredentialHash)
	}
	if err != nil {
		return deviceRecord{}, "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return deviceRecord{}, "", err
	}
	return record, secret, nil
}

// registerLegacyDevice is intentionally limited to unbound devices. Once a
// user enrolls a device, the shared server token can no longer take it over.
func (s *store) registerLegacyDevice(ctx context.Context, id, name string) (deviceRecord, string, error) {
	normalizedID, valid := normalizeDeviceID(id)
	if !valid {
		return deviceRecord{}, "", errDeviceNotFound
	}
	id = normalizedID
	secret, err := randomToken()
	if err != nil {
		return deviceRecord{}, "", err
	}
	record := deviceRecord{ID: id, Name: strings.TrimSpace(name), CredentialHash: hashCredential(secret)}
	if s.pool == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if existing, ok := s.memoryDevices[id]; ok {
			if existing.RevokedAt != nil {
				return deviceRecord{}, "", errDeviceRevoked
			}
			if existing.OwnerUser != "" {
				return deviceRecord{}, "", errDeviceOwned
			}
		}
		s.memoryDevices[id] = record
		return record, secret, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return deviceRecord{}, "", err
	}
	defer tx.Rollback(ctx)
	var owner string
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT COALESCE(owner_user,''),revoked_at FROM relay_devices WHERE id=$1 FOR UPDATE`, id).Scan(&owner, &revokedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return deviceRecord{}, "", err
	}
	if err == nil {
		if revokedAt != nil {
			return deviceRecord{}, "", errDeviceRevoked
		}
		if owner != "" {
			return deviceRecord{}, "", errDeviceOwned
		}
		_, err = tx.Exec(ctx, `UPDATE relay_devices SET name=$2,credential_hash=$3,updated_at=now(),last_seen_at=now() WHERE id=$1`, id, record.Name, record.CredentialHash)
	} else {
		_, err = tx.Exec(ctx, `INSERT INTO relay_devices(id,name,credential_hash,last_seen_at) VALUES($1,$2,$3,now())`, id, record.Name, record.CredentialHash)
	}
	if err != nil {
		return deviceRecord{}, "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return deviceRecord{}, "", err
	}
	return record, secret, nil
}

func (s *store) authenticateDevice(ctx context.Context, id, secret string) (deviceRecord, error) {
	if id == "" || secret == "" {
		return deviceRecord{}, errDeviceUnauthorized
	}
	hash := hashCredential(secret)
	if s.pool == nil {
		s.mu.RLock()
		record, ok := s.memoryDevices[id]
		s.mu.RUnlock()
		if !ok || !hmac.Equal(record.CredentialHash, hash) {
			return deviceRecord{}, errDeviceUnauthorized
		}
		if record.RevokedAt != nil {
			return deviceRecord{}, errDeviceRevoked
		}
		return record, nil
	}
	var record deviceRecord
	if err := s.pool.QueryRow(ctx, `SELECT id,COALESCE(owner_user,''),name,credential_hash,revoked_at FROM relay_devices WHERE id=$1`, id).Scan(&record.ID, &record.OwnerUser, &record.Name, &record.CredentialHash, &record.RevokedAt); errors.Is(err, pgx.ErrNoRows) {
		return deviceRecord{}, errDeviceUnauthorized
	} else if err != nil {
		return deviceRecord{}, err
	}
	if record.RevokedAt != nil {
		return deviceRecord{}, errDeviceRevoked
	}
	if !hmac.Equal(record.CredentialHash, hash) {
		return deviceRecord{}, errDeviceUnauthorized
	}
	return record, nil
}

func (s *store) device(ctx context.Context, id string) (deviceRecord, error) {
	if strings.TrimSpace(id) == "" {
		return deviceRecord{}, errDeviceNotFound
	}
	if s.pool == nil {
		s.mu.RLock()
		record, ok := s.memoryDevices[id]
		s.mu.RUnlock()
		if !ok {
			return deviceRecord{}, errDeviceNotFound
		}
		if record.RevokedAt != nil {
			return deviceRecord{}, errDeviceRevoked
		}
		return record, nil
	}
	var record deviceRecord
	if err := s.pool.QueryRow(ctx, `SELECT id,COALESCE(owner_user,''),name,credential_hash,revoked_at FROM relay_devices WHERE id=$1`, id).Scan(&record.ID, &record.OwnerUser, &record.Name, &record.CredentialHash, &record.RevokedAt); errors.Is(err, pgx.ErrNoRows) {
		return deviceRecord{}, errDeviceNotFound
	} else if err != nil {
		return deviceRecord{}, err
	}
	if record.RevokedAt != nil {
		return deviceRecord{}, errDeviceRevoked
	}
	return record, nil
}

func (s *store) listDevices(ctx context.Context, user string) ([]deviceRecord, error) {
	if user == "" {
		return []deviceRecord{}, nil
	}
	if s.pool == nil {
		s.mu.RLock()
		defer s.mu.RUnlock()
		result := make([]deviceRecord, 0, maxDeviceListItems+1)
		for _, value := range s.memoryDevices {
			if value.OwnerUser == user {
				result = append(result, value)
				if len(result) > maxDeviceListItems {
					break
				}
			}
		}
		sort.SliceStable(result, func(i, j int) bool { return result[i].ID < result[j].ID })
		return result, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id,COALESCE(owner_user,''),name,credential_hash,revoked_at FROM relay_devices WHERE owner_user=$1 ORDER BY updated_at DESC LIMIT $2`, user, maxDeviceListItems+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []deviceRecord{}
	for rows.Next() {
		var value deviceRecord
		if err := rows.Scan(&value.ID, &value.OwnerUser, &value.Name, &value.CredentialHash, &value.RevokedAt); err != nil {
			return nil, err
		}
		result = append(result, value)
	}
	return result, rows.Err()
}
