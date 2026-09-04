package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const loginWindow = time.Minute
const maxLoginFailures = 8
const maxLoginLimiterEntries = 10000
const accountTokenTTL = 30 * 24 * time.Hour
const accountCookieName = "codeharbor_session"
const revokedTokenKeyPrefix = "codeharbor:revoked-token:"
const revokedDeviceKeyPrefix = "codeharbor:revoked-device:"

var loginLimiter = struct {
	sync.Mutex
	attempts map[string]loginAttempt
}{attempts: map[string]loginAttempt{}}

type loginAttempt struct {
	started  time.Time
	failures int
}

type accountTokenPayload struct {
	User      string `json:"u"`
	ExpiresAt string `json:"e"`
	Nonce     string `json:"n"`
}

type sessionRecord struct {
	ID                string `json:"id"`
	DeviceID          string `json:"deviceId,omitempty"`
	OwnerUser         string `json:"-"`
	Status            string `json:"status,omitempty"`
	Title             string `json:"title,omitempty"`
	WorkspacePath     string `json:"workspacePath,omitempty"`
	UpdatedAt         string `json:"updatedAt"`
	SessionPolicyMode string `json:"sessionPolicyMode,omitempty"`
}

func registerAPI(mux *http.ServeMux, r *relay) {
	registerDeviceRevocationAPI(mux, r)
	mux.HandleFunc("/api/v1/protocol", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodGet) {
			return
		}
		writeJSON(w, map[string]any{
			"protocolVersion": "codeharbor.gateway.v1",
			"revision":        2,
			"transports":      map[string]any{"browser": []string{"https", "wss"}, "gateway": []string{"wss"}},
			"websocketPath":   "/ws",
			"features":        []string{"session-sync", "event-seq", "resume", "history-gap", "approval", "device-enrollment", "device-revocation", "pairing-code", "account-registration", "model-list", "cookie-auth", "ws-subprotocol-auth", "full-access-confirmation"},
		})
	})
	mux.HandleFunc("/api/v1/auth/register", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodPost) {
			return
		}
		ip := requestIP(req)
		allowed, limiterErr := r.loginAllowed(req.Context(), ip)
		if limiterErr != nil {
			writeError(w, http.StatusServiceUnavailable, "rate_limiter_unavailable")
			return
		}
		if !allowed {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "login_rate_limited")
			return
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 16<<10))
		if decoder.Decode(&body) != nil {
			r.recordLoginFailure(req.Context(), ip)
			writeError(w, http.StatusBadRequest, "invalid_account")
			return
		}
		username, valid := normalizeAccountUsername(body.Username)
		if !valid || !validAccountPassword(body.Password) {
			r.recordLoginFailure(req.Context(), ip)
			writeError(w, http.StatusBadRequest, "invalid_account")
			return
		}
		if err := r.store.createAccount(req.Context(), username, body.Password); err != nil {
			if errors.Is(err, errAccountExists) {
				writeError(w, http.StatusConflict, "account_exists")
				return
			}
			writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		r.clearLoginFailures(req.Context(), ip)
		token := issueToken(username)
		setAuthCookie(w, token, accountTokenTTL)
		writeJSON(w, map[string]any{"token": token, "username": username, "expiresInSeconds": int(accountTokenTTL / time.Second)})
	})
	mux.HandleFunc("/api/v1/auth/login", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodPost) {
			return
		}
		ip := requestIP(req)
		allowed, limiterErr := r.loginAllowed(req.Context(), ip)
		if limiterErr != nil {
			writeError(w, http.StatusServiceUnavailable, "rate_limiter_unavailable")
			return
		}
		if !allowed {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "login_rate_limited")
			return
		}
		var body struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Token    string `json:"token"`
		}
		limited := http.MaxBytesReader(w, req.Body, 16<<10)
		if json.NewDecoder(limited).Decode(&body) != nil {
			r.recordLoginFailure(req.Context(), ip)
			writeError(w, http.StatusUnauthorized, "invalid_credentials")
			return
		}
		if strings.TrimSpace(body.Token) != "" {
			user := configuredAdminUser()
			if user == "" {
				writeError(w, http.StatusServiceUnavailable, "account_not_configured")
				return
			}
			deviceID, err := r.store.consumePairCode(req.Context(), body.Token, user)
			if err == nil {
				r.mu.RLock()
				device := r.devices[deviceID]
				r.mu.RUnlock()
				if device != nil {
					if !r.bindDeviceOwner(device, user) {
						device.stop()
					} else {
						// The device may have synced while it was still unpaired.
						// Tell that live Gateway to publish its authoritative session
						// snapshot now that ownership is established.
						device.sendJSON(map[string]any{"type": "device-owner-bound", "deviceId": deviceID, "ownerUser": user})
					}
				}
				if r.redis != nil {
					_ = r.publish(deviceOwnershipChannel, map[string]any{"deviceId": deviceID, "ownerUser": user})
				}
				r.clearLoginFailures(req.Context(), ip)
				token := issueToken(user)
				setAuthCookie(w, token, accountTokenTTL)
				writeJSON(w, map[string]any{"token": token, "deviceId": deviceID, "expiresInSeconds": int(accountTokenTTL / time.Second)})
				return
			}
			if !errors.Is(err, errPairCodeInvalid) && !errors.Is(err, errPairCodeOwned) && !errors.Is(err, errDeviceRevoked) {
				writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			r.recordLoginFailure(req.Context(), ip)
			writeError(w, http.StatusUnauthorized, "invalid_pair_code")
			return
		}
		username, validUsername := normalizeAccountUsername(body.Username)
		accountValid, accountErr := r.store.authenticateAccount(req.Context(), username, body.Password)
		if accountErr != nil {
			writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		configuredAdmin := configuredAdminUser()
		adminValid := configuredAdmin != "" && body.Username == configuredAdmin && body.Password != "" && secureStringEqual(body.Password, os.Getenv("CODEHARBOR_ADMIN_PASSWORD"))
		if !validUsername || (!accountValid && !adminValid) {
			r.recordLoginFailure(req.Context(), ip)
			writeError(w, http.StatusUnauthorized, "invalid_credentials")
			return
		}
		r.clearLoginFailures(req.Context(), ip)
		if adminValid {
			username = configuredAdmin
		}
		token := issueToken(username)
		setAuthCookie(w, token, accountTokenTTL)
		writeJSON(w, map[string]any{"token": token, "username": username, "expiresInSeconds": int(accountTokenTTL / time.Second)})
	})
	mux.HandleFunc("/api/v1/auth/session-token", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodGet) {
			return
		}
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		token := issueToken(user)
		setAuthCookie(w, token, accountTokenTTL)
		writeJSON(w, map[string]any{"token": token, "expiresInSeconds": int(accountTokenTTL / time.Second)})
	})
	mux.HandleFunc("/api/v1/auth/refresh", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		token := issueToken(user)
		setAuthCookie(w, token, accountTokenTTL)
		writeJSON(w, map[string]any{"token": token, "expiresInSeconds": int(accountTokenTTL / time.Second)})
	})
	mux.HandleFunc("/api/v1/auth/logout", func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		// Logout must remain reachable when Redis is unavailable so the local
		// token is revoked before returning a consistency error to the client.
		if _, ok := apiPrincipal(req); !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		token := authenticatedRequestToken(req)
		expiresAt, signedToken := tokenExpiry(token)
		if signedToken {
			if err := r.store.revokeToken(req.Context(), token, expiresAt); err != nil {
				writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			r.disconnectBrowsersByTokenHash(hex.EncodeToString(hashCredential(token)))
		}
		clearAuthCookie(w)
		if r.redis != nil && signedToken {
			if err := r.setSharedRevocation(req.Context(), token, expiresAt); err != nil {
				writeError(w, http.StatusServiceUnavailable, "revocation_unavailable")
				return
			}
			ctx, cancel := redisOperationContext()
			publishErr := r.redis.Publish(ctx, authRevocationsChannel, mustJSON(map[string]any{
				"tokenHash": hex.EncodeToString(hashCredential(token)), "expiresAt": expiresAt,
			})).Err()
			cancel()
			if publishErr != nil {
				writeError(w, http.StatusServiceUnavailable, "revocation_unavailable")
				return
			}
		}
		writeJSON(w, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/v1/devices/enroll", func(w http.ResponseWriter, req *http.Request) {
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if req.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		var body struct {
			DeviceID   string `json:"deviceId"`
			DeviceName string `json:"deviceName"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 8<<10))
		if decoder.Decode(&body) != nil {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		device, deviceToken, err := r.store.enrollDevice(req.Context(), user, body.DeviceID, body.DeviceName)
		if err != nil {
			writeDeviceError(w, err)
			return
		}
		writeJSON(w, map[string]any{"deviceId": device.ID, "deviceName": device.Name, "deviceToken": deviceToken})
	})
	mux.HandleFunc("/api/v1/devices", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodGet) {
			return
		}
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		values, err := r.store.listDevices(req.Context(), user)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		r.mu.RLock()
		online := make(map[string]bool, len(r.devices))
		for id, peer := range r.devices {
			online[id] = peer.ownerUser == user
		}
		r.mu.RUnlock()
		redisCtx, cancelRedis := redisRequestContext(req.Context())
		defer cancelRedis()
		truncated := len(values) > maxDeviceListItems
		if truncated {
			values = values[:maxDeviceListItems]
		}
		devices := make([]map[string]any, 0, len(values))
		for _, device := range values {
			if device.RevokedAt != nil {
				continue
			}
			connected := online[device.ID]
			if !connected && r.redis != nil {
				owner, err := r.redis.Get(redisCtx, devicePresenceKey(device.ID)).Result()
				connected = err == nil && strings.SplitN(owner, "|", 2)[0] == user
			}
			devices = append(devices, map[string]any{"deviceId": device.ID, "deviceName": device.Name, "connected": connected})
		}
		writeJSON(w, map[string]any{"devices": devices, "truncated": truncated})
	})
	mux.HandleFunc("/api/v1/sessions", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodGet) {
			return
		}
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		values, err := r.store.listSessionsForUser(req.Context(), user)
		if err != nil {
			writeError(w, 503, "storage_unavailable")
			return
		}
		truncated := len(values) > maxSessionListItems
		if truncated {
			values = values[:maxSessionListItems]
		}
		writeJSON(w, map[string]any{"sessions": values, "truncated": truncated})
	})
	mux.HandleFunc("/api/v1/sessions/", func(w http.ResponseWriter, req *http.Request) {
		if !requireMethod(w, req, http.MethodGet) {
			return
		}
		user, ok := r.apiPrincipal(req)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		path := strings.TrimPrefix(req.URL.Path, "/api/v1/sessions/")
		if !strings.HasSuffix(path, "/events") {
			writeError(w, 404, "not_found")
			return
		}
		id := strings.TrimSuffix(path, "/events")
		after, limit, parseErr := eventQuery(req)
		if parseErr != nil {
			writeError(w, http.StatusBadRequest, "invalid_event_cursor")
			return
		}
		page, err := r.store.listEventsForUserPage(req.Context(), id, user, after, limit+1)
		if err != nil {
			if errors.Is(err, errDeviceUnauthorized) {
				writeError(w, http.StatusForbidden, "forbidden")
				return
			}
			writeError(w, 503, "storage_unavailable")
			return
		}
		events := page.events
		truncated := page.truncated || len(events) > limit
		if len(events) > limit {
			events = events[:limit]
		}
		historyGap := false
		availableFrom := int64(0)
		if after > 0 {
			if first, _, boundsErr := r.store.eventBoundsForUser(req.Context(), id, user); boundsErr == nil && first > after+1 {
				historyGap = true
				availableFrom = first
			}
		}
		nextCursor := after
		if len(events) > 0 {
			if seq, ok := events[len(events)-1]["eventSeq"].(int64); ok && seq > nextCursor {
				nextCursor = seq
			}
		}
		response := map[string]any{"events": events, "nextCursor": nextCursor, "truncated": truncated}
		if historyGap {
			response["historyGap"] = true
			response["availableFrom"] = availableFrom
		}
		writeJSON(w, response)
	})
}

func requireMethod(w http.ResponseWriter, req *http.Request, method string) bool {
	if req.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
	return false
}

func eventQuery(req *http.Request) (int64, int, error) {
	query := req.URL.Query()
	after := int64(0)
	if raw := query.Get("after"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			return 0, 0, errors.New("invalid_after")
		}
		after = parsed
	}
	limit := 1000
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 5000 {
			return 0, 0, errors.New("invalid_limit")
		}
		limit = parsed
	}
	return after, limit, nil
}

func secureStringEqual(left, right string) bool {
	return hmac.Equal([]byte(left), []byte(right))
}

func normalizeAccountUsername(raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if len(value) < 3 || len(value) > 64 {
		return "", false
	}
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '.' && char != '_' && char != '-' {
			return "", false
		}
	}
	return value, true
}

func validAccountPassword(password string) bool {
	if len(password) < 12 || len(password) > 256 {
		return false
	}
	for _, char := range password {
		if char < 0x20 || char == 0x7f {
			return false
		}
	}
	return true
}

func configuredAdminUser() string {
	return strings.TrimSpace(os.Getenv("CODEHARBOR_ADMIN_USER"))
}

func authorizedAPI(req *http.Request) bool {
	_, ok := apiPrincipal(req)
	return ok
}

// apiPrincipal returns the account embedded in a signed login token. The
// fixed cloud token remains an explicit migration/admin credential and is
// mapped to the configured admin account for ownership checks.
func apiPrincipal(req *http.Request) (string, bool) {
	if user, ok := tokenUser(req.Header.Get("Authorization")); ok {
		return user, true
	}
	if cookie, err := req.Cookie(accountCookieName); err == nil {
		if user, ok := tokenUser("Bearer " + cookie.Value); ok {
			return user, true
		}
	}
	cloudToken := os.Getenv("CODEHARBOR_CLOUD_TOKEN")
	if cloudToken != "" && req.Header.Get("Authorization") == "Bearer "+cloudToken {
		user := configuredAdminUser()
		return user, user != ""
	}
	return "", false
}

func (r *relay) apiPrincipal(req *http.Request) (string, bool) {
	user, ok := apiPrincipal(req)
	if !ok {
		return "", false
	}
	token := authenticatedRequestToken(req)
	if token == "" || token == os.Getenv("CODEHARBOR_CLOUD_TOKEN") || r.redis == nil {
		return user, true
	}
	revoked, err := r.sharedTokenRevoked(req.Context(), token)
	if err != nil || revoked {
		return "", false
	}
	return user, true
}

func authenticatedRequestToken(req *http.Request) string {
	if token := strings.TrimSpace(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")); token != "" {
		if _, ok := tokenUser("Bearer " + token); ok || token == os.Getenv("CODEHARBOR_CLOUD_TOKEN") {
			return token
		}
	}
	if cookie, err := req.Cookie(accountCookieName); err == nil {
		token := strings.TrimSpace(cookie.Value)
		if _, ok := tokenUser("Bearer " + token); ok {
			return token
		}
	}
	return ""
}

func revokedTokenKey(token string) string {
	return revokedTokenKeyPrefix + hex.EncodeToString(hashCredential(token))
}

func revokedDeviceKey(deviceID string) string {
	return revokedDeviceKeyPrefix + hex.EncodeToString(hashCredential(deviceID))
}

func (r *relay) setSharedDeviceRevocation(parent context.Context, deviceID string) error {
	if r.redis == nil || deviceID == "" {
		return nil
	}
	ctx, cancel := redisRequestContext(parent)
	defer cancel()
	return r.redis.Set(ctx, revokedDeviceKey(deviceID), "1", 0).Err()
}

func (r *relay) setSharedRevocation(parent context.Context, token string, expiresAt time.Time) error {
	if r.redis == nil || token == "" {
		return nil
	}
	ttl := time.Until(expiresAt)
	if ttl <= 0 {
		return nil
	}
	ctx, cancel := redisRequestContext(parent)
	defer cancel()
	return r.redis.Set(ctx, revokedTokenKey(token), "1", ttl).Err()
}

func (r *relay) sharedTokenRevoked(parent context.Context, token string) (bool, error) {
	if isTokenRevoked(token) {
		return true, nil
	}
	if r.redis == nil || token == "" {
		return false, nil
	}
	ctx, cancel := redisRequestContext(parent)
	defer cancel()
	value, err := r.redis.Exists(ctx, revokedTokenKey(token)).Result()
	if err != nil {
		return false, err
	}
	return value > 0, nil
}

func setAuthCookie(w http.ResponseWriter, token string, ttl time.Duration) {
	secure := os.Getenv("NODE_ENV") == "production"
	http.SetCookie(w, &http.Cookie{
		Name:     accountCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(ttl / time.Second),
		Expires:  time.Now().Add(ttl),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearAuthCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: accountCookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: os.Getenv("NODE_ENV") == "production", SameSite: http.SameSiteStrictMode})
}

func requestAuthToken(req *http.Request) string {
	if token := strings.TrimSpace(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer ")); token != "" {
		return token
	}
	if cookie, err := req.Cookie(accountCookieName); err == nil {
		return strings.TrimSpace(cookie.Value)
	}
	return ""
}
func issueToken(user string) string {
	// A timestamp is not a sufficient token nonce: two logins can be issued
	// inside the clock's effective resolution. A random nonce keeps revocation
	// of one login from invalidating a later login for the same account.
	nonce, err := randomToken()
	if err != nil {
		nonce = strconv.FormatInt(time.Now().UnixNano(), 10)
	}
	raw, _ := json.Marshal(accountTokenPayload{
		User:      user,
		ExpiresAt: time.Now().Add(accountTokenTTL).UTC().Format(time.RFC3339Nano),
		Nonce:     nonce,
	})
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(env("CODEHARBOR_AUTH_SECRET", env("CODEHARBOR_CLOUD_TOKEN", "development-only-secret"))))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func verifyToken(value string) bool {
	_, ok := tokenUser(value)
	return ok
}

func tokenUser(value string) (string, bool) {
	parts := strings.Split(strings.TrimPrefix(value, "Bearer "), ".")
	if len(parts) != 2 {
		return "", false
	}
	mac := hmac.New(sha256.New, []byte(env("CODEHARBOR_AUTH_SECRET", env("CODEHARBOR_CLOUD_TOKEN", "development-only-secret"))))
	mac.Write([]byte(parts[0]))
	expected, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(expected, mac.Sum(nil)) {
		return "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	var structured accountTokenPayload
	if json.Unmarshal(decoded, &structured) == nil && structured.User != "" && structured.ExpiresAt != "" {
		expiry, parseErr := time.Parse(time.RFC3339Nano, structured.ExpiresAt)
		if parseErr != nil || !expiry.After(time.Now()) || isTokenRevoked(strings.TrimPrefix(value, "Bearer ")) {
			return "", false
		}
		return structured.User, true
	}
	text := string(decoded)
	separator := strings.LastIndexByte(text, '|')
	if separator <= 0 || separator == len(text)-1 {
		return "", false
	}
	expiry, err := time.Parse(time.RFC3339Nano, text[separator+1:])
	if err != nil || !expiry.After(time.Now()) {
		return "", false
	}
	if isTokenRevoked(strings.TrimPrefix(value, "Bearer ")) {
		return "", false
	}
	return text[:separator], true
}

func tokenExpiry(value string) (time.Time, bool) {
	parts := strings.Split(strings.TrimPrefix(value, "Bearer "), ".")
	if len(parts) != 2 {
		return time.Time{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return time.Time{}, false
	}
	var structured accountTokenPayload
	if json.Unmarshal(decoded, &structured) == nil && structured.ExpiresAt != "" {
		expiresAt, parseErr := time.Parse(time.RFC3339Nano, structured.ExpiresAt)
		return expiresAt, parseErr == nil
	}
	separator := strings.LastIndexByte(string(decoded), '|')
	if separator <= 0 || separator == len(decoded)-1 {
		return time.Time{}, false
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, string(decoded[separator+1:]))
	return expiresAt, err == nil
}

func isTokenRevoked(token string) bool {
	hash := hashCredential(token)
	key := hex.EncodeToString(hash)
	now := time.Now()
	revokedTokens.RLock()
	expires, ok := revokedTokens.values[key]
	revokedTokens.RUnlock()
	if ok && expires.After(now) {
		return true
	}
	if ok {
		revokedTokens.Lock()
		delete(revokedTokens.values, key)
		revokedTokens.Unlock()
	}
	return false
}

func rememberRevokedHash(hash string, expiresAt time.Time) {
	if hash == "" || expiresAt.Before(time.Now()) {
		return
	}
	revokedTokens.Lock()
	revokedTokens.values[hash] = expiresAt
	revokedTokens.Unlock()
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func writeDeviceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvalidDeviceID):
		writeError(w, http.StatusBadRequest, "invalid_device_id")
	case errors.Is(err, errDeviceOwned):
		writeError(w, http.StatusConflict, "device_owned")
	case errors.Is(err, errDeviceRevoked):
		writeError(w, http.StatusGone, "device_revoked")
	case errors.Is(err, errDeviceUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	default:
		writeError(w, http.StatusServiceUnavailable, "storage_unavailable")
	}
}
func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("content-type", "application/json")
	// API responses include account-scoped session/device data and, for login,
	// bearer credentials. Never let an intermediary cache or replay them.
	w.Header().Set("cache-control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	writeJSON(w, map[string]string{"error": message})
}

func requestIP(req *http.Request) string {
	if os.Getenv("CODEHARBOR_TRUST_PROXY") == "true" {
		if forwarded := strings.Split(req.Header.Get("X-Forwarded-For"), ",")[0]; net.ParseIP(strings.TrimSpace(forwarded)) != nil {
			return strings.TrimSpace(forwarded)
		}
		if realIP := strings.TrimSpace(req.Header.Get("X-Real-IP")); net.ParseIP(realIP) != nil {
			return realIP
		}
	}
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	if req.RemoteAddr != "" {
		return req.RemoteAddr
	}
	return "unknown"
}

func allowLogin(ip string) bool {
	now := time.Now()
	loginLimiter.Lock()
	defer loginLimiter.Unlock()
	for key, attempt := range loginLimiter.attempts {
		if now.Sub(attempt.started) > 10*loginWindow {
			delete(loginLimiter.attempts, key)
		}
	}
	attempt, ok := loginLimiter.attempts[ip]
	if !ok || now.Sub(attempt.started) >= loginWindow {
		return true
	}
	return attempt.failures < maxLoginFailures
}

func recordLoginFailure(ip string) {
	now := time.Now()
	loginLimiter.Lock()
	defer loginLimiter.Unlock()
	if len(loginLimiter.attempts) >= maxLoginLimiterEntries {
		// Preserve a hard bound when source addresses rotate.
		for key := range loginLimiter.attempts {
			delete(loginLimiter.attempts, key)
			break
		}
	}
	attempt := loginLimiter.attempts[ip]
	if attempt.started.IsZero() || now.Sub(attempt.started) >= loginWindow {
		attempt = loginAttempt{started: now}
	}
	attempt.failures++
	loginLimiter.attempts[ip] = attempt
}

func clearLoginFailures(ip string) {
	loginLimiter.Lock()
	delete(loginLimiter.attempts, ip)
	loginLimiter.Unlock()
}

const loginRateKeyPrefix = "codeharbor:login-failures:"

func loginRateKey(ip string) string {
	return loginRateKeyPrefix + hex.EncodeToString(hashCredential(ip))
}

// loginAllowed uses Redis when configured so all Relay instances share the
// same failure bucket. A Redis error is returned to the caller rather than
// silently falling back to per-instance state in production.
func (r *relay) loginAllowed(ctx context.Context, ip string) (bool, error) {
	if r.redis == nil {
		return allowLogin(ip), nil
	}
	redisCtx, cancel := redisRequestContext(ctx)
	defer cancel()
	count, err := r.redis.Get(redisCtx, loginRateKey(ip)).Int()
	if errors.Is(err, redis.Nil) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return count < maxLoginFailures, nil
}

func (r *relay) recordLoginFailure(ctx context.Context, ip string) {
	if r.redis == nil {
		recordLoginFailure(ip)
		return
	}
	redisCtx, cancel := redisRequestContext(ctx)
	defer cancel()
	key := loginRateKey(ip)
	pipe := r.redis.TxPipeline()
	pipe.Incr(redisCtx, key)
	pipe.Expire(redisCtx, key, loginWindow)
	if _, err := pipe.Exec(redisCtx); err != nil {
		// Keep a local fallback bucket during a transient Redis outage. The
		// admission check above remains fail-closed, so this cannot disable
		// protection for subsequent requests.
		recordLoginFailure(ip)
	}
}

func (r *relay) clearLoginFailures(ctx context.Context, ip string) {
	if r.redis == nil {
		clearLoginFailures(ip)
		return
	}
	redisCtx, cancel := redisRequestContext(ctx)
	defer cancel()
	if err := r.redis.Del(redisCtx, loginRateKey(ip)).Err(); err != nil {
		clearLoginFailures(ip)
	}
}
