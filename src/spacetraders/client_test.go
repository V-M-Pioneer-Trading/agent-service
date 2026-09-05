package spacetraders

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// newStubGateway returns a client pointed at a stub st-gateway. Nothing here
// touches process environment, so these tests are order-independent.
func newStubGateway(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return NewClientWithBaseURL(server.URL)
}

func TestGetMyAgentRoutesThroughGateway(t *testing.T) {
	var gotPath, gotAuth string
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	})

	agent, err := client.GetMyAgent("Bearer test-token", PriorityInteractive)
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
		{"interactive passes through", PriorityInteractive, PriorityInteractive},
		{"empty degrades to background", "", PriorityBackground},
		{"anything else degrades to background", "bogus", PriorityBackground},
		{"case variants do not count as interactive", "Interactive", PriorityBackground},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotPriority string
			client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
				gotPriority = r.Header.Get("X-Priority")
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
			})

			if _, err := client.GetMyAgent("Bearer test-token", tc.priority); err != nil {
				t.Fatalf("GetMyAgent returned error: %v", err)
			}
			if gotPriority != tc.want {
				t.Errorf("expected X-Priority: %q, got %q", tc.want, gotPriority)
			}
		})
	}
}

func TestNewClientDefaultsWhenGatewayURLUnset(t *testing.T) {
	// t.Setenv, not os.Unsetenv: the old test cleared ST_GATEWAY_URL for the
	// remainder of the binary, leaving every later test in this package
	// dependent on the order Go happened to run them in.
	t.Setenv("ST_GATEWAY_URL", "")
	if got := NewClient().BaseURL(); got != defaultGatewayURL+"/proxy" {
		t.Errorf("expected default gateway URL, got %q", got)
	}
}

func TestNewClientUsesGatewayURLWhenSet(t *testing.T) {
	t.Setenv("ST_GATEWAY_URL", "http://gateway.internal:9999")
	if got := NewClient().BaseURL(); got != "http://gateway.internal:9999/proxy" {
		t.Errorf("got %q, want the configured gateway URL", got)
	}
}

// meta: purchase/sell moved from fleet-service into agent-service so it can own
// a transaction history — these calls now go straight to st-gateway themselves,
// the same as AcceptContract/FulfillContract, instead of fleet-service proxying
// them and phoning agent-service afterward.
func TestPurchaseCargoRoutesThroughGatewayWithBody(t *testing.T) {
	var gotPath, gotMethod, gotAuth, gotBody string
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"agent":{"credits":5000},"cargo":{"capacity":40,"units":10},"transaction":{"waypointSymbol":"X1-TEST","shipSymbol":"TEST-1","tradeSymbol":"FUEL","type":"PURCHASE","units":10,"pricePerUnit":5,"totalPrice":50,"timestamp":"2026-01-01T00:00:00Z"}}}`))
	})

	result, err := client.PurchaseCargo("Bearer test-token", PriorityInteractive, "TEST-1", "FUEL", 10)
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

func TestSellCargoUsesTheSellPath(t *testing.T) {
	var gotPath string
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{}}`))
	})

	if _, err := client.SellCargo("Bearer t", PriorityBackground, "TEST-1", "FUEL", 3); err != nil {
		t.Fatalf("SellCargo returned error: %v", err)
	}
	if gotPath != "/proxy/my/ships/TEST-1/sell" {
		t.Errorf("expected the sell path, got %q", gotPath)
	}
}

// Regression: every call built its own &http.Client{} with no Timeout, so a
// gateway that accepted the connection and then never answered pinned the
// calling handler — and its connection — for as long as the process lived.
func TestARequestThatNeverAnswersEventuallyFails(t *testing.T) {
	blocked := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-blocked
	}))
	defer server.Close()
	defer close(blocked)

	client := NewClientWithBaseURL(server.URL)
	client.http.Timeout = 100 * time.Millisecond

	done := make(chan error, 1)
	go func() {
		_, err := client.GetMyAgent("Bearer t", PriorityBackground)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a timeout error, got nil")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the request never returned: no timeout is configured on the client")
	}
}

// A default-constructed client must carry a timeout; the one above only proves
// the mechanism works once a timeout is set.
func TestNewClientSetsARequestTimeout(t *testing.T) {
	if got := NewClient().http.Timeout; got <= 0 {
		t.Errorf("got timeout %v, want a positive bound", got)
	}
}

func TestUpstreamErrorCarriesStatusAndBody(t *testing.T) {
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	})

	_, err := client.GetMyAgent("Bearer t", PriorityBackground)
	var upstream *UpstreamError
	if !errors.As(err, &upstream) {
		t.Fatalf("expected an *UpstreamError, got %v", err)
	}
	if upstream.StatusCode != http.StatusTooManyRequests {
		t.Errorf("got status %d, want 429", upstream.StatusCode)
	}
	if !strings.Contains(upstream.Message, "rate limited") {
		t.Errorf("expected the upstream body in the message, got %q", upstream.Message)
	}
}

// Regression: the whole error body was read into the message with no bound, so
// a misbehaving upstream could grow a log line without limit.
func TestUpstreamErrorMessageIsBounded(t *testing.T) {
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(strings.Repeat("x", maxErrorBody*2)))
	})

	_, err := client.GetMyAgent("Bearer t", PriorityBackground)
	if err == nil {
		t.Fatal("expected an error")
	}
	if len(err.Error()) > maxErrorBody+1024 {
		t.Errorf("error message is %d bytes, want it capped near %d", len(err.Error()), maxErrorBody)
	}
}

func TestGatewayURLEnvIsReadOnlyAtConstruction(t *testing.T) {
	t.Setenv("ST_GATEWAY_URL", "http://first:1111")
	client := NewClient()
	os.Setenv("ST_GATEWAY_URL", "http://second:2222")
	if got := client.BaseURL(); got != "http://first:1111/proxy" {
		t.Errorf("got %q, want the address captured at construction", got)
	}
}

// Regression: the gateway URL was concatenated with "/proxy" unconditionally,
// so ST_GATEWAY_URL="http://host:3002/" produced "//proxy/my/agent" — a path
// st-gateway's Express router does not match, turning a plausible way to write
// the variable into a 404 with no hint as to why.
func TestATrailingSlashOnTheGatewayURLIsTolerated(t *testing.T) {
	for _, configured := range []string{"http://gateway:3002", "http://gateway:3002/", "http://gateway:3002///"} {
		if got := NewClientWithBaseURL(configured).BaseURL(); got != "http://gateway:3002/proxy" {
			t.Errorf("NewClientWithBaseURL(%q) = %q, want a single /proxy suffix", configured, got)
		}
	}
}

// The same, through the environment path.
func TestATrailingSlashOnSTGatewayURLIsTolerated(t *testing.T) {
	t.Setenv("ST_GATEWAY_URL", "http://gateway:3002/")
	if got := NewClient().BaseURL(); got != "http://gateway:3002/proxy" {
		t.Errorf("got %q, want a single /proxy suffix", got)
	}
}
