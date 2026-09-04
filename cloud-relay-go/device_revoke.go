package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const deviceRevocationsChannel = "codeharbor:device-revocations"

func (s *store) revokeDevice(ctx context.Context, ownerUser, deviceID string) error {
	ownerUser = strings.TrimSpace(ownerUser)
	var valid bool
	deviceID, valid = normalizeDeviceID(deviceID)
	if ownerUser == "" {
		return errDeviceUnauthorized
	}
	if !valid {
		return errInvalidDeviceID
	}
	if s.pool == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		record, ok := s.memoryDevices[deviceID]
		if !ok || record.OwnerUser != ownerUser {
			return errDeviceUnauthorized
		}
		now := time.Now().UTC()
		record.RevokedAt = &now
		s.memoryDevices[deviceID] = record
		return nil
	}
	tag, err := s.pool.Exec(ctx, `UPDATE relay_devices SET revoked_at=now(),updated_at=now() WHERE id=$1 AND owner_user=$2 AND revoked_at IS NULL`, deviceID, ownerUser)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var revokedAt *time.Time
		queryErr := s.pool.QueryRow(ctx, `SELECT revoked_at FROM relay_devices WHERE id=$1 AND owner_user=$2`, deviceID, ownerUser).Scan(&revokedAt)
		if errors.Is(queryErr, pgx.ErrNoRows) {
			return errDeviceUnauthorized
		}
		return queryErr
	}
	return nil
}

func registerDeviceRevocationAPI(mux *http.ServeMux, r *relay) {
	mux.HandleFunc("/api/v1/devices/", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodPost) {
			return
		}
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		path := strings.TrimPrefix(req.URL.Path, "/api/v1/devices/")
		if !strings.HasSuffix(path, "/revoke") {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		deviceID := strings.TrimSuffix(path, "/revoke")
		if _, valid := normalizeDeviceID(deviceID); !valid {
			writeError(w, http.StatusBadRequest, "invalid_device_id")
			return
		}
		if err := r.store.revokeDevice(req.Context(), user, deviceID); err != nil {
			if errors.Is(err, errDeviceUnauthorized) || errors.Is(err, errDeviceNotFound) {
				writeError(w, http.StatusNotFound, "device_not_found")
				return
			}
			writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		r.disconnectOwnedDevice(deviceID, user)
		if r.redis != nil {
			if err := r.setSharedDeviceRevocation(req.Context(), deviceID); err != nil {
				writeError(w, http.StatusServiceUnavailable, "revocation_unavailable")
				return
			}
			if err := r.publish(deviceRevocationsChannel, map[string]any{"deviceId": deviceID, "ownerUser": user}); err != nil {
				writeError(w, http.StatusServiceUnavailable, "revocation_unavailable")
				return
			}
		}
		writeJSON(w, map[string]any{"ok": true, "deviceId": deviceID})
	})
}

func (r *relay) disconnectOwnedDevice(deviceID, ownerUser string) {
	r.mu.RLock()
	device := r.devices[deviceID]
	owned := device != nil && (device.ownerUser == ownerUser || device.ownerUser == "")
	r.mu.RUnlock()
	if owned {
		device.stop()
	}
}
