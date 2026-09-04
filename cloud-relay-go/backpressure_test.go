package main

import "testing"

func TestPeerOutboundByteBudget(t *testing.T) {
	p := &peer{}
	if !p.reserveOutboundBytes(maxPeerOutboundBytes) {
		t.Fatal("exact byte budget should be accepted")
	}
	if p.reserveOutboundBytes(1) {
		t.Fatal("budget overflow should be rejected")
	}
	p.outboundBytes.Store(0)
	if p.reserveOutboundBytes(maxPeerOutboundBytes + 1) {
		t.Fatal("oversized payload should be rejected")
	}
}
