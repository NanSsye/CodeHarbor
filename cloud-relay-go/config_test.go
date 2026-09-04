package main

import "testing"

func TestValidateProductionConfig(t *testing.T) {
	valid := map[string]string{
		"CODEHARBOR_CLOUD_TOKEN":    "cloud-token-012345678901234567890123",
		"CODEHARBOR_DEVICE_TOKEN":   "device-token-012345678901234567890123",
		"CODEHARBOR_AUTH_SECRET":    "auth-secret-01234567890123456789012",
		"CODEHARBOR_ADMIN_PASSWORD": "admin-password",
		"CODEHARBOR_ALLOWED_ORIGIN": "https://codex.example.test",
	}
	getenv := func(name string) string { return valid[name] }
	if err := validateProductionConfig(getenv); err != nil {
		t.Fatalf("valid production config rejected: %v", err)
	}

	cases := []struct {
		name  string
		key   string
		value string
	}{
		{name: "cloud token", key: "CODEHARBOR_CLOUD_TOKEN", value: "short"},
		{name: "device token", key: "CODEHARBOR_DEVICE_TOKEN", value: "short"},
		{name: "auth secret", key: "CODEHARBOR_AUTH_SECRET", value: "short"},
		{name: "admin password", key: "CODEHARBOR_ADMIN_PASSWORD", value: "short"},
		{name: "cloud token whitespace", key: "CODEHARBOR_CLOUD_TOKEN", value: "                                "},
		{name: "allowed origin", key: "CODEHARBOR_ALLOWED_ORIGIN", value: "  "},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			candidate := make(map[string]string, len(valid))
			for key, value := range valid {
				candidate[key] = value
			}
			candidate[tc.key] = tc.value
			if err := validateProductionConfig(func(name string) string { return candidate[name] }); err == nil {
				t.Fatalf("invalid %s configuration was accepted", tc.name)
			}
		})
	}
}
