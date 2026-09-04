package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAccountRegistrationIssuesSessionAndLoginWorks(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	t.Setenv("CODEHARBOR_AUTH_SECRET", "registration-test-secret")
	r := newMemoryRelay()
	mux := http.NewServeMux()
	registerAPI(mux, r)

	register := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"username":"Alice.Dev","password":"correct horse battery"}`))
	register.RemoteAddr = "198.51.100.201:443"
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, register)
	if response.Code != http.StatusOK {
		t.Fatalf("registration status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Token    string `json:"token"`
		Username string `json:"username"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Token == "" || body.Username != "alice.dev" {
		t.Fatalf("unexpected registration response: %#v err=%v", body, err)
	}

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"alice.dev","password":"correct horse battery"}`))
	login.RemoteAddr = "198.51.100.202:443"
	loginResponse := httptest.NewRecorder()
	mux.ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}

	duplicate := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"username":"ALICE.DEV","password":"another correct password"}`))
	duplicate.RemoteAddr = "198.51.100.203:443"
	duplicateResponse := httptest.NewRecorder()
	mux.ServeHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != http.StatusConflict {
		t.Fatalf("duplicate status=%d body=%s", duplicateResponse.Code, duplicateResponse.Body.String())
	}
}

func TestAccountRegistrationRejectsWeakInput(t *testing.T) {
	t.Setenv("NODE_ENV", "test")
	r := newMemoryRelay()
	mux := http.NewServeMux()
	registerAPI(mux, r)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register", strings.NewReader(`{"username":"ab","password":"short"}`))
	request.RemoteAddr = "198.51.100.204:443"
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("weak registration status=%d body=%s", response.Code, response.Body.String())
	}
}
