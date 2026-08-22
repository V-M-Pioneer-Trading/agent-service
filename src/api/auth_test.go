package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func newTestRouter(t *testing.T) http.Handler {
	t.Helper()
	router, err := SetUpRouter(nil, testAuthConfig())
	if err != nil {
		t.Fatalf("SetUpRouter: %v", err)
	}
	return router
}

func doRequest(t *testing.T, router http.Handler, method, path, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	req.Header.Set("X-SpaceTraders-Token", "irrelevant-for-these-cases")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestScopeGatedMutationsRejectWithoutAValidSession(t *testing.T) {
	router := newTestRouter(t)

	cases := []struct {
		name          string
		path          string
		authorization string
		wantStatus    int
	}{
		{"no Authorization header at all", "/api/agent/v1/contracts/abc/accept", "", http.StatusUnauthorized},
		{"expired session", "/api/agent/v1/contracts/abc/accept", expiredBearer(), http.StatusUnauthorized},
		{"signed by an untrusted key", "/api/agent/v1/contracts/abc/accept", foreignBearer(), http.StatusUnauthorized},
		{"valid session but no fleet:control scope", "/api/agent/v1/contracts/abc/accept", bearerWithoutScope(), http.StatusForbidden},
		{"purchaseShip: no session", "/api/agent/v1/ships/purchase", "", http.StatusUnauthorized},
		{"purchaseShip: no scope", "/api/agent/v1/ships/purchase", bearerWithoutScope(), http.StatusForbidden},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := doRequest(t, router, http.MethodPost, c.path, c.authorization)
			if rec.Code != c.wantStatus {
				t.Errorf("got status %d, want %d (body: %s)", rec.Code, c.wantStatus, rec.Body.String())
			}
		})
	}
}

func TestSessionGatedReadsRejectWithoutAnySession(t *testing.T) {
	router := newTestRouter(t)

	for _, path := range []string{
		"/api/agent/v1/current-agent",
		"/api/agent/v1/agent",
		"/api/agent/v1/ships",
		"/api/agent/v1/contracts",
	} {
		t.Run(path, func(t *testing.T) {
			rec := doRequest(t, router, http.MethodGet, path, "")
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s: got status %d, want 401", path, rec.Code)
			}
		})
	}
}

// The read/write split is the behavior most worth proving directly: a
// session with *no* scope at all must still reach the upstream call on a
// read (auth-design.md decision 18 — no scope requirement there), which is
// exactly the case a mutation route must forbid.
func TestSessionWithNoScopeReachesTheUpstreamCallOnARead(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT","credits":100}}`))
	}))
	defer upstream.Close()
	t.Setenv("ST_GATEWAY_URL", upstream.URL)

	router := newTestRouter(t)
	rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/agent", bearerWithoutScope())

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestPublicRoutesNeedNoSessionAtAll(t *testing.T) {
	// getTransactions and getDeliveries read only this service's own MySQL
	// history — never SpaceTraders — so there is no credential problem to
	// gate against (auth-design.md decision 18). A mocked DB (rather than
	// nil) lets the request reach a real 200, proving it got past the auth
	// layer rather than merely failing to panic.
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer db.Close()

	router, err := SetUpRouter(db, testAuthConfig())
	if err != nil {
		t.Fatalf("SetUpRouter: %v", err)
	}

	cases := []struct {
		path    string
		columns []string
	}{
		{
			"/api/agent/v1/transactions",
			[]string{"type", "ship_symbol", "waypoint_symbol", "ship_type", "trade_symbol", "units", "price_per_unit", "total_price", "agent_credits", "occurred_at"},
		},
		{
			"/api/agent/v1/contracts/abc/deliveries",
			[]string{"contract_id", "ship_symbol", "trade_symbol", "units", "delivered_at"},
		},
	}

	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			mock.ExpectQuery(".*").WillReturnRows(sqlmock.NewRows(c.columns))

			rec := doRequest(t, router, http.MethodGet, c.path, "")
			if rec.Code != http.StatusOK {
				t.Errorf("%s: got status %d, want 200 (body: %s)", c.path, rec.Code, rec.Body.String())
			}
		})
	}
}

func TestRequireClerkJWTKeyFailsClosed(t *testing.T) {
	os.Unsetenv("CLERK_JWT_KEY")
	os.Unsetenv("CLERK_JWT_KEY_FILE")

	if _, err := RequireClerkJWTKey(); err == nil {
		t.Fatal("expected an error with neither CLERK_JWT_KEY nor CLERK_JWT_KEY_FILE set")
	}
}
