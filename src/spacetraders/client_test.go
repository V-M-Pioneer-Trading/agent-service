package spacetraders

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestGetMyAgentRoutesThroughGateway(t *testing.T) {
	var gotPath, gotAuth string
	fakeGateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	}))
	defer fakeGateway.Close()

	t.Setenv("ST_GATEWAY_URL", fakeGateway.URL)

	agent, err := GetMyAgent("Bearer test-token", "interactive")
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
}

// meta#37: agent-service used to hardcode X-Priority: interactive on every
// outbound call, so automation-service's background autopilot traffic jumped
// st-gateway's queue meant to keep the browser UI responsive. It now forwards
// whatever the caller (command-interface vs automation-service) itself
// declared, and anything but exactly "interactive" degrades to "background".
func TestGetMyAgentForwardsPriority(t *testing.T) {
	cases := []struct {
		name     string
		priority string
		want     string
	}{
		{"interactive passes through", "interactive", "interactive"},
		{"empty degrades to background", "", "background"},
		{"anything else degrades to background", "bogus", "background"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPriority string
			fakeGateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPriority = r.Header.Get("X-Priority")
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
			}))
			defer fakeGateway.Close()

			t.Setenv("ST_GATEWAY_URL", fakeGateway.URL)

			if _, err := GetMyAgent("Bearer test-token", tc.priority); err != nil {
				t.Fatalf("GetMyAgent returned error: %v", err)
			}
			if gotPriority != tc.want {
				t.Errorf("expected X-Priority: %q, got %q", tc.want, gotPriority)
			}
		})
	}
}

func TestGatewayBaseURLDefaultsWhenUnset(t *testing.T) {
	os.Unsetenv("ST_GATEWAY_URL")
	if got := gatewayBaseURL(); got != "http://localhost:3002/proxy" {
		t.Errorf("expected default gateway URL, got %q", got)
	}
}
