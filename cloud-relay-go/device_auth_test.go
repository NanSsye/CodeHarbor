package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newMemoryRelay() *relay {
	return &relay{
		browsers: map[*peer]struct{}{},
		devices:  map[string]*peer{},
		pending:  map[string]*pendingProxy{},
		store:    &store{memorySessions: map[string]sessionRecord{}, memoryDevices: map[string]deviceRecord{}},
	}
}

func TestEnrollDeviceAndAccountScopedLists(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("CODEHARBOR_AUTH_SECRET", "test-secret")
	t.Setenv("CODEHARBOR_CLOUD_TOKEN", "")
	t.Setenv("CODEHARBOR_ADMIN_PASSWORD", "password")
	r := newMemoryRelay()
	mux := http.NewServeMux()
	registerAPI(mux, r)

	accountToken := issueToken("account-a")
	body, _ := json.Marshal(map[string]string{"deviceId": "device-a", "deviceName": "Laptop"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/devices/enroll", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+accountToken)
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("enroll status = %d, body=%s", resp.Code, resp.Body.String())
	}
	var enrolled struct {
		DeviceID    string `json:"deviceId"`
		DeviceToken string `json:"deviceToken"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &enrolled); err != nil {
		t.Fatal(err)
	}
	if enrolled.DeviceID != "device-a" || enrolled.DeviceToken == "" {
		t.Fatalf("unexpected enrollment response: %#v", enrolled)
	}
	if _, err := r.store.authenticateDevice(context.Background(), enrolled.DeviceID, enrolled.DeviceToken); err != nil {
		t.Fatalf("issued device token should authenticate: %v", err)
	}
	if _, err := r.store.authenticateDevice(context.Background(), enrolled.DeviceID, "wrong-token"); err == nil {
		t.Fatal("wrong device token should be rejected")
	}

	list := func(token string) []map[string]any {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/devices", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp := httptest.NewRecorder()
		mux.ServeHTTP(resp, req)
		if resp.Code != http.StatusOK {
			t.Fatalf("list status = %d, body=%s", resp.Code, resp.Body.String())
		}
		var value struct {
			Devices []map[string]any `json:"devices"`
		}
		if err := json.Unmarshal(resp.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return value.Devices
	}
	if devices := list(accountToken); len(devices) != 1 || devices[0]["deviceId"] != "device-a" {
		t.Fatalf("owner should see enrolled device: %#v", devices)
	}
	if devices := list(issueToken("account-b")); len(devices) != 0 {
		t.Fatalf("other account must not see device: %#v", devices)
	}
	otherEnroll := httptest.NewRequest(http.MethodPost, "/api/v1/devices/enroll", bytes.NewReader(body))
	otherEnroll.Header.Set("Authorization", "Bearer "+issueToken("account-b"))
	otherResponse := httptest.NewRecorder()
	mux.ServeHTTP(otherResponse, otherEnroll)
	if otherResponse.Code != http.StatusConflict {
		t.Fatalf("cross-account enrollment should be rejected with 409, got %d body=%s", otherResponse.Code, otherResponse.Body.String())
	}

	if err := r.store.upsertSession(context.Background(), sessionRecord{ID: "session-a", DeviceID: "device-a", OwnerUser: "account-a", UpdatedAt: "2026-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	if sessions, err := r.store.listSessionsForUser(context.Background(), "account-b"); err != nil || len(sessions) != 0 {
		t.Fatalf("other account must not see session: sessions=%#v err=%v", sessions, err)
	}
	if sessions, err := r.store.listSessionsForUser(context.Background(), "account-a"); err != nil || len(sessions) != 1 {
		t.Fatalf("owner should see session: sessions=%#v err=%v", sessions, err)
	}
}

func TestDeviceWebSocketAcceptsEnrolledToken(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("CODEHARBOR_ALLOWED_ORIGIN", "")
	r := newMemoryRelay()
	device, token, err := r.store.enrollDevice(context.Background(), "account-a", "device-a", "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(r.serveDevice))
	defer server.Close()
	url := "ws" + server.URL[len("http"):]
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "device-hello", "deviceId": device.ID, "deviceToken": token, "deviceName": device.Name}); err != nil {
		t.Fatal(err)
	}
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if ready["type"] != "device-ready" || ready["deviceId"] != device.ID {
		t.Fatalf("unexpected ready response: %#v", ready)
	}
}

func TestLegacyDeviceReadyPairCodeCanBindAccount(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("CODEHARBOR_ALLOWED_ORIGIN", "")
	t.Setenv("CODEHARBOR_DEVICE_TOKEN", "legacy-secret")
	t.Setenv("CODEHARBOR_AUTH_SECRET", "pair-secret")
	t.Setenv("CODEHARBOR_ADMIN_USER", "admin")
	t.Setenv("CODEHARBOR_ADMIN_PASSWORD", "admin-password")
	r := newMemoryRelay()
	server := httptest.NewServer(http.HandlerFunc(r.serveDevice))
	defer server.Close()
	url := "ws" + server.URL[len("http"):]
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "device-hello", "deviceId": "legacy-device", "serverToken": "legacy-secret", "deviceName": "Laptop"}); err != nil {
		t.Fatal(err)
	}
	var ready struct {
		Type        string `json:"type"`
		DeviceID    string `json:"deviceId"`
		PairCode    string `json:"pairCode"`
		DeviceToken string `json:"deviceToken"`
	}
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "device-ready" || ready.DeviceID == "" || len(ready.PairCode) != pairCodeLength || ready.DeviceToken == "" {
		t.Fatalf("unexpected ready response: %#v", ready)
	}
	mux := http.NewServeMux()
	registerAPI(mux, r)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"token":"`+ready.PairCode+`"}`))
	req.RemoteAddr = "198.51.100.43:443"
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("pair login status=%d body=%s", resp.Code, resp.Body.String())
	}
	if r.store.memoryDevices[ready.DeviceID].OwnerUser != "admin" {
		t.Fatal("pair login did not bind legacy device")
	}
}

func TestDeviceWebSocketRejectsSecondHelloOnSameConnection(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("CODEHARBOR_ALLOWED_ORIGIN", "")
	r := newMemoryRelay()
	first, firstToken, err := r.store.enrollDevice(context.Background(), "account-a", "device-a", "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	second, secondToken, err := r.store.enrollDevice(context.Background(), "account-a", "device-b", "Desktop")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(r.serveDevice))
	defer server.Close()
	url := "ws" + server.URL[len("http"):]
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]any{"type": "device-hello", "deviceId": first.ID, "deviceToken": firstToken}); err != nil {
		t.Fatal(err)
	}
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "device-hello", "deviceId": second.ID, "deviceToken": secondToken}); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var ignored map[string]any
	if err := conn.ReadJSON(&ignored); err == nil {
		t.Fatal("second device hello should close the connection")
	}
}
