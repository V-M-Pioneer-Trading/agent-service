package spacetraders

import (
	"context"
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

// The client sends no credential and no priority hint: st-gateway injects the
// agent token (auth-design.md decision 5) and derives priority itself (decision
// 2). A header reappearing here would be a regression, not a feature.
func TestGetMyAgentRoutesThroughGateway(t *testing.T) {
	var gotPath, gotAuth string
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	})

	agent, err := client.GetMyAgent(context.Background())
	if err != nil {
		t.Fatalf("GetMyAgent returned error: %v", err)
	}
	if agent.Symbol != "TEST-AGENT" {
		t.Errorf("expected symbol TEST-AGENT, got %q", agent.Symbol)
	}
	if gotPath != "/proxy/my/agent" {
		t.Errorf("expected request to hit gateway's /proxy path, got %q", gotPath)
	}
	if gotAuth != "" {
		t.Errorf("expected no Authorization header (st-gateway injects the agent token, decision 5), got %q", gotAuth)
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

	result, err := client.PurchaseCargo(context.Background(), "TEST-1", "FUEL", 10)
	if err != nil {
		t.Fatalf("PurchaseCargo returned error: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("expected POST, got %s", gotMethod)
	}
	if gotPath != "/proxy/my/ships/TEST-1/purchase" {
		t.Errorf("expected request to hit gateway's purchase path, got %q", gotPath)
	}
	if gotAuth != "" {
		t.Errorf("expected no Authorization header (st-gateway injects the agent token, decision 5), got %q", gotAuth)
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

	if _, err := client.SellCargo(context.Background(), "TEST-1", "FUEL", 3); err != nil {
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
		_, err := client.GetMyAgent(context.Background())
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

// The message is the upstream's own sentence and nothing else: lifted out of the
// envelope, with no "GET /my/agent:" narration in front of it. Handlers write it
// straight to the caller, so matching on it downstream has to mean the same thing
// whichever service relayed it. Where the call happened is a separate field, for
// the log line.
func TestUpstreamErrorRelaysTheGatewaysOwnSentence(t *testing.T) {
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "3")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"You have reached your API limit."}}`))
	})

	_, err := client.GetMyAgent(context.Background())
	var upstream *UpstreamError
	if !errors.As(err, &upstream) {
		t.Fatalf("expected an *UpstreamError, got %v", err)
	}
	if upstream.StatusCode != http.StatusTooManyRequests {
		t.Errorf("got status %d, want 429", upstream.StatusCode)
	}
	if upstream.Message != "You have reached your API limit." {
		t.Errorf("got message %q, want the envelope's sentence alone", upstream.Message)
	}
	if upstream.Endpoint == "" {
		t.Error("expected the endpoint to be carried for the log line")
	}
	if got := upstream.Headers["Retry-After"]; got != "3" {
		t.Errorf("got Retry-After %q, want 3 — relaying the status without the pacing headers keeps the news and drops the instructions", got)
	}
}

// A gateway that does not answer is the one verdict this service reaches on its
// own, and it is a 504: the fault is upstream of the caller and a retry may work,
// where a 502 means "answered, and I cannot use it". It used to escape as a bare
// transport error, which the handler could only render as an undifferentiated 502.
func TestGatewayNotAnsweringIsAGatewayTimeout(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := dead.URL
	dead.Close()

	_, err := NewClientWithBaseURL(url).GetMyAgent(context.Background())
	var upstream *UpstreamError
	if !errors.As(err, &upstream) {
		t.Fatalf("expected an *UpstreamError, got %v", err)
	}
	if upstream.StatusCode != http.StatusGatewayTimeout {
		t.Errorf("got status %d, want 504", upstream.StatusCode)
	}
}

// Regression: the whole error body went into the message with no bound, so a
// misbehaving upstream could grow a log line without limit. Two bounds now — the
// read itself, and how much of an unrecognised body is worth relaying.
func TestUpstreamErrorMessageIsBounded(t *testing.T) {
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(strings.Repeat("x", maxErrorBody*2)))
	})

	_, err := client.GetMyAgent(context.Background())
	var upstream *UpstreamError
	if !errors.As(err, &upstream) {
		t.Fatalf("expected an *UpstreamError, got %v", err)
	}
	if len(upstream.Message) > maxMessageLength {
		t.Errorf("message is %d bytes, want at most %d", len(upstream.Message), maxMessageLength)
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

// Symbols come straight from the caller's URL. Without escaping, a ship symbol
// like "../agent" would steer the gateway at a different proxy path entirely.
func TestPathSegmentsAreEscaped(t *testing.T) {
	var gotPath string
	client := newStubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.Write([]byte(`{"data":{}}`))
	})

	if _, err := client.GetMyShip(context.Background(), "a/b c"); err != nil {
		t.Fatalf("GetMyShip returned error: %v", err)
	}
	if gotPath != "/proxy/my/ships/a%2Fb%20c" {
		t.Errorf("expected the symbol escaped as one segment, got %q", gotPath)
	}
}
