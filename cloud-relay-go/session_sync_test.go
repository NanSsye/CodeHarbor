package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/websocket"
)

func TestDeviceSessionSyncPersistsMetadataAndIsIdempotent(t *testing.T) {
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
	if err := conn.WriteJSON(map[string]any{"type": "device-hello", "deviceId": device.ID, "deviceToken": token}); err != nil {
		t.Fatal(err)
	}
	var ready map[string]any
	if err := conn.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if ready["type"] != "device-ready" {
		t.Fatalf("unexpected device-ready response: %#v", ready)
	}
	sessions := []sessionRecord{
		{ID: "session-a", Title: "Project A", WorkspacePath: `D:\work\project-a`, Status: "completed", SessionPolicyMode: "full-access", UpdatedAt: "2026-09-03T10:00:00Z"},
		{ID: "session-b", Title: "Project B", WorkspacePath: `/srv/project-b`, Status: "running", SessionPolicyMode: "confirm", UpdatedAt: "2026-09-03T10:01:00Z"},
	}
	if err := conn.WriteJSON(map[string]any{"type": "session-sync", "requestId": "sync-1", "sessions": sessions}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "session-sync-ack" || ack["accepted"] != float64(2) || ack["skipped"] != float64(0) {
		t.Fatalf("unexpected first sync acknowledgement: %#v", ack)
	}
	if err := conn.WriteJSON(map[string]any{"type": "session-sync", "requestId": "sync-2", "payload": map[string]any{"sessions": sessions}}); err != nil {
		t.Fatal(err)
	}
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	if ack["type"] != "session-sync-ack" || ack["accepted"] != float64(2) {
		t.Fatalf("repeated sync should remain successful and idempotent: %#v", ack)
	}
	stored, err := r.store.listSessionsForUser(context.Background(), "account-a")
	if err != nil || len(stored) != 2 {
		t.Fatalf("expected two stored sessions, got=%#v err=%v", stored, err)
	}
	for _, session := range stored {
		if session.OwnerUser != "account-a" || session.DeviceID != "device-a" || session.WorkspacePath == "" {
			t.Fatalf("sync should persist ownership and workspace metadata: %#v", session)
		}
	}
	policyModes := map[string]bool{}
	for _, session := range stored {
		policyModes[session.SessionPolicyMode] = true
	}
	if !policyModes["full-access"] || !policyModes["confirm"] {
		t.Fatalf("session policy mode was not persisted: %#v", stored)
	}
}

func TestSessionSyncCannotCrossAccountOrDeviceBoundary(t *testing.T) {
	r := newMemoryRelay()
	if _, _, err := r.store.enrollDevice(context.Background(), "account-a", "device-a", "Laptop"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.store.enrollDevice(context.Background(), "account-b", "device-b", "Desktop"); err != nil {
		t.Fatal(err)
	}
	initial := sessionRecord{ID: "shared-session", Title: "Owner", WorkspacePath: `/owner/project`, Status: "completed", UpdatedAt: "2026-09-03T10:00:00Z"}
	if result, err := r.store.syncSessions(context.Background(), "account-a", "device-a", []sessionRecord{initial}); err != nil || result.Accepted != 1 {
		t.Fatalf("initial sync failed: result=%#v err=%v", result, err)
	}
	attacker := initial
	attacker.Title = "Attacker"
	attacker.WorkspacePath = `/attacker/project`
	attacker.UpdatedAt = "2026-09-03T11:00:00Z"
	if result, err := r.store.syncSessions(context.Background(), "account-b", "device-b", []sessionRecord{attacker}); err != nil || result.Accepted != 0 || result.Skipped != 1 {
		t.Fatalf("cross-account sync should be skipped: result=%#v err=%v", result, err)
	}
	stored, err := r.store.listSessionsForUser(context.Background(), "account-a")
	if err != nil || len(stored) != 1 || stored[0].Title != "Owner" || stored[0].WorkspacePath != `/owner/project` {
		t.Fatalf("owner metadata was changed by another account: sessions=%#v err=%v", stored, err)
	}
	other, err := r.store.listSessionsForUser(context.Background(), "account-b")
	if err != nil || len(other) != 0 {
		t.Fatalf("other account must not receive an existing session: sessions=%#v err=%v", other, err)
	}
}

func TestSessionsAPIIncludesWorkspacePathOnlyForOwner(t *testing.T) {
	t.Setenv("CODEHARBOR_AUTH_SECRET", "session-sync-test-secret")
	r := newMemoryRelay()
	if result, err := r.store.syncSessions(context.Background(), "account-a", "device-a", []sessionRecord{{ID: "session-a", Title: "A", WorkspacePath: `/workspace/a`, Status: "completed", UpdatedAt: "2026-09-03T10:00:00Z"}}); err != nil || result.Accepted != 1 {
		t.Fatalf("sync failed: result=%#v err=%v", result, err)
	}
	mux := http.NewServeMux()
	registerAPI(mux, r)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+issueToken("account-a"))
	resp := httptest.NewRecorder()
	mux.ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("owner sessions status = %d, body=%s", resp.Code, resp.Body.String())
	}
	var body struct {
		Sessions []sessionRecord `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Sessions) != 1 || body.Sessions[0].WorkspacePath != `/workspace/a` {
		t.Fatalf("owner should receive workspace metadata: %#v", body.Sessions)
	}

	otherReq := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	otherReq.Header.Set("Authorization", "Bearer "+issueToken("account-b"))
	otherResp := httptest.NewRecorder()
	mux.ServeHTTP(otherResp, otherReq)
	if otherResp.Code != http.StatusOK {
		t.Fatalf("other account sessions status = %d, body=%s", otherResp.Code, otherResp.Body.String())
	}
	var otherBody struct {
		Sessions []sessionRecord `json:"sessions"`
	}
	if err := json.Unmarshal(otherResp.Body.Bytes(), &otherBody); err != nil {
		t.Fatal(err)
	}
	if len(otherBody.Sessions) != 0 {
		t.Fatalf("other account should receive no sessions: %#v", otherBody.Sessions)
	}
}
