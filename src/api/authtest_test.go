package api

// Test support: a stub auth-service center, not a keypair.
//
// agent-service no longer verifies tokens (auth-design.md decision 21), so its
// tests sign nothing. A test router's guard talks over real HTTP to a stub
// center that answers from a fixed table of opaque token strings — the same
// arrangement meta/fixtures/introspection.json prescribes, and the one the
// conformance suite in package introspection uses. The token strings are
// deliberately not JWTs.

import (
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"vnm/agent-info-service/introspection"
	"vnm/agent-info-service/spacetraders"
)

const (
	testIntrospectionPath   = "/auth/v1/introspect"
	testIntrospectionSecret = "api-test-introspection-secret"

	tokenOperator        = "operator.fleet-control"
	tokenOperatorNoScope = "operator.no-scope"
	tokenMachine         = "machine.fleet-control"
	tokenInactive        = "inactive.token"
)

// centerAnswers is what the stub center says about each token. Anything not
// listed is {"active":false}, as the real center answers for a token it cannot
// verify.
var centerAnswers = map[string]string{
	tokenOperator:        `{"active":true,"sub":"user_2TestOperator","scope":"fleet:control","exp":4102444800,"kind":"operator"}`,
	tokenOperatorNoScope: `{"active":true,"sub":"user_2TestGuest","exp":4102444800,"kind":"operator"}`,
	tokenMachine:         `{"active":true,"sub":"mch_2TestMachine","scope":"fleet:control agent:reset","exp":4102444800,"kind":"machine"}`,
}

// bearer is an operator holding fleet:control.
func bearer() string { return "Bearer " + tokenOperator }

// bearerWithoutScope is a verified session carrying no scope at all.
func bearerWithoutScope() string { return "Bearer " + tokenOperatorNoScope }

// machineBearer is automation-service's M2M token.
func machineBearer() string { return "Bearer " + tokenMachine }

// inactiveBearer is a token the center does not accept: expired, foreign,
// forged — the center does not say which, and neither does this service.
func inactiveBearer() string { return "Bearer " + tokenInactive }

// testCenter is a stub auth-service.
type testCenter struct {
	url   string
	calls atomic.Int64
}

func (c *testCenter) Calls() int { return int(c.calls.Load()) }

func newTestCenter(t *testing.T) *testCenter {
	t.Helper()
	c := &testCenter{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != testIntrospectionPath || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get(introspection.SecretHeader) != testIntrospectionSecret {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":{"message":"a valid introspection secret is required"}}`)
			return
		}
		body, _ := io.ReadAll(r.Body)
		form, err := url.ParseQuery(string(body))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		answer, ok := centerAnswers[form.Get("token")]
		if !ok {
			answer = `{"active":false}`
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, answer)
	}))
	t.Cleanup(server.Close)
	c.url = server.URL + testIntrospectionPath
	return c
}

// deadCenterURL is an introspection URL on a port nothing listens on.
func deadCenterURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return "http://" + addr + testIntrospectionPath
}

func guardFor(centerURL string) *introspection.Guard {
	quiet := log.New(io.Discard, "", 0)
	return introspection.NewGuard(introspection.NewClient(introspection.Config{
		URL: centerURL, Secret: testIntrospectionSecret,
	}, quiet), quiet)
}

// Column lists mirroring the SELECTs in package db, so a stubbed row set
// matches what Scan expects.
var (
	transactionColumns = []string{"type", "ship_symbol", "waypoint_symbol", "ship_type", "trade_symbol",
		"units", "price_per_unit", "total_price", "agent_credits", "occurred_at"}
	deliveryColumns = []string{"contract_id", "ship_symbol", "trade_symbol", "units", "delivered_at"}
)

// newTestRouter builds the real router against a fresh stub center.
// Dependencies are injected rather than discovered from process environment,
// so tests never mutate global state and can run in any order.
func newTestRouter(t *testing.T, conn *sql.DB, st *spacetraders.Client) http.Handler {
	t.Helper()
	router, _ := newTestRouterWithCenter(t, conn, st)
	return router
}

// newTestRouterWithCenter also returns the stub center, for tests that count
// calls to it.
func newTestRouterWithCenter(t *testing.T, conn *sql.DB, st *spacetraders.Client) (http.Handler, *testCenter) {
	t.Helper()
	center := newTestCenter(t)
	router, err := SetUpRouter(conn, st, guardFor(center.url))
	if err != nil {
		t.Fatalf("SetUpRouter: %v", err)
	}
	return router, center
}

// stubGateway stands in for st-gateway and returns a client pointed at it.
func stubGateway(t *testing.T, handler http.HandlerFunc) *spacetraders.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return spacetraders.NewClientWithBaseURL(server.URL)
}

func newMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, mock
}

// decodeAuthError pulls error.message out of a JSON auth rejection.
func decodeAuthError(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body authError
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding auth error %q: %v", rec.Body.String(), err)
	}
	return body.Error.Message
}
