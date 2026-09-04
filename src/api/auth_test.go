package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

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
	router := newTestRouter(t, nil, nil)

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
	router := newTestRouter(t, nil, nil)

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
	gateway := stubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT","credits":100}}`))
	})

	router := newTestRouter(t, nil, gateway)
	rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/agent", bearerWithoutScope())

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
}

// Regression: the game token is a second, independent credential. Before it
// became middleware, each handler checked it itself and answered with a bare
// text/plain 401 — a different body shape from every other auth rejection, on
// routes where the router gave no hint the header was required at all.
func TestValidSessionWithoutAGameTokenIsRejected(t *testing.T) {
	router := newTestRouter(t, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/agent/v1/agent", nil)
	req.Header.Set("Authorization", bearer())
	// deliberately no X-SpaceTraders-Token
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("got status %d, want 401 (body: %s)", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("got Content-Type %q, want application/json", got)
	}
	if msg := decodeAuthError(t, rec); msg == "" {
		t.Errorf("expected an error.message in the body, got %q", rec.Body.String())
	}
}

func TestPublicRoutesNeedNoSessionAtAll(t *testing.T) {
	// getTransactions and getDeliveries read only this service's own MySQL
	// history — never SpaceTraders — so there is no credential problem to
	// gate against (auth-design.md decision 18). A mocked DB (rather than
	// nil) lets the request reach a real 200, proving it got past the auth
	// layer rather than merely failing to panic.
	conn, mock := newMockDB(t)
	router := newTestRouter(t, conn, nil)

	cases := []struct {
		path    string
		columns []string
	}{
		{"/api/agent/v1/transactions", transactionColumns},
		{"/api/agent/v1/contracts/abc/deliveries", deliveryColumns},
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
	// t.Setenv, not os.Unsetenv: the old version cleared both variables for
	// the rest of the test binary, so whether a later test saw them depended
	// on the order Go happened to run them in.
	t.Setenv("CLERK_JWT_KEY", "")
	t.Setenv("CLERK_JWT_KEY_FILE", "")

	if _, err := RequireClerkJWTKey(); err == nil {
		t.Fatal("expected an error with neither CLERK_JWT_KEY nor CLERK_JWT_KEY_FILE set")
	}
}

func TestRequireClerkJWTKeyRejectsAnEmptyKeyFile(t *testing.T) {
	path := t.TempDir() + "/empty.pem"
	if err := writeFile(path, "   \n"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLERK_JWT_KEY", "")
	t.Setenv("CLERK_JWT_KEY_FILE", path)

	if _, err := RequireClerkJWTKey(); err == nil {
		t.Fatal("expected an error for an empty CLERK_JWT_KEY_FILE")
	}
}
