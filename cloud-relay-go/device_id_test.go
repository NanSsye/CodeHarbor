package main

import (
	"context"
	"errors"
	"testing"
)

func TestNormalizeDeviceIDRejectsPathAndControlInput(t *testing.T) {
	valid, ok := normalizeDeviceID("  laptop-01 ")
	if !ok || valid != "laptop-01" {
		t.Fatalf("normalized id = %q, valid=%v", valid, ok)
	}
	for _, value := range []string{"", "../etc", "a\\b", "a\n b", string(make([]byte, maxDeviceIDLength+1))} {
		if _, ok := normalizeDeviceID(value); ok {
			t.Fatalf("normalizeDeviceID(%q) should reject", value)
		}
	}
}

func TestEnrollRejectsInvalidRequestedDeviceID(t *testing.T) {
	r := newMemoryRelay()
	if _, _, err := r.store.enrollDevice(context.Background(), "account-a", "../device", "Laptop"); !errors.Is(err, errInvalidDeviceID) {
		t.Fatalf("enroll error = %v, want invalid_device_id", err)
	}
}
