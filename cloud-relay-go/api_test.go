package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestSignedSessionToken(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	token := issueToken("user-1")
	if !verifyToken("Bearer " + token) {
		t.Fatal("issued token should verify")
	}
	if verifyToken("Bearer " + token + "x") {
		t.Fatal("tampered token should fail")
	}
}

func TestRelayAPIRejectsUnsupportedMethods(t *testing.T) {
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/protocol", nil)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusMethodNotAllowed || res.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("method response = %d allow=%q", res.Code, res.Header().Get("Allow"))
	}
}

func TestRequestIPUsesForwardedAddressOnlyWhenTrusted(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.9:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.8")
	if got := requestIP(req); got != "10.0.0.9" {
		t.Fatalf("untrusted forwarded IP = %q", got)
	}
	t.Setenv("CODEHARBOR_TRUST_PROXY", "true")
	if got := requestIP(req); got != "203.0.113.7" {
		t.Fatalf("trusted forwarded IP = %q", got)
	}
}

func TestIssuedAccountTokenUsesThirtyDayTTL(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	token := issueToken("user-1")
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		t.Fatalf("unexpected token format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var structured accountTokenPayload
	if err := json.Unmarshal(payload, &structured); err != nil {
		t.Fatalf("token payload should be structured JSON: %v", err)
	}
	if structured.User == "" || structured.Nonce == "" {
		t.Fatalf("token payload missing identity nonce: %#v", structured)
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, structured.ExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	remaining := time.Until(expiresAt)
	if remaining < 29*24*time.Hour || remaining > 31*24*time.Hour {
		t.Fatalf("token TTL = %s, want approximately 30 days", remaining)
	}
}

func TestIssuedAccountTokensAreUniqueWithinSameTimeWindow(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	first := issueToken("user-1")
	second := issueToken("user-1")
	if first == second {
		t.Fatal("separate logins must not produce the same bearer token")
	}
	if !verifyToken("Bearer "+first) || !verifyToken("Bearer "+second) {
		t.Fatal("both freshly issued tokens should verify")
	}
}

func TestAccountTokenRefreshExtendsValidSession(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	initial := issueToken("user-1")
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	req.Header.Set("Authorization", "Bearer "+initial)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, want 200", res.Code)
	}
	var body struct {
		Token   string `json:"token"`
		Expires int    `json:"expiresInSeconds"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Token == "" || !verifyToken("Bearer "+body.Token) {
		t.Fatal("refresh should return a valid token")
	}
	if body.Expires != int(accountTokenTTL/time.Second) {
		t.Fatalf("refresh TTL = %d, want %d", body.Expires, int(accountTokenTTL/time.Second))
	}
}

func TestCookieSessionTokenCanBootstrapWebSocketCredential(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	t.Setenv("NODE_ENV", "test")
	token := issueToken("user-1")
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session-token", nil)
	req.AddCookie(&http.Cookie{Name: accountCookieName, Value: token})
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("cookie session-token status = %d: %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Header().Get("Set-Cookie"), accountCookieName+"=") {
		t.Fatalf("session-token response did not refresh auth cookie: %q", res.Header().Get("Set-Cookie"))
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Token == "" || !verifyToken("Bearer "+body.Token) {
		t.Fatal("cookie session-token should return a valid signed token")
	}
}

func TestAccountTokenLogoutRevokesToken(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	t.Setenv("CODEHARBOR_ADMIN_USER", "user-1")
	token := issueToken("user-1")
	mux := http.NewServeMux()
	muxStore := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}
	registerAPI(mux, &relay{store: muxStore})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("logout status = %d, want 200: %s", res.Code, res.Body.String())
	}
	if verifyToken("Bearer " + token) {
		t.Fatal("revoked token should fail verification")
	}
	refresh := httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", nil)
	refresh.Header.Set("Authorization", "Bearer "+token)
	refreshRes := httptest.NewRecorder()
	mux.ServeHTTP(refreshRes, refresh)
	if refreshRes.Code != http.StatusUnauthorized {
		t.Fatalf("refresh with revoked token status = %d, want 401", refreshRes.Code)
	}
}

func TestCookieOnlyLogoutRevokesTokenAndClearsCookie(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	t.Setenv("NODE_ENV", "test")
	token := issueToken("user-1")
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: accountCookieName, Value: token})
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("cookie logout status = %d: %s", res.Code, res.Body.String())
	}
	if verifyToken("Bearer " + token) {
		t.Fatal("cookie logout should revoke the signed token")
	}
	if !strings.Contains(res.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("cookie logout did not clear auth cookie: %q", res.Header().Get("Set-Cookie"))
	}
}

func TestCookieLogoutIgnoresInvalidAuthorizationHeader(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	token := issueToken("user-cookie")
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer invalid-header")
	req.AddCookie(&http.Cookie{Name: accountCookieName, Value: token})
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("cookie logout status = %d: %s", res.Code, res.Body.String())
	}
	if verifyToken("Bearer " + token) {
		t.Fatal("valid cookie token must be revoked even when an invalid bearer header is present")
	}
}

func TestRedisAuthRevocationWithoutOwnerIsApplied(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	token := issueToken("user-1")
	expiresAt, ok := tokenExpiry(token)
	if !ok {
		t.Fatal("issued token should expose an expiry")
	}
	hash := hex.EncodeToString(hashCredential(token))
	rememberRevokedHash(hash, expiresAt)
	// Remove the in-memory entry to prove the Redis handler is the path that
	// restores the revocation, matching a second Relay instance.
	revokedTokens.Lock()
	delete(revokedTokens.values, hash)
	revokedTokens.Unlock()
	handle := &relay{}
	handle.handleRedisMessage(authRevocationsChannel, string(mustJSON(map[string]any{
		"tokenHash": hash,
		"expiresAt": expiresAt,
	})))
	if verifyToken("Bearer " + token) {
		t.Fatal("revocation pub/sub message without owner should invalidate token")
	}
}

func TestSessionEventsExposeCursorPagination(t *testing.T) {
	store := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}, memoryEvents: map[string][]map[string]any{}}
	for index := 0; index < 3; index++ {
		if _, err := store.appendOwnedEvent(context.Background(), "session-1", "user-1", map[string]any{"type": "session-output", "payload": map[string]any{"index": index}}); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: store})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/session-1/events?limit=2", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("user-1"))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("events status = %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		Events     []map[string]any `json:"events"`
		NextCursor int64            `json:"nextCursor"`
		Truncated  bool             `json:"truncated"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Events) != 2 || body.NextCursor != 2 || !body.Truncated {
		t.Fatalf("unexpected page: %#v", body)
	}
}

func TestSessionEventsExposeTruncationAtMaximumPageSize(t *testing.T) {
	store := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}, memoryEvents: map[string][]map[string]any{}}
	for index := 0; index < 5001; index++ {
		if _, err := store.appendOwnedEvent(context.Background(), "session-large", "user-large", map[string]any{"type": "session-output", "index": index}); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: store})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/session-large/events?limit=5000", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("user-large"))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("events status = %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		Events     []map[string]any `json:"events"`
		NextCursor int64            `json:"nextCursor"`
		Truncated  bool             `json:"truncated"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Events) != 5000 || body.NextCursor != 5000 || !body.Truncated {
		t.Fatalf("unexpected maximum page: len=%d cursor=%d truncated=%v", len(body.Events), body.NextCursor, body.Truncated)
	}
}

func TestSessionEventsExposeByteTruncation(t *testing.T) {
	store := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}, memoryEvents: map[string][]map[string]any{}}
	large := strings.Repeat("x", 20<<20)
	for index := 0; index < 2; index++ {
		if _, err := store.appendOwnedEvent(context.Background(), "session-bytes", "user-bytes", map[string]any{"type": "session-output", "payload": large}); err != nil {
			t.Fatal(err)
		}
	}
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: store})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/session-bytes/events?limit=5000", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("user-bytes"))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("events status = %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		Events     []map[string]any `json:"events"`
		NextCursor int64            `json:"nextCursor"`
		Truncated  bool             `json:"truncated"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Events) != 1 || body.NextCursor != 1 || !body.Truncated {
		t.Fatalf("unexpected byte-truncated page: len=%d cursor=%d truncated=%v", len(body.Events), body.NextCursor, body.Truncated)
	}
}

func TestSessionEventsExposeHistoryGap(t *testing.T) {
	store := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}, memoryEvents: map[string][]map[string]any{}}
	for index := 0; index < 3; index++ {
		if _, err := store.appendOwnedEvent(context.Background(), "session-gap", "user-gap", map[string]any{"type": "session-output"}); err != nil {
			t.Fatal(err)
		}
	}
	store.mu.Lock()
	store.memoryEvents["session-gap"] = store.memoryEvents["session-gap"][2:]
	store.mu.Unlock()
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: store})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/session-gap/events?after=1", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("user-gap"))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("events status = %d: %s", res.Code, res.Body.String())
	}
	var body struct {
		HistoryGap    bool  `json:"historyGap"`
		AvailableFrom int64 `json:"availableFrom"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.HistoryGap || body.AvailableFrom != 3 {
		t.Fatalf("unexpected history gap metadata: %#v", body)
	}
}

func TestLogoutFailsClosedWhenSharedRevocationStoreUnavailable(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	token := issueToken("user-redis")
	store := &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}}
	redisClient := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 100 * time.Millisecond, ReadTimeout: 100 * time.Millisecond, WriteTimeout: 100 * time.Millisecond})
	t.Cleanup(func() { _ = redisClient.Close() })
	mux := http.NewServeMux()
	registerAPI(mux, &relay{store: store, redis: redisClient})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("logout status = %d, want 503: %s", res.Code, res.Body.String())
	}
	if verifyToken("Bearer " + token) {
		t.Fatal("local relay must still revoke token when shared store is unavailable")
	}
}
