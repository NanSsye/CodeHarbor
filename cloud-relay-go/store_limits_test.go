package main

import (
	"context"
	"fmt"
	"testing"
)

func TestCapEventBatchLimitsEncodedBytes(t *testing.T) {
	large := make([]byte, 4<<20)
	events := make([]map[string]any, 0, 10)
	for i := 0; i < 10; i++ {
		events = append(events, map[string]any{"eventSeq": i + 1, "payload": string(large)})
	}
	limited := capEventBatch(events)
	if len(limited) == 0 || len(limited) >= len(events) {
		t.Fatalf("expected a partial capped batch, got %d/%d", len(limited), len(events))
	}
}

func TestListSessionsForUserIsBounded(t *testing.T) {
	s := &store{memorySessions: make(map[string]sessionRecord)}
	for i := 0; i < maxSessionListItems+25; i++ {
		s.memorySessions[fmt.Sprintf("session-%d", i)] = sessionRecord{
			ID:        fmt.Sprintf("session-%d", i),
			OwnerUser: "user-1",
			UpdatedAt: fmt.Sprintf("2026-09-04T00:%02d:%02dZ", (i/60)%60, i%60),
		}
	}
	values, err := s.listSessionsForUser(context.Background(), "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != maxSessionListItems+1 {
		t.Fatalf("bounded query sentinel length = %d, want %d", len(values), maxSessionListItems+1)
	}
}

func TestConfiguredEventRetentionDaysIsOptInAndCapped(t *testing.T) {
	t.Setenv("CODEHARBOR_EVENT_RETENTION_DAYS", "")
	if got := configuredEventRetentionDays(); got != 0 {
		t.Fatalf("empty retention should disable cleanup, got %d", got)
	}
	t.Setenv("CODEHARBOR_EVENT_RETENTION_DAYS", "-1")
	if got := configuredEventRetentionDays(); got != 0 {
		t.Fatalf("non-positive retention should disable cleanup, got %d", got)
	}
	t.Setenv("CODEHARBOR_EVENT_RETENTION_DAYS", "99999")
	if got := configuredEventRetentionDays(); got != 3650 {
		t.Fatalf("retention cap = %d, want 3650", got)
	}
}
