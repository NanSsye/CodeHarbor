package main

import (
	"encoding/json"
	"testing"
	"time"
)

func testPeer(kind, owner, deviceID string) *peer {
	return &peer{
		kind:          kind,
		ownerUser:     owner,
		deviceID:      deviceID,
		subscriptions: map[string]bool{},
		outbound:      make(chan []byte, 2),
		closed:        make(chan struct{}),
	}
}

func TestRedisProxyRequestRoutesToLocalOwnedDevice(t *testing.T) {
	r := newMemoryRelay()
	device := testPeer("device", "account-a", "device-a")
	r.devices[device.deviceID] = device
	envelope, _ := json.Marshal(map[string]any{
		"deviceId": "device-a", "ownerUser": "account-a", "requestId": "request-1",
		"payload": map[string]any{"type": "proxy-request", "requestId": "request-1", "path": "/sessions"},
	})
	r.handleRedisMessage(proxyRequestsChannel, string(envelope))
	select {
	case raw := <-device.outbound:
		var message map[string]any
		if json.Unmarshal(raw, &message) != nil || message["requestId"] != "request-1" {
			t.Fatalf("unexpected routed request: %s", raw)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy request was not routed to local device")
	}
}

func TestRedisProxyResponseReturnsToOriginBrowser(t *testing.T) {
	r := newMemoryRelay()
	browser := testPeer("browser", "account-a", "")
	timer := time.NewTimer(time.Minute)
	r.pending["request-1"] = &pendingProxy{browser: browser, deviceID: "device-a", ownerUser: "account-a", timer: timer}
	envelope, _ := json.Marshal(map[string]any{
		"deviceId": "device-a", "ownerUser": "account-a", "requestId": "request-1",
		"payload": map[string]any{"type": "proxy-response", "requestId": "request-1", "status": 200},
	})
	r.handleRedisMessage(proxyResponsesChannel, string(envelope))
	select {
	case raw := <-browser.outbound:
		var message map[string]any
		if json.Unmarshal(raw, &message) != nil || message["type"] != "gateway-proxy-response" {
			t.Fatalf("unexpected proxy response: %s", raw)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy response was not returned to origin browser")
	}
	if _, exists := r.pending["request-1"]; exists {
		t.Fatal("completed cross-instance request should be removed from pending map")
	}
}

func TestReplacingDeviceDoesNotCancelNewPeerRequests(t *testing.T) {
	r := newMemoryRelay()
	oldPeer := testPeer("device", "account-a", "device-a")
	newPeer := testPeer("device", "account-a", "device-a")
	r.devices[oldPeer.deviceID] = newPeer
	browser := testPeer("browser", "account-a", "")
	r.pending["request-1"] = &pendingProxy{browser: browser, deviceID: oldPeer.deviceID, ownerUser: "account-a", timer: time.NewTimer(time.Minute)}
	r.remove(oldPeer)
	if _, exists := r.pending["request-1"]; !exists {
		t.Fatal("old peer cleanup must not cancel a request owned by the replacement peer")
	}
}

func TestDeviceOwnershipMessageBindsUnpairedPeer(t *testing.T) {
	r := newMemoryRelay()
	device := testPeer("device", "", "device-a")
	r.devices[device.deviceID] = device
	r.handleRedisMessage(deviceOwnershipChannel, `{"deviceId":"device-a","ownerUser":"account-a"}`)
	r.mu.RLock()
	owner := r.devices[device.deviceID].ownerUser
	r.mu.RUnlock()
	if owner != "account-a" {
		t.Fatalf("owner after ownership message = %q", owner)
	}
}

func TestRevokedBrowserTokenClosesExistingConnection(t *testing.T) {
	r := newMemoryRelay()
	peer := testPeer("browser", "account-a", "")
	peer.authTokenHash = "hash-a"
	r.browsers[peer] = struct{}{}
	r.disconnectBrowsersByTokenHash("hash-a")
	select {
	case <-peer.closed:
	default:
		t.Fatal("revoked browser token should close the existing WebSocket")
	}
}

func TestDeviceAdmissionBoundsConnectionsPerIP(t *testing.T) {
	r := newMemoryRelay()
	for i := 0; i < maxDeviceConnectionsPerIP; i++ {
		p := testPeer("device", "", "")
		p.remoteIP = "203.0.113.9"
		if !r.admitDevicePeer(p) {
			t.Fatalf("device %d should be admitted", i)
		}
	}
	blocked := testPeer("device", "", "")
	blocked.remoteIP = "203.0.113.9"
	if r.admitDevicePeer(blocked) {
		t.Fatal("device admission should reject the per-IP limit")
	}
}
