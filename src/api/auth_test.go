package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/gorilla/mux"

	"vnm/agent-info-service/introspection"
)

func doRequest(t *testing.T, router http.Handler, method, path, authorization string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// TestEveryRouteDeclaresExactlyThisPolicy is the route table, pinned. Adding,
// dropping or loosening a route's requirement fails here with a readable
// diff, and the table below is the one the README documents.
func TestEveryRouteDeclaresExactlyThisPolicy(t *testing.T) {
	router, err := SetUpRouter(nil, nil, guardFor(newTestCenter(t).url))
	if err != nil {
		t.Fatal(err)
	}

	var got []string
	err = router.Walk(func(route *mux.Route, _ *mux.Router, _ []*mux.Route) error {
		h := route.GetHandler()
		if h == nil {
			return nil
		}
		path, err := route.GetPathTemplate()
		if err != nil {
			path = "*"
		}
		methods, _ := route.GetMethods()
		decl, ok := introspection.DeclarationOf(h)
		policy := "UNDECLARED"
		switch {
		case !ok:
		case decl.IgnoresCredentials:
			policy = "ignore-credentials"
		default:
			policy = decl.Requirement.String()
		}
		got = append(got, fmt.Sprintf("%-12s %-44s %s", strings.Join(methods, ","), path, policy))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(got)

	want := []string{
		"GET,HEAD     /api/agent/health                            ignore-credentials",
		"GET,HEAD     /api/agent/swagger/                          ignore-credentials",
		"GET,HEAD     /api/agent/v1/agent                          session",
		"GET,HEAD     /api/agent/v1/contracts                      session",
		"GET,HEAD     /api/agent/v1/contracts/{contractId}         session",
		"GET,HEAD     /api/agent/v1/contracts/{contractId}/deliveries none",
		"GET,HEAD     /api/agent/v1/current-agent                  session",
		"GET,HEAD     /api/agent/v1/ships                          session",
		"GET,HEAD     /api/agent/v1/ships/{shipSymbol}             session",
		"GET,HEAD     /api/agent/v1/transactions                   none",
		"GET,HEAD     /health                                      ignore-credentials",
		"OPTIONS      *                                            none",
		"POST         /api/agent/v1/contracts/{contractId}/accept  fleet:control",
		"POST         /api/agent/v1/contracts/{contractId}/deliveries fleet:control",
		"POST         /api/agent/v1/contracts/{contractId}/fulfill fleet:control",
		"POST         /api/agent/v1/ships/purchase                 fleet:control",
		"POST         /api/agent/v1/ships/{shipSymbol}/purchase    fleet:control",
		"POST         /api/agent/v1/ships/{shipSymbol}/sell        fleet:control",
	}
	sort.Strings(want)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("route table changed:\n--- got\n%s\n--- want\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestScopeGatedMutationsRejectWithoutAValidSession(t *testing.T) {
	router, center := newTestRouterWithCenter(t, nil, nil)

	cases := []struct {
		name          string
		path          string
		authorization string
		wantStatus    int
		wantMessage   string
		wantCalls     int
	}{
		{"no Authorization header at all", "/api/agent/v1/contracts/abc/accept", "", 401, introspection.MessageMissingToken, 0},
		{"a token the center does not accept", "/api/agent/v1/contracts/abc/accept", inactiveBearer(), 401, introspection.MessageInvalidSession, 1},
		{"valid session but no fleet:control scope", "/api/agent/v1/contracts/abc/accept", bearerWithoutScope(), 403, introspection.MessageMissingScope, 1},
		{"malformed header", "/api/agent/v1/contracts/abc/accept", "Bearer abc def", 401, introspection.MessageMissingToken, 0},
		{"purchaseShip: no session", "/api/agent/v1/ships/purchase", "", 401, introspection.MessageMissingToken, 0},
		{"purchaseShip: no scope", "/api/agent/v1/ships/purchase", bearerWithoutScope(), 403, introspection.MessageMissingScope, 1},
		{"sell: inactive", "/api/agent/v1/ships/S-1/sell", inactiveBearer(), 401, introspection.MessageInvalidSession, 1},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := center.Calls()
			rec := doRequest(t, router, http.MethodPost, c.path, c.authorization)
			if rec.Code != c.wantStatus {
				t.Errorf("got status %d, want %d (body: %s)", rec.Code, c.wantStatus, rec.Body.String())
			}
			if got := decodeAuthError(t, rec); got != c.wantMessage {
				t.Errorf("got message %q, want %q", got, c.wantMessage)
			}
			if got := center.Calls() - before; got != c.wantCalls {
				t.Errorf("center called %d times, want %d", got, c.wantCalls)
			}
		})
	}
}

// meta#71: recording a delivery was an unauthenticated write. It now needs
// fleet:control like every sibling mutation; fleet-service forwards its own
// caller's bearer on this call (meta#80 step 5).
func TestRecordingADeliveryRequiresFleetControl(t *testing.T) {
	const path = "/api/agent/v1/contracts/C-1/deliveries"
	const body = `{"shipSymbol":"S-1","tradeSymbol":"IRON_ORE","units":10}`

	post := func(router http.Handler, authorization string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	for _, c := range []struct {
		name, authorization string
		status              int
		message             string
	}{
		{"no header", "", 401, introspection.MessageMissingToken},
		{"inactive token", inactiveBearer(), 401, introspection.MessageInvalidSession},
		{"session without fleet:control", bearerWithoutScope(), 403, introspection.MessageMissingScope},
	} {
		t.Run(c.name, func(t *testing.T) {
			// sqlmock with no expectations: any query at all fails the test.
			conn, mock := newMockDB(t)
			router := newTestRouter(t, conn, nil)
			rec := post(router, c.authorization)
			if rec.Code != c.status || decodeAuthError(t, rec) != c.message {
				t.Fatalf("got %d %s, want %d %q", rec.Code, rec.Body.String(), c.status, c.message)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Error(err)
			}
		})
	}

	for _, c := range []struct{ name, authorization string }{
		{"operator with fleet:control", bearer()},
		{"automation-service's machine token", machineBearer()},
	} {
		t.Run(c.name, func(t *testing.T) {
			conn, mock := newMockDB(t)
			mock.ExpectExec("INSERT INTO contract_deliveries").
				WithArgs("C-1", "S-1", "IRON_ORE", 10, sqlmock.AnyArg()).
				WillReturnResult(sqlmock.NewResult(1, 1))
			rec := post(newTestRouter(t, conn, nil), c.authorization)
			if rec.Code != http.StatusOK {
				t.Fatalf("got %d %s, want 200", rec.Code, rec.Body.String())
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Error(err)
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
		"/api/agent/v1/ships/S-1",
		"/api/agent/v1/contracts",
		"/api/agent/v1/contracts/C-1",
	} {
		t.Run(path, func(t *testing.T) {
			rec := doRequest(t, router, http.MethodGet, path, "")
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s: got status %d, want 401", path, rec.Code)
			}
		})
	}
}

// HEAD is registered on the same route object as GET, so it carries the same
// requirement: a credential-free HEAD of a guarded read is a 401, and a HEAD
// with a valid session proceeds exactly as GET would.
func TestHeadOnAGuardedReadIsGovernedByItsGetRequirement(t *testing.T) {
	gatewayCalls := 0
	gateway := stubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		gatewayCalls++
		if got := r.Header.Get("Authorization"); got != bearer() {
			t.Errorf("st-gateway received Authorization %q, want the caller's session", got)
		}
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT","credits":100}}`))
	})
	router, center := newTestRouterWithCenter(t, nil, gateway)

	rec := doRequest(t, router, http.MethodHead, "/api/agent/v1/agent", "")
	if rec.Code != http.StatusUnauthorized || center.Calls() != 0 || gatewayCalls != 0 {
		t.Fatalf("HEAD without a token: got %d, center calls %d, gateway calls %d", rec.Code, center.Calls(), gatewayCalls)
	}

	rec = doRequest(t, router, http.MethodHead, "/api/agent/v1/agent", inactiveBearer())
	if rec.Code != http.StatusUnauthorized || gatewayCalls != 0 {
		t.Fatalf("HEAD with an inactive token: got %d, gateway calls %d", rec.Code, gatewayCalls)
	}

	rec = doRequest(t, router, http.MethodHead, "/api/agent/v1/agent", bearer())
	if rec.Code != http.StatusOK || gatewayCalls != 1 {
		t.Fatalf("HEAD with a valid token: got %d %s, gateway calls %d", rec.Code, rec.Body.String(), gatewayCalls)
	}

	// Over a real connection a HEAD carries no body.
	server := httptest.NewServer(router)
	defer server.Close()
	req, _ := http.NewRequest(http.MethodHead, server.URL+"/api/agent/v1/agent", nil)
	req.Header.Set("Authorization", bearer())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("real HEAD: status %d", resp.StatusCode)
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

// Stage 5 of increment 3: the game token is gone from this service. A caller
// still sending the old header (a stale dashboard build, a script) is served
// normally, never rejected — st-gateway overwrites the credential anyway, so
// rejecting would only create a deploy-ordering trap for zero security gain.
func TestAStrayGameTokenHeaderIsIgnored(t *testing.T) {
	gateway := stubGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-SpaceTraders-Token"); got != "" {
			t.Errorf("stray header must not be forwarded upstream, got %q", got)
		}
		w.Write([]byte(`{"data":{"symbol":"TEST-AGENT"}}`))
	})
	router := newTestRouter(t, nil, gateway)

	req := httptest.NewRequest(http.MethodGet, "/api/agent/v1/agent", nil)
	req.Header.Set("Authorization", bearer())
	req.Header.Set("X-SpaceTraders-Token", "stale-client-still-sends-this")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestPublicRoutesNeedNoSessionAtAll(t *testing.T) {
	// getTransactions and getDeliveries read only this service's own MySQL
	// history — never SpaceTraders — so a visitor with no header is served
	// (auth-design.md decision 18), and the center is not asked. A mocked DB
	// (rather than nil) lets the request reach a real 200, proving it got past
	// the auth layer rather than merely failing to panic.
	conn, mock := newMockDB(t)
	router, center := newTestRouterWithCenter(t, conn, nil)

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
	if center.Calls() != 0 {
		t.Errorf("center called %d times for anonymous reads", center.Calls())
	}
}

// A presented token is never downgraded to a visitor, even on a public read:
// an inactive one is a 401, and with the center down it is a 503. Without a
// header the same read keeps working while auth-service is down.
func TestAPresentedTokenOnAPublicReadIsStillVerified(t *testing.T) {
	const path = "/api/agent/v1/transactions"

	t.Run("inactive token is a 401", func(t *testing.T) {
		conn, mock := newMockDB(t)
		rec := doRequest(t, newTestRouter(t, conn, nil), http.MethodGet, path, inactiveBearer())
		if rec.Code != http.StatusUnauthorized || decodeAuthError(t, rec) != introspection.MessageInvalidSession {
			t.Fatalf("got %d %s", rec.Code, rec.Body.String())
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
	})

	deadRouter := func(t *testing.T) (http.Handler, sqlmock.Sqlmock) {
		conn, mock := newMockDB(t)
		router, err := SetUpRouter(conn, nil, guardFor(deadCenterURL(t)))
		if err != nil {
			t.Fatal(err)
		}
		return router, mock
	}

	t.Run("center down, token presented: 503", func(t *testing.T) {
		router, _ := deadRouter(t)
		rec := doRequest(t, router, http.MethodGet, path, bearer())
		if rec.Code != http.StatusServiceUnavailable || decodeAuthError(t, rec) != introspection.MessageCenterUnavailable {
			t.Fatalf("got %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("center down, no header: still served", func(t *testing.T) {
		router, mock := deadRouter(t)
		mock.ExpectQuery(".*").WillReturnRows(sqlmock.NewRows(transactionColumns))
		rec := doRequest(t, router, http.MethodGet, path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("center down, mutation: 503", func(t *testing.T) {
		router, _ := deadRouter(t)
		rec := doRequest(t, router, http.MethodPost, "/api/agent/v1/contracts/C-1/accept", bearer())
		if rec.Code != http.StatusServiceUnavailable || decodeAuthError(t, rec) != introspection.MessageCenterUnavailable {
			t.Fatalf("got %d %s", rec.Code, rec.Body.String())
		}
	})
}

// Health never reads the Authorization header and never asks the center, so a
// garbage bearer changes nothing and an auth-service outage does not make the
// service look unhealthy.
func TestHealthIgnoresCredentials(t *testing.T) {
	router, center := newTestRouterWithCenter(t, nil, nil)
	deadRouter, err := SetUpRouter(nil, nil, guardFor(deadCenterURL(t)))
	if err != nil {
		t.Fatal(err)
	}

	for _, r := range []http.Handler{router, deadRouter} {
		for _, path := range []string{"/health", "/api/agent/health"} {
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				for _, header := range []string{"", inactiveBearer(), bearer(), "Bearer abc def", "Basic x"} {
					rec := doRequest(t, r, method, path, header)
					if rec.Code != http.StatusOK {
						t.Errorf("%s %s with %q: got %d %s", method, path, header, rec.Code, rec.Body.String())
					}
				}
			}
		}
	}
	if center.Calls() != 0 {
		t.Errorf("health asked the center %d times", center.Calls())
	}
}

func TestSwaggerAnswersOnlySafeMethodsAndIgnoresCredentials(t *testing.T) {
	router, center := newTestRouterWithCenter(t, nil, nil)
	rec := doRequest(t, router, http.MethodGet, "/api/agent/swagger/doc.json", inactiveBearer())
	if rec.Code != http.StatusOK {
		t.Errorf("GET doc.json: %d", rec.Code)
	}
	rec = doRequest(t, router, http.MethodPost, "/api/agent/swagger/doc.json", "")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST doc.json: %d, want 405", rec.Code)
	}
	if center.Calls() != 0 {
		t.Errorf("swagger asked the center %d times", center.Calls())
	}
}

// App-level default-deny: the adapter refuses at startup to build a router in
// which any route is undeclared, or a mutating route declares nothing — and at
// request time refuses a matched route whose handler carries no declaration.
func TestSecureRouterRefusesUndeclaredAndUnguardedMutatingRoutes(t *testing.T) {
	guard := guardFor(newTestCenter(t).url)
	ok := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})

	refused := map[string]func(r *mux.Router){
		"POST with no declaration": func(r *mux.Router) { r.Handle("/x", ok).Methods(http.MethodPost) },
		"GET with no declaration":  func(r *mux.Router) { r.Handle("/x", ok).Methods(http.MethodGet) },
		"POST declaring none":      func(r *mux.Router) { postRoute(r, "/x", guard.Require(introspection.None(), ok)) },
		"DELETE declaring none": func(r *mux.Router) {
			r.Handle("/x", guard.Require(introspection.None(), ok)).Methods(http.MethodDelete)
		},
		"POST ignoring credentials": func(r *mux.Router) { postRoute(r, "/x", introspection.IgnoreCredentials(ok)) },
		"any-method route, none":    func(r *mux.Router) { r.Handle("/x", guard.Require(introspection.None(), ok)) },
		"any-method prefix, ignore": func(r *mux.Router) { r.PathPrefix("/x/").Handler(introspection.IgnoreCredentials(ok)) },
		"GET+POST route, none": func(r *mux.Router) {
			r.Handle("/x", guard.Require(introspection.None(), ok)).Methods(http.MethodGet, http.MethodPost)
		},
		"POST with an empty scope": func(r *mux.Router) { postRoute(r, "/x", guard.Require(introspection.Scope(""), ok)) },
		"undeclared inside a subrouter": func(r *mux.Router) {
			r.PathPrefix("/api").Subrouter().Handle("/x", ok).Methods(http.MethodPost)
		},
	}
	for name, register := range refused {
		t.Run(name, func(t *testing.T) {
			r := mux.NewRouter()
			register(r)
			if err := secureRouter(r); err == nil {
				t.Fatal("secureRouter accepted it")
			}
		})
	}

	accepted := map[string]func(r *mux.Router){
		"POST with a scope":   func(r *mux.Router) { postRoute(r, "/x", guard.Require(introspection.Scope("fleet:control"), ok)) },
		"POST with a session": func(r *mux.Router) { postRoute(r, "/x", guard.Require(introspection.Session(), ok)) },
		"GET declaring none":  func(r *mux.Router) { getRoute(r, "/x", guard.Require(introspection.None(), ok)) },
		"GET ignoring creds":  func(r *mux.Router) { getRoute(r, "/x", introspection.IgnoreCredentials(ok)) },
		"OPTIONS declaring none": func(r *mux.Router) {
			r.Methods(http.MethodOptions).Handler(guard.Require(introspection.None(), ok))
		},
	}
	for name, register := range accepted {
		t.Run(name, func(t *testing.T) {
			r := mux.NewRouter()
			register(r)
			if err := secureRouter(r); err != nil {
				t.Fatal(err)
			}
		})
	}

	t.Run("request time: an undeclared route added after the walk is a 500", func(t *testing.T) {
		center := newTestCenter(t)
		r := mux.NewRouter()
		getRoute(r, "/fine", guardFor(center.url).Require(introspection.None(), ok))
		if err := secureRouter(r); err != nil {
			t.Fatal(err)
		}
		ran := false
		sneaky := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { ran = true })
		r.Handle("/late", sneaky).Methods(http.MethodPost, http.MethodGet)

		for _, method := range []string{http.MethodPost, http.MethodGet} {
			for _, header := range []string{"", bearer()} {
				rec := doRequest(t, r, method, "/late", header)
				if rec.Code != http.StatusInternalServerError || decodeAuthError(t, rec) != introspection.MessageUndeclaredRoute {
					t.Errorf("%s with %q: got %d %s", method, header, rec.Code, rec.Body.String())
				}
			}
		}
		if ran {
			t.Error("the undeclared handler ran")
		}
		if center.Calls() != 0 {
			t.Errorf("center called %d times", center.Calls())
		}
	})
}

func TestSetUpRouterNeedsAGuard(t *testing.T) {
	if _, err := SetUpRouter(nil, nil, nil); err == nil {
		t.Fatal("SetUpRouter accepted a nil guard")
	}
}
