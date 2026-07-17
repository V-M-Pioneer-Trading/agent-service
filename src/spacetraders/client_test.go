package spacetraders

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestGetMyAgentRoutesThroughGatewayTaggedInteractive(t *testing.T) {
	var gotPath, gotAuth, gotPriority string
	fakeGateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotPriority = r.Header.Get("X-Priority")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	}))
	defer fakeGateway.Close()

	t.Setenv("ST_GATEWAY_URL", fakeGateway.URL)

	agent, err := GetMyAgent("Bearer test-token")
	if err != nil {
		t.Fatalf("GetMyAgent returned error: %v", err)
	}
	if agent.Symbol != "TEST-AGENT" {
		t.Errorf("expected symbol TEST-AGENT, got %q", agent.Symbol)
	}
	if gotPath != "/proxy/my/agent" {
		t.Errorf("expected request to hit gateway's /proxy path, got %q", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("expected Authorization forwarded verbatim, got %q", gotAuth)
	}
	if gotPriority != "interactive" {
		t.Errorf("expected X-Priority: interactive, got %q", gotPriority)
	}
}

func TestGatewayBaseURLDefaultsWhenUnset(t *testing.T) {
	os.Unsetenv("ST_GATEWAY_URL")
	if got := gatewayBaseURL(); got != "http://localhost:3002/proxy" {
		t.Errorf("expected default gateway URL, got %q", got)
	}
}
