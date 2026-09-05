package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestHealthEndpoint(t *testing.T) {
	router := newTestRouter(t, nil, nil)

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

// Regression: an empty history came back as JSON `null`, because a Go nil
// slice marshals to null and neither list query pre-allocated one. Callers
// iterating the response had to special-case it or crash.
func TestEmptyHistoryListsSerialiseAsArraysNotNull(t *testing.T) {
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
			if got := strings.TrimSpace(rec.Body.String()); got != "[]" {
				t.Errorf("got body %q, want []", got)
			}
		})
	}
}

// Regression: ?type= was passed straight into the SQL filter, so a typo or a
// renamed constant matched no rows and returned an empty list — indistinguishable
// from a genuinely empty history.
func TestUnknownTransactionTypeIsRejected(t *testing.T) {
	conn, _ := newMockDB(t)
	router := newTestRouter(t, conn, nil)

	rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/transactions?type=NOT_A_TYPE", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "SHIP_PURCHASE") {
		t.Errorf("expected the error to list the valid types, got %q", rec.Body.String())
	}
}

func TestKnownTransactionTypesAreAccepted(t *testing.T) {
	conn, mock := newMockDB(t)
	router := newTestRouter(t, conn, nil)

	for _, txType := range []string{"SHIP_PURCHASE", "PURCHASE", "SELL"} {
		t.Run(txType, func(t *testing.T) {
			mock.ExpectQuery(".*").WithArgs(txType, defaultTransactionLimit).
				WillReturnRows(sqlmock.NewRows(transactionColumns))

			rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/transactions?type="+txType, "")
			if rec.Code != http.StatusOK {
				t.Errorf("got status %d, want 200 (body: %s)", rec.Code, rec.Body.String())
			}
		})
	}
}

// Regression: `limit` was clamped in neither direction. A non-numeric value was
// silently replaced by the default (so a typo returned the wrong page size with
// no signal), and an arbitrarily large one went straight through to MySQL.
func TestTransactionLimitIsValidatedAndCapped(t *testing.T) {
	conn, mock := newMockDB(t)
	router := newTestRouter(t, conn, nil)

	t.Run("non-numeric is rejected rather than defaulted", func(t *testing.T) {
		rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/transactions?limit=abc", "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("got status %d, want 400 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("zero is rejected", func(t *testing.T) {
		rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/transactions?limit=0", "")
		if rec.Code != http.StatusBadRequest {
			t.Errorf("got status %d, want 400 (body: %s)", rec.Code, rec.Body.String())
		}
	})

	t.Run("an oversized limit is capped before it reaches the query", func(t *testing.T) {
		mock.ExpectQuery(".*").WithArgs(maxTransactionLimit).
			WillReturnRows(sqlmock.NewRows(transactionColumns))

		rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/transactions?limit=999999999", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("got status %d, want 200 (body: %s)", rec.Code, rec.Body.String())
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Errorf("query did not receive the capped limit: %v", err)
		}
	})
}

// Regression: request bodies were decoded straight off r.Body with no ceiling,
// so a caller could make the service buffer an arbitrarily large payload before
// any validation ran.
func TestOversizedRequestBodyIsRejected(t *testing.T) {
	conn, _ := newMockDB(t)
	router := newTestRouter(t, conn, nil)

	body := `{"shipSymbol":"S","tradeSymbol":"` + strings.Repeat("A", maxBodyBytes) + `","units":1}`
	req := httptest.NewRequest(http.MethodPost, "/api/agent/v1/contracts/abc/deliveries", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

// A cargo purchase must be recorded against the same identifier the
// transaction type says, using the shared db constants rather than a literal
// repeated at each call site.
func TestPurchaseCargoRecordsATypedTransaction(t *testing.T) {
	conn, mock := newMockDB(t)
	gateway := stubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":{"agent":{"credits":5000},"cargo":{"capacity":40,"units":10},` +
			`"transaction":{"waypointSymbol":"X1-TEST","shipSymbol":"TEST-1","tradeSymbol":"FUEL",` +
			`"type":"PURCHASE","units":10,"pricePerUnit":5,"totalPrice":50,"timestamp":"2026-01-01T00:00:00Z"}}}`))
	})
	router := newTestRouter(t, conn, gateway)

	mock.ExpectExec("INSERT INTO transactions").
		WithArgs("PURCHASE", "TEST-1", "X1-TEST", nil, "FUEL", 10, 5, 50, 5000, sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))

	req := httptest.NewRequest(http.MethodPost, "/api/agent/v1/ships/TEST-1/purchase",
		strings.NewReader(`{"symbol":"FUEL","units":10}`))
	req.Header.Set("Authorization", bearer())
	req.Header.Set("X-SpaceTraders-Token", "game-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("transaction was not recorded as expected: %v", err)
	}
}

// A SpaceTraders error must keep its own status code rather than collapsing to
// 502: a rejected game token is the caller's problem to fix, not a gateway fault.
func TestUpstreamErrorStatusIsPreserved(t *testing.T) {
	gateway := stubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error":{"message":"ship not found"}}`))
	})
	router := newTestRouter(t, nil, gateway)

	rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/ships/NOPE", bearer())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got status %d, want 404 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestCORSPreflightIsAnsweredWithoutAuthentication(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGIN", "https://example.test")
	router := newTestRouter(t, nil, nil)

	req := httptest.NewRequest(http.MethodOptions, "/api/agent/v1/agent", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("got status %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://example.test" {
		t.Errorf("got allowed origin %q, want https://example.test", got)
	}
}

// The bundled read must surface an upstream failure rather than returning a
// half-filled response with the missing sections silently empty.
func TestCurrentAgentFailsLoudlyWhenAnUpstreamCallFails(t *testing.T) {
	gateway := stubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/my/agent") {
			w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"error":{"message":"upstream down"}}`))
	})
	router := newTestRouter(t, nil, gateway)

	rec := doRequest(t, router, http.MethodGet, "/api/agent/v1/current-agent", bearer())
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got status %d, want 503 (body: %s)", rec.Code, rec.Body.String())
	}
	var bundle CurrentAgentResponse
	if json.Unmarshal(rec.Body.Bytes(), &bundle) == nil && bundle.Agent.Symbol != "" {
		t.Error("a partially-filled bundle was returned instead of an error")
	}
}

// Regression guard for a deployment-ordering trap: this service no longer reads
// X-SpaceTraders-Token or X-Priority, but command-interface still *sends* both.
// A header a browser sends that is missing from Access-Control-Allow-Headers
// fails preflight, and a failed preflight blocks the request entirely — so
// dropping them from the allow-list before the frontend stops sending them
// would turn "ignores a useless header" into "the dashboard is down". They come
// off the list only after command-interface does (increment 3 Stage 5, meta#72).
func TestPreflightStillAllowsTheHeadersTheFrontendStillSends(t *testing.T) {
	router := newTestRouter(t, nil, nil)

	req := httptest.NewRequest(http.MethodOptions, "/api/agent/v1/agent", nil)
	req.Header.Set("Access-Control-Request-Method", http.MethodGet)
	req.Header.Set("Access-Control-Request-Headers", "authorization,x-spacetraders-token,x-priority")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("got status %d, want 204", rec.Code)
	}
	allowed := strings.ToLower(rec.Header().Get("Access-Control-Allow-Headers"))
	for _, header := range []string{"authorization", "x-spacetraders-token", "x-priority"} {
		if !strings.Contains(allowed, header) {
			t.Errorf("%q missing from Access-Control-Allow-Headers (%q) — preflight would fail for a caller that still sends it", header, allowed)
		}
	}
}
