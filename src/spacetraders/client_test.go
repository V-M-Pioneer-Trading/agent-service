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

	agent, err := client.GetMyAgent("Bearer test-token")
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

// Regression: this service used to send an X-Priority header and normalise it
// to "interactive"/"background" itself. st-gateway stopped reading that header
// when priority became a property of a verified Clerk identity rather than
// something a caller could declare (auth-design.md decision 2) — so sending it
// is at best noise, and at worst a claim this service is no longer entitled to
// make. Nothing should go out on that header now.
func TestNoPriorityHeaderIsSent(t *testing.T) {
	var seen bool
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		_, seen = r.Header["X-Priority"]
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	})

	if _, err := client.GetMyAgent("Bearer clerk-session"); err != nil {
		t.Fatalf("GetMyAgent returned error: %v", err)
	}
	if seen {
		t.Error("an X-Priority header was sent; st-gateway no longer reads it")
	}
}

// Regression: this service used to forward the caller's *SpaceTraders* token
// upstream. st-gateway now injects that credential itself from auth-service
// (decision 5) and overwrites whatever arrives, so the game token bought
// nothing — and because it is opaque rather than a Clerk JWT, st-gateway's
// priority check failed on it and every request, browser traffic included,
// degraded to background. Forwarding the caller's verified Clerk header is
// what lets a human session keep the interactive lane across this hop.
func TestTheCallersClerkHeaderIsForwardedVerbatim(t *testing.T) {
	var gotAuth string
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	})

	if _, err := client.GetMyAgent("Bearer clerk-session-jwt"); err != nil {
		t.Fatalf("GetMyAgent returned error: %v", err)
	}
	if gotAuth != "Bearer clerk-session-jwt" {
		t.Errorf("got Authorization %q, want the caller's Clerk header forwarded verbatim", gotAuth)
	}
}

// An empty caller header is legitimate — st-gateway reads it only to classify
// priority, and no token simply means background. Sending an empty
// Authorization would look like a malformed credential instead.
func TestAnAbsentCallerHeaderSendsNoAuthorizationAtAll(t *testing.T) {
	var present bool
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header["Authorization"]
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{}}`))
	})

	if _, err := client.GetMyAgent(""); err != nil {
		t.Fatalf("GetMyAgent returned error: %v", err)
	}
	if present {
		t.Error("an empty Authorization header was sent; it should be omitted")
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

	result, err := client.PurchaseCargo("Bearer test-token", "TEST-1", "FUEL", 10)
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

	if _, err := client.SellCargo("Bearer t", "TEST-1", "FUEL", 3); err != nil {
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
		_, err := client.GetMyAgent("Bearer t")
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

	_, err := client.GetMyAgent("Bearer t")
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

	_, err := client.GetMyAgent("Bearer t")
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
