package main

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const pairCodeTTL = 10 * time.Minute
const pairCodeLength = 6
const pairCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

var (
	errPairCodeInvalid = errors.New("pair_code_invalid")
	errPairCodeOwned   = errors.New("pair_code_owned")
)

type pairCodeRecord struct {
	Hash      string
	DeviceID  string
	ExpiresAt time.Time
	Used      bool
}

type pairCodeInfo struct {
	Code      string
	ExpiresAt time.Time
}

func (s *store) createPairCode(ctx context.Context, deviceID string) (pairCodeInfo, error) {
	deviceID = strings.TrimSpace(deviceID)
	if deviceID == "" {
		return pairCodeInfo{}, errDeviceNotFound
	}
	code, err := randomPairCode()
	if err != nil {
		return pairCodeInfo{}, err
	}
	expiresAt := time.Now().UTC().Add(pairCodeTTL)
	hash := string(hashCredential(code))
	if s.pool == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.memoryPairCodes == nil {
			s.memoryPairCodes = map[string]pairCodeRecord{}
		}
		device, ok := s.memoryDevices[deviceID]
		if !ok || device.RevokedAt != nil {
			return pairCodeInfo{}, errDeviceNotFound
		}
		if device.OwnerUser != "" {
			return pairCodeInfo{}, errPairCodeOwned
		}
		for key, value := range s.memoryPairCodes {
			if value.DeviceID == deviceID && !value.Used {
				value.Used = true
				s.memoryPairCodes[key] = value
			}
		}
		s.memoryPairCodes[hash] = pairCodeRecord{Hash: hash, DeviceID: deviceID, ExpiresAt: expiresAt}
		return pairCodeInfo{Code: code, ExpiresAt: expiresAt}, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return pairCodeInfo{}, err
	}
	defer tx.Rollback(ctx)
	var owner string
	var revokedAt *time.Time
	if err = tx.QueryRow(ctx, `SELECT COALESCE(owner_user,''),revoked_at FROM relay_devices WHERE id=$1 FOR UPDATE`, deviceID).Scan(&owner, &revokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return pairCodeInfo{}, errDeviceNotFound
		}
		return pairCodeInfo{}, err
	}
	if revokedAt != nil {
		return pairCodeInfo{}, errDeviceRevoked
	}
	if owner != "" {
		return pairCodeInfo{}, errPairCodeOwned
	}
	if _, err = tx.Exec(ctx, `UPDATE pair_codes SET used_at=now() WHERE device_id=$1 AND used_at IS NULL`, deviceID); err != nil {
		return pairCodeInfo{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pair_codes(code_hash,device_id,expires_at) VALUES($1,$2,$3)`, []byte(hash), deviceID, expiresAt); err != nil {
		return pairCodeInfo{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return pairCodeInfo{}, err
	}
	return pairCodeInfo{Code: code, ExpiresAt: expiresAt}, nil
}

func (s *store) activePairCode(ctx context.Context, deviceID string) (pairCodeInfo, bool) {
	if s.pool == nil {
		s.mu.RLock()
		defer s.mu.RUnlock()
		for _, value := range s.memoryPairCodes {
			if value.DeviceID == deviceID && !value.Used && value.ExpiresAt.After(time.Now()) {
				return pairCodeInfo{ExpiresAt: value.ExpiresAt}, true
			}
		}
		return pairCodeInfo{}, false
	}
	var expiresAt time.Time
	var hash []byte
	if err := s.pool.QueryRow(ctx, `SELECT code_hash,expires_at FROM pair_codes WHERE device_id=$1 AND used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, deviceID).Scan(&hash, &expiresAt); err != nil {
		return pairCodeInfo{}, false
	}
	// The raw code is intentionally never persisted, so only the expiry can be
	// recovered after restart. The Gateway receives the code on the original
	// device-ready response; callers should request a new code when absent.
	return pairCodeInfo{ExpiresAt: expiresAt}, len(hash) > 0
}

func (s *store) consumePairCode(ctx context.Context, code, ownerUser string) (string, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	ownerUser = strings.TrimSpace(ownerUser)
	if len(code) != pairCodeLength || ownerUser == "" {
		return "", errPairCodeInvalid
	}
	hash := string(hashCredential(code))
	if s.pool == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		value, ok := s.memoryPairCodes[hash]
		if !ok || value.Used || !value.ExpiresAt.After(time.Now()) {
			return "", errPairCodeInvalid
		}
		device, ok := s.memoryDevices[value.DeviceID]
		if !ok || device.RevokedAt != nil {
			return "", errPairCodeInvalid
		}
		if device.OwnerUser != "" && device.OwnerUser != ownerUser {
			return "", errPairCodeOwned
		}
		device.OwnerUser = ownerUser
		s.memoryDevices[value.DeviceID] = device
		value.Used = true
		s.memoryPairCodes[hash] = value
		return value.DeviceID, nil
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	var deviceID string
	var expiresAt time.Time
	var usedAt *time.Time
	if err = tx.QueryRow(ctx, `SELECT device_id,expires_at,used_at FROM pair_codes WHERE code_hash=$1 FOR UPDATE`, []byte(hash)).Scan(&deviceID, &expiresAt, &usedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", errPairCodeInvalid
		}
		return "", err
	}
	if usedAt != nil || !expiresAt.After(time.Now()) {
		return "", errPairCodeInvalid
	}
	var existingOwner string
	var revokedAt *time.Time
	if err = tx.QueryRow(ctx, `SELECT COALESCE(owner_user,''),revoked_at FROM relay_devices WHERE id=$1 FOR UPDATE`, deviceID).Scan(&existingOwner, &revokedAt); err != nil {
		return "", err
	}
	if revokedAt != nil {
		return "", errPairCodeInvalid
	}
	if existingOwner != "" && existingOwner != ownerUser {
		return "", errPairCodeOwned
	}
	if _, err = tx.Exec(ctx, `UPDATE relay_devices SET owner_user=$2,updated_at=now() WHERE id=$1`, deviceID, ownerUser); err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `UPDATE pair_codes SET used_at=now() WHERE code_hash=$1`, []byte(hash)); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return deviceID, nil
}

func randomPairCode() (string, error) {
	bytes := make([]byte, pairCodeLength)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	for index := range bytes {
		bytes[index] = pairCodeAlphabet[int(bytes[index])%len(pairCodeAlphabet)]
	}
	return string(bytes), nil
}
