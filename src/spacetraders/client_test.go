package spacetraders

import (
	"io"
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

// meta: purchase/sell moved from fleet-service into agent-service so it can own
// a transaction history — these calls now go straight to st-gateway themselves,
// the same as AcceptContract/FulfillContract, instead of fleet-service proxying
// them and phoning agent-service afterward.
func TestPurchaseCargoRoutesThroughGatewayWithBody(t *testing.T) {
	var gotPath, gotMethod, gotAuth, gotBody string
	fakeGateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"agent":{"credits":5000},"cargo":{"capacity":40,"units":10},"transaction":{"waypointSymbol":"X1-TEST","shipSymbol":"TEST-1","tradeSymbol":"FUEL","type":"PURCHASE","units":10,"pricePerUnit":5,"totalPrice":50,"timestamp":"2026-01-01T00:00:00Z"}}}`))
	}))
	defer fakeGateway.Close()

	t.Setenv("ST_GATEWAY_URL", fakeGateway.URL)

	result, err := PurchaseCargo("Bearer test-token", "interactive", "TEST-1", "FUEL", 10)
	if err != nil {
		t.Fatalf("PurchaseCargo returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/proxy/my/ships/TEST-1/purchase" {
		t.Errorf("expected request to hit gateway's purchase path, got %q", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("expected Authorization forwarded verbatim, got %q", gotAuth)
	}
	if gotBody != `{"symbol":"FUEL","units":10}` {
		t.Errorf("expected symbol/units request body, got %q", gotBody)
	}
	if result.Transaction.TotalPrice != 50 {
		t.Errorf("expected totalPrice 50, got %d", result.Transaction.TotalPrice)
	}
	if result.Agent.Credits != 5000 {
		t.Errorf("expected agent credits 5000, got %d", result.Agent.Credits)
	}
}
