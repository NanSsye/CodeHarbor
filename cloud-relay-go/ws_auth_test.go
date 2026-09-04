package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestServeBrowserAcceptsSignedQueryToken(t *testing.T) {
	setBrowserWSEnv(t)
	server := newBrowserWSServer(t)
	defer server.Close()

	token := issueToken("user-1")
	conn, _, err := websocket.DefaultDialer.Dial(browserWSURL(server, token), nil)
	if err != nil {
		t.Fatalf("signed query token should allow websocket upgrade: %v", err)
	}
	defer conn.Close()

	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read cloud-ready: %v", err)
	}
	if ready["type"] != "cloud-ready" {
		t.Fatalf("unexpected ready message: %#v", ready)
	}
}

func TestServeBrowserAcceptsSignedSubprotocolToken(t *testing.T) {
	setBrowserWSEnv(t)
	server := newBrowserWSServer(t)
	defer server.Close()

	token := issueToken("user-1")
	parsed, _ := url.Parse(browserWSURL(server, ""))
	parsed.RawQuery = ""
	dialer := websocket.Dialer{Subprotocols: []string{"codeharbor-v1." + token}}
	conn, _, err := dialer.Dial(parsed.String(), nil)
	if err != nil {
		t.Fatalf("signed subprotocol token should allow websocket upgrade: %v", err)
	}
	defer conn.Close()
	if conn.Subprotocol() != "codeharbor-v1."+token {
		t.Fatalf("selected websocket subprotocol = %q, want codeharbor-v1 token", conn.Subprotocol())
	}
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read cloud-ready: %v", err)
	}
	if ready["type"] != "cloud-ready" {
		t.Fatalf("unexpected ready message: %#v", ready)
	}
}

func TestBrowserRequestTokenExtractsSubprotocolCredential(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "chat, codeharbor-v1.session-token")
	if got := browserRequestToken(req); got != "session-token" {
		t.Fatalf("browser request token = %q, want subprotocol credential", got)
	}
}

func TestServeBrowserAcceptsHttpOnlyCookieToken(t *testing.T) {
	setBrowserWSEnv(t)
	server := newBrowserWSServer(t)
	defer server.Close()

	token := issueToken("user-1")
	dialer := websocket.Dialer{}
	parsed, _ := url.Parse(browserWSURL(server, ""))
	parsed.RawQuery = ""
	conn, _, err := dialer.Dial(parsed.String(), http.Header{
		"Cookie": []string{accountCookieName + "=" + token},
	})
	if err != nil {
		t.Fatalf("cookie token should allow websocket upgrade: %v", err)
	}
	defer conn.Close()
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatalf("read cloud-ready: %v", err)
	}
	if ready["type"] != "cloud-ready" {
		t.Fatalf("unexpected ready message: %#v", ready)
	}
}

func TestServeBrowserRejectsInvalidQueryToken(t *testing.T) {
	setBrowserWSEnv(t)
	server := newBrowserWSServer(t)
	defer server.Close()

	_, response, err := websocket.DefaultDialer.Dial(browserWSURL(server, "not-a-token"), nil)
	if err == nil {
		t.Fatal("invalid query token should not upgrade websocket")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("invalid query token status = %v, want %d", responseStatus(response), http.StatusUnauthorized)
	}
}

func TestServeBrowserRejectsExpiredQueryToken(t *testing.T) {
	setBrowserWSEnv(t)
	server := newBrowserWSServer(t)
	defer server.Close()

	token := signedTokenWithExpiry(t, time.Now().Add(-time.Minute))
	_, response, err := websocket.DefaultDialer.Dial(browserWSURL(server, token), nil)
	if err == nil {
		t.Fatal("expired query token should not upgrade websocket")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expired query token status = %v, want %d", responseStatus(response), http.StatusUnauthorized)
	}
}

func TestBrowserWSRejectsRepeatedQueryTokens(t *testing.T) {
	setBrowserWSEnv(t)
	server := newBrowserWSServer(t)
	defer server.Close()

	parsed, _ := url.Parse(browserWSURL(server, issueToken("user-1")))
	query := parsed.Query()
	query.Add("token", issueToken("user-1"))
	parsed.RawQuery = query.Encode()
	_, response, err := websocket.DefaultDialer.Dial(parsed.String(), nil)
	if err == nil {
		t.Fatal("repeated query tokens should not upgrade websocket")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("repeated query token status = %v, want %d", responseStatus(response), http.StatusUnauthorized)
	}
}

func TestProductionDisablesQueryTokenUnlessExplicitlyEnabled(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	t.Setenv("CODEHARBOR_ADMIN_USER", "admin")
	t.Setenv("CODEHARBOR_ALLOW_QUERY_TOKEN", "")
	token := issueToken("user-1")
	req := httptest.NewRequest(http.MethodGet, "/ws?token="+url.QueryEscape(token), nil)
	if _, ok := browserPrincipal(req); ok {
		t.Fatal("production must reject query tokens by default")
	}
	t.Setenv("CODEHARBOR_ALLOW_QUERY_TOKEN", "true")
	if user, ok := browserPrincipal(req); !ok || user != "user-1" {
		t.Fatalf("explicit migration flag should allow query token, user=%q ok=%v", user, ok)
	}
}

func TestWebSocketOriginRequiresConfiguredOriginInProduction(t *testing.T) {
	t.Setenv("NODE_ENV", "production")
	t.Setenv("CODEHARBOR_ALLOWED_ORIGIN", "https://codex.example")
	withoutOrigin := httptest.NewRequest(http.MethodGet, "/ws", nil)
	if upgrader.CheckOrigin(withoutOrigin) {
		t.Fatal("production websocket without Origin should be rejected")
	}
	wrongOrigin := httptest.NewRequest(http.MethodGet, "/ws", nil)
	wrongOrigin.Header.Set("Origin", "https://evil.example")
	if upgrader.CheckOrigin(wrongOrigin) {
		t.Fatal("production websocket with wrong Origin should be rejected")
	}
	rightOrigin := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rightOrigin.Header.Set("Origin", "https://codex.example")
	if !upgrader.CheckOrigin(rightOrigin) {
		t.Fatal("production websocket with configured Origin should be accepted")
	}
}

func TestServeBrowserResumeReplaysOwnedEventsAfterCursor(t *testing.T) {
	setBrowserWSEnv(t)
	r := newMemoryRelay()
	if err := r.store.upsertSession(t.Context(), sessionRecord{ID: "session-1", OwnerUser: "user-1", DeviceID: "device-1", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.store.appendOwnedEvent(t.Context(), "session-1", "user-1", map[string]any{"type": "session-output", "sessionId": "session-1", "payload": map[string]any{"text": "hello"}}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(r.serveBrowser))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(browserWSURL(server, issueToken("user-1")), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "resume", "cursors": map[string]any{"session-1": 0}}); err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "session-output" || event["eventSeq"] != float64(1) {
		t.Fatalf("unexpected replay event: %#v", event)
	}
	var complete map[string]any
	if err := conn.ReadJSON(&complete); err != nil {
		t.Fatal(err)
	}
	if complete["type"] != "resume-complete" {
		t.Fatalf("unexpected resume completion: %#v", complete)
	}
}

func TestServeBrowserResumeSignalsRetainedHistoryGap(t *testing.T) {
	setBrowserWSEnv(t)
	r := newMemoryRelay()
	if err := r.store.upsertSession(t.Context(), sessionRecord{ID: "session-gap", OwnerUser: "user-1", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if _, err := r.store.appendOwnedEvent(t.Context(), "session-gap", "user-1", map[string]any{"type": "session-output", "sessionId": "session-gap"}); err != nil {
			t.Fatal(err)
		}
	}
	// Simulate an event-retention window that removed the first two rows while
	// the monotonic sequence counter remains at three.
	r.store.mu.Lock()
	r.store.memoryEvents["session-gap"] = r.store.memoryEvents["session-gap"][2:]
	r.store.mu.Unlock()
	server := httptest.NewServer(http.HandlerFunc(r.serveBrowser))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(browserWSURL(server, issueToken("user-1")), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "resume", "cursors": map[string]any{"session-gap": 1}}); err != nil {
		t.Fatal(err)
	}
	var gap map[string]any
	if err := conn.ReadJSON(&gap); err != nil {
		t.Fatal(err)
	}
	if gap["type"] != "history-gap" {
		t.Fatalf("first resume frame = %#v, want history-gap", gap)
	}
	var event map[string]any
	if err := conn.ReadJSON(&event); err != nil {
		t.Fatal(err)
	}
	if event["eventSeq"] != float64(3) {
		t.Fatalf("replayed event = %#v, want eventSeq 3", event)
	}
}

func TestServeBrowserResumeMarksFullFinalBatchAsTruncated(t *testing.T) {
	setBrowserWSEnv(t)
	r := newMemoryRelay()
	if err := r.store.upsertSession(t.Context(), sessionRecord{ID: "session-large", OwnerUser: "user-1", DeviceID: "device-1", UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 5001; index++ {
		if _, err := r.store.appendOwnedEvent(t.Context(), "session-large", "user-1", map[string]any{"type": "session-output", "sessionId": "session-large", "payload": map[string]any{"index": index}}); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(r.serveBrowser))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(browserWSURL(server, issueToken("user-1")), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "resume", "cursors": map[string]any{"session-large": 0}}); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 1000; index++ {
		var event map[string]any
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatalf("read replay event %d: %v", index, err)
		}
		if event["type"] != "session-output" {
			t.Fatalf("unexpected replay event %d: %#v", index, event)
		}
	}
	var complete map[string]any
	if err := conn.ReadJSON(&complete); err != nil {
		t.Fatal(err)
	}
	payload, _ := complete["payload"].(map[string]any)
	if complete["type"] != "resume-complete" || payload["truncated"] != true {
		t.Fatalf("resume should report truncation: %#v", complete)
	}
	cursors, _ := payload["cursors"].(map[string]any)
	if cursors["session-large"] != float64(1000) {
		t.Fatalf("resume cursor = %#v, want 1000", cursors["session-large"])
	}
}

func TestServeBrowserResumeBoundsCursorFanout(t *testing.T) {
	setBrowserWSEnv(t)
	r := newMemoryRelay()
	server := httptest.NewServer(http.HandlerFunc(r.serveBrowser))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(browserWSURL(server, issueToken("user-1")), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	cursors := make(map[string]any, maxResumeSessions+100)
	for index := 0; index < maxResumeSessions+100; index++ {
		cursors[fmt.Sprintf("session-%d", index)] = 0
	}
	if err := conn.WriteJSON(map[string]any{"type": "resume", "cursors": cursors}); err != nil {
		t.Fatal(err)
	}
	var complete map[string]any
	if err := conn.ReadJSON(&complete); err != nil {
		t.Fatal(err)
	}
	payload, _ := complete["payload"].(map[string]any)
	if complete["type"] != "resume-complete" || payload["truncated"] != true {
		t.Fatalf("resume should be truncated at cursor fanout limit: %#v", complete)
	}
}

func TestServeBrowserReplaceSubscriptionDropsPreviousDevice(t *testing.T) {
	setBrowserWSEnv(t)
	r := newMemoryRelay()
	r.store.memoryDevices["device-1"] = deviceRecord{ID: "device-1", OwnerUser: "user-1"}
	r.store.memoryDevices["device-2"] = deviceRecord{ID: "device-2", OwnerUser: "user-1"}
	server := httptest.NewServer(http.HandlerFunc(r.serveBrowser))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial(browserWSURL(server, issueToken("user-1")), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "subscribe", "deviceId": "device-1", "replace": true}); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "subscribe", "deviceId": "device-2", "replace": true}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		r.mu.RLock()
		matched := false
		for browser := range r.browsers {
			matched = len(browser.subscriptions) == 1 && browser.subscriptions["device-2"]
		}
		r.mu.RUnlock()
		if matched {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("replace subscription did not remove previous device")
}

func TestAuthorizedBrowserWSKeepsLegacyFixedHeaderToken(t *testing.T) {
	setBrowserWSEnv(t)
	t.Setenv("CODEHARBOR_ADMIN_USER", "migration-owner")
	t.Setenv("CODEHARBOR_CLOUD_TOKEN", "legacy-cloud-token")
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.Header.Set("Authorization", "Bearer legacy-cloud-token")
	if !authorizedBrowserWS(req) {
		t.Fatal("legacy fixed cloud token in Authorization header should remain accepted")
	}
}

func setBrowserWSEnv(t *testing.T) {
	t.Helper()
	t.Setenv("NODE_ENV", "test")
	t.Setenv("CODEHARBOR_ALLOWED_ORIGIN", "")
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	t.Setenv("CODEHARBOR_CLOUD_TOKEN", "")
}

func newBrowserWSServer(t *testing.T) *httptest.Server {
	t.Helper()
	r := &relay{
		browsers: map[*peer]struct{}{},
		devices:  map[string]*peer{},
		pending:  map[string]*pendingProxy{},
	}
	return httptest.NewServer(http.HandlerFunc(r.serveBrowser))
}

func browserWSURL(server *httptest.Server, token string) string {
	parsed, _ := url.Parse(server.URL)
	parsed.Scheme = "ws"
	parsed.Path = "/ws"
	query := parsed.Query()
	query.Set("token", token)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func signedTokenWithExpiry(t *testing.T, expiry time.Time) string {
	t.Helper()
	payload := base64.RawURLEncoding.EncodeToString([]byte("user-1|" + expiry.UTC().Format(time.RFC3339)))
	mac := hmac.New(sha256.New, []byte(os.Getenv("CODEHARBOR_AUTH_SECRET")))
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func responseStatus(response *http.Response) any {
	if response == nil {
		return "<nil>"
	}
	return response.StatusCode
}
