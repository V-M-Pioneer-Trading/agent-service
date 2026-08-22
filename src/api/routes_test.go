package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthEndpoint(t *testing.T) {
	router, err := SetUpRouter(nil, testAuthConfig())
	if err != nil {
		t.Fatalf("SetUpRouter: %v", err)
	}

	for _, path := range []string{"/health", "/api/agent/health"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("%s: expected status 200, got %d", path, rec.Code)
		}
		if got := rec.Body.String(); got != `{"status":"ok"}`+"\n" {
			t.Errorf("%s: unexpected body: %q", path, got)
		}
	}
}
