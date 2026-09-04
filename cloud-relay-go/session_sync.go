package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	maxSessionSyncItems = 10_000
	maxSessionIDLength  = 256
	maxSessionTitleLen  = 512
	maxWorkspacePathLen = 4096
	maxSessionStatusLen = 80
	maxSessionPolicyLen = 32
)

var errInvalidSessionSync = errors.New("invalid_session_sync")

type sessionSyncResult struct {
	Accepted int
	Skipped  int
}

// syncSessions stores the authenticated device's local session inventory. A
// session can only be claimed by its first owner/device; repeated syncs from
// that same device are idempotent and update metadata when it is newer.
func (s *store) syncSessions(ctx context.Context, ownerUser, deviceID string, sessions []sessionRecord) (sessionSyncResult, error) {
	if strings.TrimSpace(ownerUser) == "" || strings.TrimSpace(deviceID) == "" {
		return sessionSyncResult{}, errDeviceUnauthorized
	}
	if len(sessions) > maxSessionSyncItems {
		return sessionSyncResult{}, errInvalidSessionSync
	}
	normalized := make([]sessionRecord, 0, len(sessions))
	for _, session := range sessions {
		value, ok := normalizeSessionSync(session)
		if !ok {
			return sessionSyncResult{}, errInvalidSessionSync
		}
		value.OwnerUser = ownerUser
		value.DeviceID = deviceID
		normalized = append(normalized, value)
	}
	if s.pool == nil {
		return s.syncSessionsMemory(ownerUser, deviceID, normalized), nil
	}
	return s.syncSessionsPostgres(ctx, ownerUser, deviceID, normalized)
}

func normalizeSessionSync(session sessionRecord) (sessionRecord, bool) {
	session.ID = strings.TrimSpace(session.ID)
	session.Title = strings.TrimSpace(session.Title)
	session.Status = strings.TrimSpace(session.Status)
	session.WorkspacePath = strings.TrimSpace(session.WorkspacePath)
	session.UpdatedAt = strings.TrimSpace(session.UpdatedAt)
	session.SessionPolicyMode = strings.TrimSpace(session.SessionPolicyMode)
	if session.ID == "" || len(session.ID) > maxSessionIDLength || len(session.Title) > maxSessionTitleLen || len(session.WorkspacePath) > maxWorkspacePathLen || len(session.Status) > maxSessionStatusLen || len(session.SessionPolicyMode) > maxSessionPolicyLen {
		return sessionRecord{}, false
	}
	if session.SessionPolicyMode == "" {
		session.SessionPolicyMode = "confirm"
	}
	if session.SessionPolicyMode != "confirm" && session.SessionPolicyMode != "full-access" {
		return sessionRecord{}, false
	}
	if session.UpdatedAt == "" {
		session.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if _, err := time.Parse(time.RFC3339Nano, session.UpdatedAt); err != nil {
		return sessionRecord{}, false
	}
	return session, true
}

func (s *store) syncSessionsMemory(ownerUser, deviceID string, sessions []sessionRecord) sessionSyncResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.memorySessions == nil {
		s.memorySessions = make(map[string]sessionRecord)
	}
	result := sessionSyncResult{}
	for _, incoming := range sessions {
		existing, ok := s.memorySessions[incoming.ID]
		if ok && !sessionOwnedBy(existing, ownerUser, deviceID) {
			result.Skipped++
			continue
		}
		if ok && !sessionSyncIsNewer(incoming, existing) {
			result.Skipped++
			continue
		}
		s.memorySessions[incoming.ID] = incoming
		result.Accepted++
	}
	return result
}

func (s *store) syncSessionsPostgres(ctx context.Context, ownerUser, deviceID string, sessions []sessionRecord) (sessionSyncResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return sessionSyncResult{}, err
	}
	defer tx.Rollback(ctx)
	result := sessionSyncResult{}
	for _, session := range sessions {
		updatedAt, parseErr := time.Parse(time.RFC3339Nano, session.UpdatedAt)
		if parseErr != nil {
			return sessionSyncResult{}, errInvalidSessionSync
		}
		tag, execErr := tx.Exec(ctx, `
			INSERT INTO sessions(id,device_id,owner_user,status,title,workspace_path,updated_at,session_policy_mode)
			VALUES($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8)
			ON CONFLICT(id) DO UPDATE SET
			 device_id=COALESCE(NULLIF(sessions.device_id,''),EXCLUDED.device_id),
			 owner_user=COALESCE(NULLIF(sessions.owner_user,''),EXCLUDED.owner_user),
			 status=EXCLUDED.status,
			 title=EXCLUDED.title,
			 workspace_path=COALESCE(EXCLUDED.workspace_path,sessions.workspace_path),
				 updated_at=EXCLUDED.updated_at,
				 session_policy_mode=EXCLUDED.session_policy_mode
			WHERE (NULLIF(sessions.owner_user,'') IS NULL OR sessions.owner_user=$3)
			  AND (NULLIF(sessions.device_id,'') IS NULL OR sessions.device_id=$2)
			  AND (EXCLUDED.updated_at >= sessions.updated_at OR NULLIF(sessions.title,'') IS NULL OR NULLIF(sessions.workspace_path,'') IS NULL)`,
			session.ID, deviceID, ownerUser, session.Status, session.Title, session.WorkspacePath, updatedAt, session.SessionPolicyMode)
		if execErr != nil {
			return sessionSyncResult{}, execErr
		}
		if tag.RowsAffected() == 0 {
			result.Skipped++
		} else {
			result.Accepted++
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return sessionSyncResult{}, err
	}
	return result, nil
}

func sessionOwnedBy(session sessionRecord, ownerUser, deviceID string) bool {
	return (session.OwnerUser == "" || session.OwnerUser == ownerUser) && (session.DeviceID == "" || session.DeviceID == deviceID)
}

func sessionSyncIsNewer(incoming, existing sessionRecord) bool {
	if existing.UpdatedAt == "" || existing.Title == "" || existing.WorkspacePath == "" {
		return true
	}
	incomingAt, incomingErr := time.Parse(time.RFC3339Nano, incoming.UpdatedAt)
	existingAt, existingErr := time.Parse(time.RFC3339Nano, existing.UpdatedAt)
	if incomingErr != nil || existingErr != nil {
		return true
	}
	return !incomingAt.Before(existingAt)
}

// handleSessionSync accepts both the canonical top-level {sessions:[...]} and
// the equivalent {payload:{sessions:[...]}} envelope so Gateway upgrades can
// roll out without a protocol-breaking reconnect.
func (r *relay) handleSessionSync(ctx context.Context, device *peer, msg map[string]any) (sessionSyncResult, error) {
	sessions, ok := sessionSyncPayload(msg)
	if !ok {
		return sessionSyncResult{}, errInvalidSessionSync
	}
	return r.store.syncSessions(ctx, device.ownerUser, device.deviceID, sessions)
}

func sessionSyncPayload(msg map[string]any) ([]sessionRecord, bool) {
	raw, found := msg["sessions"]
	if !found {
		payload := msg["payload"]
		if payloadMap, payloadOK := payload.(map[string]any); payloadOK {
			raw, found = payloadMap["sessions"]
		} else if _, payloadOK := payload.([]any); payloadOK {
			raw, found = payload, true
		}
	}
	if !found {
		return nil, false
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, false
	}
	if len(data) == 0 || data[0] != '[' {
		return nil, false
	}
	var sessions []sessionRecord
	if json.Unmarshal(data, &sessions) != nil {
		return nil, false
	}
	return sessions, true
}
