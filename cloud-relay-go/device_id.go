package main

import (
	"strings"
	"unicode"
)

const maxDeviceIDLength = 256

// normalizeDeviceID applies the same boundary checks to every API and storage
// path that accepts a caller-provided device identifier. Device IDs are used in
// URL paths and Redis keys, so separators and control characters are rejected.
func normalizeDeviceID(raw string) (string, bool) {
	id := strings.TrimSpace(raw)
	if id == "" || len(id) > maxDeviceIDLength {
		return "", false
	}
	for _, r := range id {
		if unicode.IsControl(r) || r == '/' || r == '\\' {
			return "", false
		}
	}
	return id, true
}
