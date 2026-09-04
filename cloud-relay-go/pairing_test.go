package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPairCodeIsSingleUseAndBindsDevice(t *testing.T) {
	s := &store{memoryDevices: map[string]deviceRecord{}, memoryPairCodes: map[string]pairCodeRecord{}}
	device, _, err := s.registerLegacyDevice(context.Background(), "device-pair", "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	pair, err := s.createPairCode(context.Background(), device.ID)
	if err != nil || len(pair.Code) != pairCodeLength {
		t.Fatalf("create pair code: %#v %v", pair, err)
	}
	if _, err = s.consumePairCode(context.Background(), pair.Code, "admin"); err != nil {
		t.Fatalf("consume pair code: %v", err)
	}
	if _, err = s.consumePairCode(context.Background(), pair.Code, "admin"); err != errPairCodeInvalid {
		t.Fatalf("replay error = %v, want %v", err, errPairCodeInvalid)
	}
	if s.memoryDevices[device.ID].OwnerUser != "admin" {
		t.Fatal("pair code did not bind device owner")
	}
}

func TestPairCodeExpiryIsRejected(t *testing.T) {
	s := &store{memoryDevices: map[string]deviceRecord{}, memoryPairCodes: map[string]pairCodeRecord{}}
	device, _, err := s.registerLegacyDevice(context.Background(), "device-expired", "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	pair, err := s.createPairCode(context.Background(), device.ID)
	if err != nil {
		t.Fatal(err)
	}
	hash := string(hashCredential(pair.Code))
	value := s.memoryPairCodes[hash]
	value.ExpiresAt = time.Now().Add(-time.Second)
	s.memoryPairCodes[hash] = value
	if _, err = s.consumePairCode(context.Background(), pair.Code, "admin"); err != errPairCodeInvalid {
		t.Fatalf("expired code error = %v, want %v", err, errPairCodeInvalid)
	}
}

func TestPairCodeLoginReturnsAccountToken(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "pair-test-secret")
	t.Setenv("CODEHARBOR_ADMIN_USER", "admin")
	t.Setenv("CODEHARBOR_ADMIN_PASSWORD", "admin-password")
	s := &store{memoryDevices: map[string]deviceRecord{}, memoryPairCodes: map[string]pairCodeRecord{}}
	device, _, err := s.registerLegacyDevice(context.Background(), "device-api-pair", "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	pair, err := s.createPairCode(context.Background(), device.ID)
	if err != nil {
		t.Fatal(err)
	}
	r := &relay{store: s, browsers: map[*peer]struct{}{}, devices: map[string]*peer{}, pending: map[string]*pendingProxy{}}
	mux := http.NewServeMux()
	registerAPI(mux, r)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"token":"`+pair.Code+`"}`))
	req.RemoteAddr = "198.51.100.42:443"
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("pair login status = %d body=%s", resp.Code, resp.Body.String())
	}
	var body struct {
		Token    string `json:"token"`
		DeviceID string `json:"deviceId"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Token == "" || body.DeviceID != device.ID || !verifyToken("Bearer "+body.Token) {
		t.Fatalf("unexpected pair login response: %#v", body)
	}
}
