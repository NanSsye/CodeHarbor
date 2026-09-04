package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBoundedHTTPContextAppliesToAPIAndReady(t *testing.T) {
	for _, path := range []string{"/api/v1/sessions", "/readyz"} {
		called := false
		handler := boundedHTTPContext(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
			called = true
			if _, ok := req.Context().Deadline(); !ok {
				t.Errorf("%s request has no deadline", path)
			}
		}))
		req := httptest.NewRequest(http.MethodGet, path, nil)
		handler.ServeHTTP(httptest.NewRecorder(), req)
		if !called {
			t.Fatalf("handler was not called for %s", path)
		}
	}
}

func TestBoundedHTTPContextLeavesWebSocketLifetimeUnchanged(t *testing.T) {
	called := false
	handler := boundedHTTPContext(http.HandlerFunc(func(_ http.ResponseWriter, req *http.Request) {
		called = true
		if _, ok := req.Context().Deadline(); ok {
			t.Fatal("websocket request should not receive an HTTP dependency deadline")
		}
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/ws", nil))
	if !called {
		t.Fatal("handler was not called")
	}
}
