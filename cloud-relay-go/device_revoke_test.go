package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDeviceRevocationPersistsAndClosesOwnedConnection(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "device-revoke-secret")
	r := newMemoryRelay()
	device, token, err := r.store.enrollDevice(context.Background(), "account-a", "device-a", "Laptop")
	if err != nil {
		t.Fatal(err)
	}
	connected := testPeer("device", "account-a", device.ID)
	r.devices[device.ID] = connected
	mux := http.NewServeMux()
	registerAPI(mux, r)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/devices/device-a/revoke", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("account-a"))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("revoke status = %d body=%s", res.Code, res.Body.String())
	}
	select {
	case <-connected.closed:
	default:
		t.Fatal("revocation should close the current device connection")
	}
	if _, err := r.store.authenticateDevice(context.Background(), device.ID, token); !errors.Is(err, errDeviceRevoked) {
		t.Fatalf("revoked device credential error = %v", err)
	}
}

func TestDeviceRevocationRejectsAnotherAccount(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "device-revoke-secret")
	r := newMemoryRelay()
	if _, _, err := r.store.enrollDevice(context.Background(), "account-a", "device-a", "Laptop"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registerAPI(mux, r)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/devices/device-a/revoke", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("account-b"))
	res := httptest.NewRecorder()
	mux.ServeHTTP(res, req)
	if res.Code != http.StatusNotFound {
		t.Fatalf("cross-account revoke status = %d body=%s", res.Code, res.Body.String())
	}
}

func TestRedisDeviceRevocationClosesRemoteInstanceConnection(t *testing.T) {
	r := newMemoryRelay()
	connected := testPeer("device", "account-a", "device-a")
	r.devices[connected.deviceID] = connected
	raw, _ := json.Marshal(map[string]any{"deviceId": connected.deviceID, "ownerUser": connected.ownerUser})
	r.handleRedisMessage(deviceRevocationsChannel, string(raw))
	select {
	case <-connected.closed:
	default:
		t.Fatal("cross-instance revocation should close the owned device connection")
	}
}

func TestRedisDeviceRevocationClosesUnpairedConnection(t *testing.T) {
	r := newMemoryRelay()
	connected := testPeer("device", "", "device-a")
	r.devices[connected.deviceID] = connected
	r.handleRedisMessage(deviceRevocationsChannel, `{"deviceId":"device-a","ownerUser":"account-a"}`)
	select {
	case <-connected.closed:
	default:
		t.Fatal("revocation should close an unpaired device connection")
	}
}
