package introspection

// Conformance against meta/fixtures/introspection.json, vendored verbatim into
// testdata/ (provenance and sha256 in testdata/SOURCE.txt).
//
// Every one of the 37 calling-service cases is driven through the real
// middleware (Guard.Require) and the real HTTP client against a real
// httptest stub of the center that implements the case's `center` object:
// status, body, delayMs, notCalled, and transport "no-response" (a TCP
// listener that accepts and hangs up, so the call is still counted). Every
// `expect` key is asserted, and an unknown key in any part of a case fails the
// case rather than being skipped, so a copy that falls behind meta says so.
//
// The 11 st-gateway cases are a different policy (a lane, never a verdict)
// that agent-service does not implement. They are skipped by name, and their
// count is asserted, so a gateway case added in meta is noticed here too.

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	fixturePath = "testdata/introspection.json"
	// testSecret stands in for <AUTH_INTROSPECTION_SECRET> in the fixture.
	testSecret = "conformance-caller-secret-7f3a9c"
)

type fixtureFile struct {
	Version  int `json:"version"`
	Contract struct {
		Endpoint struct {
			Method       string `json:"method"`
			Path         string `json:"path"`
			ContentType  string `json:"contentType"`
			BodyTemplate string `json:"bodyTemplate"`
			SecretHeader string `json:"secretHeader"`
		} `json:"endpoint"`
		Env struct {
			URL    string `json:"url"`
			Secret string `json:"secret"`
		} `json:"env"`
		ClientTimeoutMs int               `json:"clientTimeoutMs"`
		Retries         int               `json:"retries"`
		ErrorEnvelope   string            `json:"errorEnvelope"`
		Messages        map[string]string `json:"messages"`
	} `json:"contract"`
	Cases        []map[string]json.RawMessage `json:"cases"`
	GatewayCases []map[string]json.RawMessage `json:"gatewayCases"`
}

func readFixture(t *testing.T) ([]byte, fixtureFile) {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(fixturePath))
	if err != nil {
		t.Fatalf("the vendored fixture is missing (see testdata/SOURCE.txt): %v", err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("the vendored fixture does not parse: %v", err)
	}
	if f.Version != 3 {
		t.Fatalf("vendored fixture is version %d; this test was written against version 3 — re-read it before re-copying", f.Version)
	}
	return raw, f
}

// TestVendoredFixtureIsTheExactCopyItClaimsToBe pins the copy twice: the
// sha256 recorded in SOURCE.txt (any byte, anywhere) and the sorted case names
// (the readable diff when meta adds, drops or renames a case).
func TestVendoredFixtureIsTheExactCopyItClaimsToBe(t *testing.T) {
	raw, f := readFixture(t)

	t.Run("sha256 matches SOURCE.txt", func(t *testing.T) {
		source, err := os.ReadFile(filepath.Join("testdata", "SOURCE.txt"))
		if err != nil {
			t.Fatal(err)
		}
		m := regexp.MustCompile(`(?m)^\s*sha256:\s*([0-9a-f]{64})\s*$`).FindSubmatch(source)
		if m == nil {
			t.Fatal("testdata/SOURCE.txt records no sha256")
		}
		want := string(m[1])
		if want != "77f845c89d4baabef7a336325a9e30360d908fd761ad450904c693621547dfa3" {
			t.Fatalf("SOURCE.txt records %s; this test was written against meta 9b62746 (77f845c8…)", want)
		}
		got := fmt.Sprintf("%x", sha256.Sum256(raw))
		if got != want {
			if bytes.Contains(raw, []byte("\r\n")) {
				t.Fatalf("fixture hashes to %s, SOURCE.txt records %s — the working copy has CRLF line endings; "+
					"the `-text` entry in .gitattributes is missing or the file was checked out before it was added", got, want)
			}
			t.Fatalf("fixture hashes to %s, SOURCE.txt records %s — testdata/introspection.json and meta have drifted; "+
				"re-copy it from meta and update BOTH the commit and the sha256 in SOURCE.txt", got, want)
		}
		if len(raw) != 49347 {
			t.Errorf("fixture is %d bytes, meta 9b62746's is 49347", len(raw))
		}
	})

	t.Run("case names", func(t *testing.T) {
		var got []string
		for _, c := range append(append([]map[string]json.RawMessage{}, f.Cases...), f.GatewayCases...) {
			var name string
			if err := json.Unmarshal(c["name"], &name); err != nil {
				t.Fatalf("a case has no name: %v", err)
			}
			got = append(got, name)
		}
		sort.Strings(got)
		want := []string{
			"active-machine-kind",
			"active-with-irregular-scope-whitespace",
			"active-with-multi-value-scope",
			"active-with-required-scope",
			"active-with-scope-differing-only-in-case",
			"active-with-scope-that-is-a-prefix-of-required",
			"active-without-required-scope",
			"bearer-with-empty-token",
			"bearer-with-internal-whitespace",
			"center-rejects-our-caller-secret",
			"center-returns-500",
			"center-returns-malformed-json",
			"center-times-out",
			"center-unreachable",
			"gateway-active-machine",
			"gateway-active-operator",
			"gateway-active-operator-lacking-scope-key",
			"gateway-bearer-with-empty-token",
			"gateway-center-rejects-our-caller-secret",
			"gateway-center-unreachable",
			"gateway-inactive-token",
			"gateway-kind-machine-with-user-subject",
			"gateway-kind-operator-with-machine-subject",
			"gateway-no-header",
			"gateway-non-bearer-scheme",
			"head-on-guarded-route-with-no-header",
			"head-on-guarded-route-with-valid-token",
			"head-on-public-get",
			"inactive-token-on-guarded-route",
			"inactive-token-on-public-get",
			"kind-disagrees-with-sub-prefix",
			"lowercase-bearer-scheme",
			"lowercase-route-method",
			"mutating-route-with-no-declared-scope",
			"mutating-route-with-no-declared-scope-and-inactive-token",
			"mutating-route-with-no-declared-scope-and-no-header",
			"no-header-on-guarded-route",
			"non-bearer-scheme-on-guarded-route",
			"operator-on-public-get",
			"options-on-guarded-route-with-no-header",
			"options-with-no-declared-scope",
			"scoped-route-with-token-lacking-scope-key",
			"session-route-with-inactive-token",
			"session-route-with-no-header",
			"session-route-with-scopeless-token",
			"session-route-with-token-lacking-scope-key",
			"token-on-public-get-while-center-is-down",
			"visitor-on-public-get",
		}
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Fatalf("case names differ from the ones this test was written against:\n got: %v\nwant: %v", got, want)
		}
	})
}

// TestFixtureContractMatchesTheCode pins every name and number three
// implementations agree on.
func TestFixtureContractMatchesTheCode(t *testing.T) {
	_, f := readFixture(t)
	c := f.Contract
	checks := []struct{ what, got, want string }{
		{"endpoint.method", c.Endpoint.Method, http.MethodPost},
		{"endpoint.contentType", c.Endpoint.ContentType, "application/x-www-form-urlencoded"},
		{"endpoint.bodyTemplate", c.Endpoint.BodyTemplate, "token=<jwt>"},
		{"endpoint.secretHeader", c.Endpoint.SecretHeader, SecretHeader},
		{"env.url", c.Env.URL, EnvURL},
		{"env.secret", c.Env.Secret, EnvSecret},
		{"clientTimeoutMs", fmt.Sprint(c.ClientTimeoutMs), fmt.Sprint(DefaultTimeout.Milliseconds())},
		{"retries", fmt.Sprint(c.Retries), "0"},
		{"messages.missingToken", c.Messages["missingToken"], MessageMissingToken},
		{"messages.invalidSession", c.Messages["invalidSession"], MessageInvalidSession},
		{"messages.missingScope", c.Messages["missingScope"], MessageMissingScope},
		{"messages.undeclaredRoute", c.Messages["undeclaredRoute"], MessageUndeclaredRoute},
		{"messages.centerUnavailable", c.Messages["centerUnavailable"], MessageCenterUnavailable},
	}
	for _, ch := range checks {
		if ch.got != ch.want {
			t.Errorf("fixture %s is %q, code uses %q", ch.what, ch.got, ch.want)
		}
	}
	if len(c.Messages) != 5 {
		t.Errorf("fixture has %d messages, this test knows 5", len(c.Messages))
	}
}

// --- one case -------------------------------------------------------------

type fixtureCase struct {
	Name  string
	Route struct {
		Method   string `json:"method"`
		Requires string `json:"requires"`
	}
	Authorization *string
	Center        struct {
		NotCalled bool   `json:"notCalled"`
		Status    int    `json:"status"`
		Body      string `json:"body"`
		DelayMs   int    `json:"delayMs"`
		Transport string `json:"transport"`
	}
	Expect map[string]json.RawMessage
}

// strictKeys fails when raw has a key outside allowed.
func strictKeys(t *testing.T, where string, raw json.RawMessage, allowed ...string) {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("%s is not an object: %v", where, err)
	}
	ok := map[string]bool{}
	for _, a := range allowed {
		ok[a] = true
	}
	for k := range m {
		if !ok[k] {
			t.Fatalf("%s has key %q, which this test does not know how to honour", where, k)
		}
	}
}

func decodeCase(t *testing.T, raw map[string]json.RawMessage) fixtureCase {
	t.Helper()
	for k := range raw {
		switch k {
		case "name", "why", "route", "request", "center", "expect":
		default:
			t.Fatalf("case has key %q, which this test does not know how to honour", k)
		}
	}
	var c fixtureCase
	mustUnmarshal(t, raw["name"], &c.Name)
	strictKeys(t, "route", raw["route"], "method", "requires")
	mustUnmarshal(t, raw["route"], &c.Route)
	strictKeys(t, "request", raw["request"], "authorization")
	var request struct {
		Authorization *string `json:"authorization"`
	}
	mustUnmarshal(t, raw["request"], &request)
	c.Authorization = request.Authorization
	strictKeys(t, "center", raw["center"], "notCalled", "status", "body", "delayMs", "transport")
	mustUnmarshal(t, raw["center"], &c.Center)
	if c.Center.Transport != "" && c.Center.Transport != "no-response" {
		t.Fatalf("center.transport %q is not one this test can stage", c.Center.Transport)
	}
	strictKeys(t, "expect", raw["expect"], "outcome", "identity", "centerCalls", "centerRequest",
		"status", "message", "messageMustNotContain", "maxElapsedMs")
	mustUnmarshal(t, raw["expect"], &c.Expect)
	return c
}

func mustUnmarshal(t *testing.T, raw json.RawMessage, v any) {
	t.Helper()
	if raw == nil {
		t.Fatalf("missing field (want %T)", v)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("decoding %s into %T: %v", raw, v, err)
	}
}

func requirementFor(t *testing.T, requires string) Requirement {
	t.Helper()
	switch requires {
	case "none":
		return None()
	case "session":
		return Session()
	case "":
		t.Fatal("route.requires is empty")
		return Requirement{}
	default:
		return Scope(requires)
	}
}

// --- the stub center ------------------------------------------------------

type recordedRequest struct {
	Method, Path, RawQuery, RequestURI, ContentType, Secret, Body string
	Header                                                        http.Header
}

type stubCenter struct {
	URL   string
	calls atomic.Int64
	mu    sync.Mutex
	reqs  []recordedRequest
}

func (s *stubCenter) Calls() int { return int(s.calls.Load()) }

func (s *stubCenter) Requests() []recordedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]recordedRequest(nil), s.reqs...)
}

// newStubCenter serves answer at path. Every request is counted and recorded,
// on any path, so a client that appends to the URL is both counted and seen.
func newStubCenter(t *testing.T, path string, answer func(w http.ResponseWriter, r *http.Request, body string)) *stubCenter {
	t.Helper()
	s := &stubCenter{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.calls.Add(1)
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.reqs = append(s.reqs, recordedRequest{
			Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, RequestURI: r.RequestURI,
			ContentType: r.Header.Get("Content-Type"), Secret: r.Header.Get(SecretHeader),
			Body: string(body), Header: r.Header.Clone(),
		})
		s.mu.Unlock()
		if r.URL.Path != path {
			http.NotFound(w, r)
			return
		}
		answer(w, r, string(body))
	}))
	t.Cleanup(server.Close)
	s.URL = server.URL + path
	return s
}

// newHangUpCenter accepts a connection, counts it, and closes it without a
// byte: the center "answered" nothing, and a retry would show as a second
// accept.
func newHangUpCenter(t *testing.T, path string) *stubCenter {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &stubCenter{URL: "http://" + ln.Addr().String() + path}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			s.calls.Add(1)
			conn.Close()
		}
	}()
	t.Cleanup(func() { ln.Close(); <-done })
	return s
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// --- driving a request through the middleware -----------------------------

type served struct {
	rec      *httptest.ResponseRecorder
	ran      bool
	identity *Identity
	elapsed  time.Duration
}

func serveThroughGuard(guard *Guard, req Requirement, method, authorization string, hasHeader bool) served {
	var out served
	handler := guard.Require(req, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out.ran = true
		out.identity = IdentityFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	r := httptest.NewRequest(method, "/route-under-test", nil)
	if hasHeader {
		r.Header.Set("Authorization", authorization)
	}
	out.rec = httptest.NewRecorder()
	start := time.Now()
	handler.ServeHTTP(out.rec, r)
	out.elapsed = time.Since(start)
	return out
}

// assertEnvelope checks the body is exactly {"error":{"message":…}} and
// returns the message.
func assertEnvelope(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type %q, want application/json", ct)
	}
	dec := json.NewDecoder(bytes.NewReader(rec.Body.Bytes()))
	dec.DisallowUnknownFields()
	var env struct {
		Error *struct {
			Message *string `json:"message"`
		} `json:"error"`
	}
	if err := dec.Decode(&env); err != nil {
		t.Fatalf("body %q is not the envelope: %v", rec.Body.String(), err)
	}
	if dec.More() {
		t.Fatalf("body %q has bytes after the envelope", rec.Body.String())
	}
	if env.Error == nil || env.Error.Message == nil {
		t.Fatalf("body %q lacks error.message", rec.Body.String())
	}
	return *env.Error.Message
}

func TestCallingServiceCases(t *testing.T) {
	_, f := readFixture(t)
	if len(f.Cases) != 37 {
		t.Fatalf("fixture has %d calling-service cases; this test was written against 37", len(f.Cases))
	}
	endpointPath := f.Contract.Endpoint.Path

	for _, raw := range f.Cases {
		raw := raw
		var name string
		_ = json.Unmarshal(raw["name"], &name)
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			c := decodeCase(t, raw)

			var center *stubCenter
			switch {
			case c.Center.Transport == "no-response":
				center = newHangUpCenter(t, endpointPath)
			case c.Center.NotCalled:
				center = newStubCenter(t, endpointPath, func(w http.ResponseWriter, _ *http.Request, _ string) {
					// Never expected to run; centerCalls 0 is asserted below.
					w.WriteHeader(http.StatusTeapot)
				})
			default:
				if c.Center.Status == 0 {
					t.Fatal("center has neither notCalled, transport nor a status")
				}
				center = newStubCenter(t, endpointPath, func(w http.ResponseWriter, r *http.Request, _ string) {
					if c.Center.DelayMs > 0 {
						select {
						case <-time.After(time.Duration(c.Center.DelayMs) * time.Millisecond):
						case <-r.Context().Done():
							return
						}
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(c.Center.Status)
					io.WriteString(w, c.Center.Body)
				})
			}

			logs := &syncBuffer{}
			logger := log.New(logs, "", 0)
			guard := NewGuard(NewClient(Config{URL: center.URL, Secret: testSecret}, logger), logger)

			authorization, hasHeader := "", c.Authorization != nil
			if hasHeader {
				authorization = *c.Authorization
			}
			out := serveThroughGuard(guard, requirementFor(t, c.Route.Requires), c.Route.Method, authorization, hasHeader)

			assertExpectations(t, c, out, center, endpointPath)

			// Nothing sensitive leaks, in any case.
			token := BearerFrom(authorization)
			for _, where := range []struct{ name, text string }{
				{"log", logs.String()},
				{"response body", out.rec.Body.String()},
			} {
				if strings.Contains(where.text, testSecret) {
					t.Errorf("the caller secret appears in the %s: %q", where.name, where.text)
				}
				if token != "" && strings.Contains(where.text, token) {
					t.Errorf("the token appears in the %s: %q", where.name, where.text)
				}
			}
		})
	}
}

func assertExpectations(t *testing.T, c fixtureCase, out served, center *stubCenter, endpointPath string) {
	t.Helper()
	var outcome string
	mustUnmarshal(t, c.Expect["outcome"], &outcome)
	var wantCalls int
	mustUnmarshal(t, c.Expect["centerCalls"], &wantCalls)

	switch outcome {
	case "proceed":
		for _, k := range []string{"status", "message", "messageMustNotContain"} {
			if _, has := c.Expect[k]; has {
				t.Fatalf("a proceed case asserts %q; this test does not know what that means", k)
			}
		}
		if !out.ran {
			t.Fatalf("handler did not run; answered %d %s", out.rec.Code, out.rec.Body.String())
		}
		if out.rec.Code != http.StatusOK {
			t.Errorf("status %d, want the handler's 200", out.rec.Code)
		}
		rawIdentity, has := c.Expect["identity"]
		if !has {
			t.Fatal("a proceed case must assert the identity")
		}
		if string(rawIdentity) == "null" {
			if out.identity != nil {
				t.Errorf("identity %+v, want a visitor (nil)", *out.identity)
			}
			break
		}
		var want struct {
			Sub    *string   `json:"sub"`
			Kind   *string   `json:"kind"`
			Scopes *[]string `json:"scopes"`
		}
		strictKeys(t, "expect.identity", rawIdentity, "sub", "kind", "scopes")
		mustUnmarshal(t, rawIdentity, &want)
		if want.Sub == nil || want.Kind == nil || want.Scopes == nil {
			t.Fatal("expect.identity must carry sub, kind and scopes")
		}
		if out.identity == nil {
			t.Fatal("handler received no identity")
		}
		if out.identity.Sub != *want.Sub || string(out.identity.Kind) != *want.Kind {
			t.Errorf("identity {%s %s}, want {%s %s}", out.identity.Sub, out.identity.Kind, *want.Sub, *want.Kind)
		}
		if out.identity.Scopes == nil {
			t.Error("scopes is nil; the identity must carry a list, empty when there are none")
		}
		if strings.Join(out.identity.Scopes, "\x00") != strings.Join(*want.Scopes, "\x00") ||
			len(out.identity.Scopes) != len(*want.Scopes) {
			t.Errorf("scopes %q, want %q", out.identity.Scopes, *want.Scopes)
		}

	case "reject":
		if _, has := c.Expect["identity"]; has {
			t.Fatal("a reject case asserts an identity; this test does not know what that means")
		}
		if out.ran {
			t.Fatal("handler ran on a rejected request")
		}
		var wantStatus int
		mustUnmarshal(t, c.Expect["status"], &wantStatus)
		if out.rec.Code != wantStatus {
			t.Errorf("status %d, want %d", out.rec.Code, wantStatus)
		}
		var wantMessage string
		mustUnmarshal(t, c.Expect["message"], &wantMessage)
		got := assertEnvelope(t, out.rec)
		if got != wantMessage {
			t.Errorf("message %q, want %q", got, wantMessage)
		}
		if raw, has := c.Expect["messageMustNotContain"]; has {
			var forbidden []string
			mustUnmarshal(t, raw, &forbidden)
			if len(forbidden) == 0 {
				t.Fatal("messageMustNotContain is empty")
			}
			for _, s := range forbidden {
				if strings.Contains(out.rec.Body.String(), s) {
					t.Errorf("body %q contains %q", out.rec.Body.String(), s)
				}
			}
		}

	default:
		t.Fatalf("unknown outcome %q", outcome)
	}

	if got := center.Calls(); got != wantCalls {
		t.Errorf("center called %d times, want %d", got, wantCalls)
	}

	if raw, has := c.Expect["maxElapsedMs"]; has {
		var ms int
		mustUnmarshal(t, raw, &ms)
		if out.elapsed > time.Duration(ms)*time.Millisecond {
			t.Errorf("took %v, want at most %dms", out.elapsed, ms)
		}
	}

	// What was sent, for every case that reached an HTTP center. The one case
	// carrying expect.centerRequest pins it from the fixture; the rest must
	// agree with the contract all the same.
	token := ""
	if c.Authorization != nil {
		token = BearerFrom(*c.Authorization)
	}
	for _, r := range center.Requests() {
		assertSentRequest(t, r, token, endpointPath)
	}
	if raw, has := c.Expect["centerRequest"]; has {
		strictKeys(t, "expect.centerRequest", raw, "method", "path", "contentType", "body", "headers")
		var want struct {
			Method      string            `json:"method"`
			Path        string            `json:"path"`
			ContentType string            `json:"contentType"`
			Body        string            `json:"body"`
			Headers     map[string]string `json:"headers"`
		}
		mustUnmarshal(t, raw, &want)
		reqs := center.Requests()
		if len(reqs) != 1 {
			t.Fatalf("centerRequest asserted, but the center recorded %d requests", len(reqs))
		}
		r := reqs[0]
		if r.Method != want.Method || r.Path != want.Path || r.ContentType != want.ContentType || r.Body != want.Body {
			t.Errorf("sent %s %s (%s) %q, want %s %s (%s) %q",
				r.Method, r.Path, r.ContentType, r.Body, want.Method, want.Path, want.ContentType, want.Body)
		}
		if len(want.Headers) == 0 {
			t.Fatal("centerRequest.headers is empty")
		}
		for name, value := range want.Headers {
			if value == "<AUTH_INTROSPECTION_SECRET>" {
				value = testSecret
			}
			if got := r.Header.Get(name); got != value {
				t.Errorf("header %s is %q, want %q", name, got, value)
			}
		}
	}
}

func assertSentRequest(t *testing.T, r recordedRequest, token, endpointPath string) {
	t.Helper()
	if r.Method != http.MethodPost {
		t.Errorf("center request method %s, want POST", r.Method)
	}
	if r.Path != endpointPath || r.RawQuery != "" {
		t.Errorf("center request went to %q, want %q with no query", r.RequestURI, endpointPath)
	}
	if r.ContentType != "application/x-www-form-urlencoded" {
		t.Errorf("center request Content-Type %q", r.ContentType)
	}
	if r.Secret != testSecret {
		t.Errorf("center request carried secret %q, want the configured one", r.Secret)
	}
	if token == "" {
		t.Error("the center was called for a request that carried no bearer token")
		return
	}
	if want := "token=" + url.QueryEscape(token); r.Body != want {
		t.Errorf("center request body %q, want %q", r.Body, want)
	}
	if strings.Contains(r.RequestURI, token) {
		t.Errorf("the token is in the URL %q", r.RequestURI)
	}
}

// TestGatewayCasesAreNotThisServicesPolicy skips st-gateway's group by name.
// The count is the assertion: a gateway case added in meta fails here, so
// someone decides whether it is really gateway-only.
func TestGatewayCasesAreNotThisServicesPolicy(t *testing.T) {
	_, f := readFixture(t)
	if len(f.GatewayCases) != 11 {
		t.Fatalf("fixture has %d gateway cases; this test was written against 11 — re-read the fixture", len(f.GatewayCases))
	}
	for _, raw := range f.GatewayCases {
		var name string
		mustUnmarshal(t, raw["name"], &name)
		t.Run(name, func(t *testing.T) {
			t.Skip("st-gateway lane policy (a lane, never a verdict); agent-service is a calling service")
		})
	}
}
