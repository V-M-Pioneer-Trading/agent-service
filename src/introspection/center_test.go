package introspection

// Local additions the fixture cannot express: startup config, what the client
// refuses to do on the wire (follow a redirect, read an unbounded body, use a
// proxy, take the URL apart), what never reaches a log, concurrency, and the
// shapes of a center answer that are not the contract.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const activeOperator = `{"active":true,"sub":"user_1","scope":"fleet:control","exp":4102444800,"kind":"operator"}`

func answerWith(status int, body string) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, _ *http.Request, _ string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, body)
	}
}

func guardFor(center *stubCenter, logs io.Writer) *Guard {
	logger := log.New(logs, "", 0)
	return NewGuard(NewClient(Config{URL: center.URL, Secret: testSecret}, logger), logger)
}

func TestLoadConfig(t *testing.T) {
	const secret = "s3cr3t-value-that-must-never-be-echoed"
	env := func(vars map[string]string) func(string) string {
		return func(k string) string { return vars[k] }
	}

	t.Run("valid config is returned verbatim", func(t *testing.T) {
		cfg, err := LoadConfig(env(map[string]string{
			EnvURL: "http://localhost:3005/auth/v1/introspect", EnvSecret: secret,
		}))
		if err != nil {
			t.Fatal(err)
		}
		if cfg.URL != "http://localhost:3005/auth/v1/introspect" || cfg.Secret != secret {
			t.Errorf("got %+v", cfg)
		}
	})

	cases := []struct {
		name, url, secret, mustName string
	}{
		{"url missing", "", secret, EnvURL},
		{"url blank", "   ", secret, EnvURL},
		{"secret missing", "http://localhost:3005/auth/v1/introspect", "", EnvSecret},
		{"secret blank", "http://localhost:3005/auth/v1/introspect", "  ", EnvSecret},
		{"secret with surrounding whitespace", "http://localhost:3005/auth/v1/introspect", secret + " ", EnvSecret},
		{"secret with a newline", "http://localhost:3005/auth/v1/introspect", secret + "\nX", EnvSecret},
		{"relative url", "/auth/v1/introspect", secret, EnvURL},
		{"ftp url", "ftp://localhost/auth/v1/introspect", secret, EnvURL},
		{"file url", "file:///etc/passwd", secret, EnvURL},
		{"schemeless host", "localhost:3005/auth/v1/introspect", secret, EnvURL},
		{"url carrying the secret as userinfo", "http://svc:" + secret + "@localhost:3005/auth/v1/introspect", secret, EnvURL},
		{"url with a query", "http://localhost:3005/auth/v1/introspect?secret=" + secret, secret, EnvURL},
		{"url with a fragment", "http://localhost:3005/auth/v1/introspect#" + secret, secret, EnvURL},
		{"unparseable url", "http://[::1/auth", secret, EnvURL},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := LoadConfig(env(map[string]string{EnvURL: c.url, EnvSecret: c.secret}))
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), c.mustName) {
				t.Errorf("error %q does not name %s", err, c.mustName)
			}
			if strings.Contains(err.Error(), secret) {
				t.Errorf("error %q echoes the secret", err)
			}
		})
	}
}

// Every failure path logs, and none of those lines — nor the answer the
// caller gets — may carry the token or the secret.
func TestTokenAndSecretNeverReachLogsOrErrors(t *testing.T) {
	const token = "tok3n-that-must-never-be-logged.abc.def"
	slow := func(w http.ResponseWriter, r *http.Request, _ string) {
		select {
		case <-time.After(3 * time.Second):
		case <-r.Context().Done():
		}
	}
	scenarios := map[string]func(t *testing.T) *stubCenter{
		"unreachable": func(t *testing.T) *stubCenter { return closedPortCenter(t) },
		"hang-up":     func(t *testing.T) *stubCenter { return newHangUpCenter(t, "/auth/v1/introspect") },
		"500 echoing the request": func(t *testing.T) *stubCenter {
			return newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, _ *http.Request, body string) {
				w.WriteHeader(500)
				io.WriteString(w, "echo: "+body)
			})
		},
		"401": func(t *testing.T) *stubCenter {
			return newStubCenter(t, "/auth/v1/introspect", answerWith(401, `{"error":{"message":"a valid introspection secret is required"}}`))
		},
		"malformed echoing the request": func(t *testing.T) *stubCenter {
			return newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, _ *http.Request, body string) {
				io.WriteString(w, "<html>"+body+"</html>")
			})
		},
		"timeout": func(t *testing.T) *stubCenter { return newStubCenter(t, "/auth/v1/introspect", slow) },
		"redirect": func(t *testing.T) *stubCenter {
			return newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, r *http.Request, _ string) {
				http.Redirect(w, r, "http://127.0.0.1:1/elsewhere", http.StatusTemporaryRedirect)
			})
		},
		"oversized": func(t *testing.T) *stubCenter {
			return newStubCenter(t, "/auth/v1/introspect", answerWith(200, strings.Repeat(" ", MaxResponseBytes)+activeOperator))
		},
	}
	for name, build := range scenarios {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			logs := &syncBuffer{}
			out := serveThroughGuard(guardFor(build(t), logs), Scope("fleet:control"), http.MethodPost, "Bearer "+token, true)
			if out.rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status %d, want 503", out.rec.Code)
			}
			if logs.String() == "" {
				t.Error("a failed introspection logged nothing")
			}
			for _, where := range []string{logs.String(), out.rec.Body.String()} {
				if strings.Contains(where, token) || strings.Contains(where, testSecret) {
					t.Errorf("leaked: %q", where)
				}
			}
		})
	}
}

func closedPortCenter(t *testing.T) *stubCenter {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return &stubCenter{URL: "http://" + addr + "/auth/v1/introspect"}
}

func TestClosedPortIsA503Quickly(t *testing.T) {
	out := serveThroughGuard(guardFor(closedPortCenter(t), io.Discard), Session(), http.MethodGet, "Bearer abc", true)
	if out.rec.Code != http.StatusServiceUnavailable || assertEnvelope(t, out.rec) != MessageCenterUnavailable {
		t.Fatalf("got %d %s", out.rec.Code, out.rec.Body.String())
	}
	if out.elapsed > 2*time.Second {
		t.Errorf("took %v", out.elapsed)
	}
}

func TestRedirectIsNotFollowed(t *testing.T) {
	target := newStubCenter(t, "/auth/v1/introspect", answerWith(200, activeOperator))
	center := newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, r *http.Request, _ string) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
	if out.rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", out.rec.Code)
	}
	if target.Calls() != 0 {
		t.Errorf("the redirect was followed: target called %d times (with our secret)", target.Calls())
	}
	if center.Calls() != 1 {
		t.Errorf("center called %d times, want 1", center.Calls())
	}
}

func TestResponseBodyIsBounded(t *testing.T) {
	t.Run("one byte over the cap is a 503", func(t *testing.T) {
		body := activeOperator + strings.Repeat(" ", MaxResponseBytes-len(activeOperator)+1)
		center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, body))
		out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
		if out.rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status %d, want 503", out.rec.Code)
		}
	})
	t.Run("exactly the cap is read", func(t *testing.T) {
		body := activeOperator + strings.Repeat(" ", MaxResponseBytes-len(activeOperator))
		center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, body))
		out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
		if !out.ran {
			t.Fatalf("status %d, want the handler to run", out.rec.Code)
		}
	})
	t.Run("an endless body is cut off, not buffered", func(t *testing.T) {
		center := newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, r *http.Request, _ string) {
			chunk := []byte(strings.Repeat(" ", 4096))
			for r.Context().Err() == nil {
				if _, err := w.Write(chunk); err != nil {
					return
				}
			}
		})
		out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
		if out.rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status %d, want 503", out.rec.Code)
		}
		if out.elapsed > 2*time.Second {
			t.Errorf("took %v", out.elapsed)
		}
	})
}

func TestURLIsUsedVerbatim(t *testing.T) {
	// A path nobody would guess, so a client that builds its own is caught.
	center := newStubCenter(t, "/some/unusual/introspection-endpoint", answerWith(200, activeOperator))
	out := serveThroughGuard(guardFor(center, io.Discard), Session(), http.MethodGet, "Bearer abc", true)
	if !out.ran {
		t.Fatalf("status %d %s", out.rec.Code, out.rec.Body.String())
	}
	reqs := center.Requests()
	if len(reqs) != 1 || reqs[0].Path != "/some/unusual/introspection-endpoint" {
		t.Fatalf("requests %+v", reqs)
	}
}

func TestTransportUsesNoProxy(t *testing.T) {
	c := NewClient(Config{URL: "http://127.0.0.1:1/x", Secret: testSecret}, log.New(io.Discard, "", 0))
	if c.http.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("the introspection transport consults HTTP_PROXY; the token and secret must go only to the configured endpoint")
	}
	if c.http.Timeout != time.Second {
		t.Errorf("timeout %v, want the contract's 1s", c.http.Timeout)
	}
}

func TestAnswersThatAreNotTheContract(t *testing.T) {
	cases := map[string]string{
		"active as a string":                `{"active":"true","sub":"user_1","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"active as a number":                `{"active":1,"sub":"user_1","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"active missing":                    `{"sub":"user_1","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"active null":                       `{"active":null}`,
		"partial active":                    `{"active":true}`,
		"no sub":                            `{"active":true,"scope":"fleet:control","exp":1,"kind":"operator"}`,
		"empty sub":                         `{"active":true,"sub":"","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"no kind":                           `{"active":true,"sub":"user_1","scope":"fleet:control","exp":1}`,
		"unknown kind":                      `{"active":true,"sub":"user_1","scope":"fleet:control","exp":1,"kind":"robot"}`,
		"kind in another case":              `{"active":true,"sub":"user_1","scope":"fleet:control","exp":1,"kind":"Operator"}`,
		"no exp":                            `{"active":true,"sub":"user_1","scope":"fleet:control","kind":"operator"}`,
		"exp as a string":                   `{"active":true,"sub":"user_1","scope":"fleet:control","exp":"soon","kind":"operator"}`,
		"scope as an array":                 `{"active":true,"sub":"user_1","scope":["fleet:control"],"exp":1,"kind":"operator"}`,
		"top-level array":                   `[{"active":true}]`,
		"top-level null":                    `null`,
		"trailing garbage":                  activeOperator + `x`,
		"two objects":                       activeOperator + activeOperator,
		"empty body":                        ``,
		"html":                              `<html>ok</html>`,
		"inactive but a string":             `"inactive"`,
		"active in another case, last wins": `{"active":false,"Active":true,"sub":"user_1","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"active in another case, first":     `{"Active":true,"active":false}`,
		"scope in another case, last wins":  `{"active":true,"sub":"user_1","scope":"x","Scope":"fleet:control","exp":1,"kind":"operator"}`,
		"all keys uppercase":                `{"ACTIVE":true,"SUB":"user_1","SCOPE":"fleet:control","EXP":1,"KIND":"operator"}`,
		"inactive, uppercase":               `{"ACTIVE":false}`,
		"one key in another case":           `{"active":true,"sub":"user_1","scope":"fleet:control","exp":1,"Kind":"operator"}`,
		"active repeated exactly":           `{"active":false,"active":true,"sub":"user_1","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"scope repeated exactly":            `{"active":true,"sub":"user_1","scope":"x","scope":"fleet:control","exp":1,"kind":"operator"}`,
		"scope only in another case":        `{"active":true,"sub":"user_1","SCOPE":"fleet:control","exp":1,"kind":"operator"}`,
		"scope null":                        `{"active":true,"sub":"user_1","scope":null,"exp":1,"kind":"operator"}`,
		"scope a number":                    `{"active":true,"sub":"user_1","scope":1,"exp":1,"kind":"operator"}`,
		"scope an object":                   `{"active":true,"sub":"user_1","scope":{},"exp":1,"kind":"operator"}`,
		"sub null":                          `{"active":true,"sub":null,"scope":"fleet:control","exp":1,"kind":"operator"}`,
		"exp null":                          `{"active":true,"sub":"user_1","scope":"fleet:control","exp":null,"kind":"operator"}`,
		"kind null":                         `{"active":true,"sub":"user_1","scope":"fleet:control","exp":1,"kind":null}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, body))
			out := serveThroughGuard(guardFor(center, io.Discard), Session(), http.MethodGet, "Bearer abc", true)
			if out.rec.Code != http.StatusServiceUnavailable || assertEnvelope(t, out.rec) != MessageCenterUnavailable {
				t.Fatalf("got %d %s, want 503", out.rec.Code, out.rec.Body.String())
			}
		})
	}

	t.Run("every non-2xx status is a 503", func(t *testing.T) {
		for _, status := range []int{204, 301, 302, 304, 400, 401, 403, 404, 429, 500, 502, 503} {
			center := newStubCenter(t, "/auth/v1/introspect", answerWith(status, activeOperator))
			out := serveThroughGuard(guardFor(center, io.Discard), Session(), http.MethodGet, "Bearer abc", true)
			if status == 204 {
				// A 2xx with no body is not the contract either.
				if out.rec.Code != http.StatusServiceUnavailable {
					t.Errorf("204: got %d, want 503", out.rec.Code)
				}
				continue
			}
			if out.rec.Code != http.StatusServiceUnavailable {
				t.Errorf("center %d: got %d, want 503", status, out.rec.Code)
			}
		}
	})
}

// auth-service encodes `scope` with omitempty, so a session carrying no
// scopes arrives with no `scope` key at all. That is the empty list, not a
// malformed answer — otherwise the session tier would 503 for a real guest.
func TestAbsentScopeIsTheEmptyList(t *testing.T) {
	center := newStubCenter(t, "/auth/v1/introspect",
		answerWith(200, `{"active":true,"sub":"user_guest","exp":4102444800,"kind":"operator"}`))
	out := serveThroughGuard(guardFor(center, io.Discard), Session(), http.MethodGet, "Bearer abc", true)
	if !out.ran || out.identity == nil {
		t.Fatalf("got %d %s", out.rec.Code, out.rec.Body.String())
	}
	if out.identity.Scopes == nil || len(out.identity.Scopes) != 0 {
		t.Errorf("scopes %#v, want an empty list", out.identity.Scopes)
	}
	out = serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
	if out.rec.Code != http.StatusForbidden {
		t.Errorf("scoped route: got %d, want 403", out.rec.Code)
	}
}

func TestBearerVariants(t *testing.T) {
	cases := []struct {
		header string
		token  string // "" means no credential
	}{
		{"Bearer abc", "abc"},
		{"bearer abc", "abc"},
		{"BEARER abc", "abc"},
		{"BeArEr abc", "abc"},
		{"  Bearer   abc  ", "abc"},
		{"Bearer\tabc", "abc"},
		{"Bearer", ""},
		{"Bearer ", ""},
		{"Bearer    ", ""},
		{"Bearer abc def", ""},
		{"Bearer a, Bearer b", ""},
		{"Basic abc", ""},
		{"Token abc", ""},
		{"Bearerabc", ""},
		{"abc", ""},
		{"", ""},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%q", c.header), func(t *testing.T) {
			if got := BearerFrom(c.header); got != c.token {
				t.Fatalf("BearerFrom(%q) = %q, want %q", c.header, got, c.token)
			}
			center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, activeOperator))
			out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, c.header, true)
			if c.token == "" {
				if out.rec.Code != http.StatusUnauthorized || assertEnvelope(t, out.rec) != MessageMissingToken || center.Calls() != 0 {
					t.Errorf("got %d %s with %d center calls; want 401 missing token, no call",
						out.rec.Code, out.rec.Body.String(), center.Calls())
				}
				return
			}
			if !out.ran || center.Calls() != 1 {
				t.Fatalf("got %d with %d calls", out.rec.Code, center.Calls())
			}
			if body := center.Requests()[0].Body; body != "token="+c.token {
				t.Errorf("sent %q", body)
			}
		})
	}

	// Two Authorization lines are never a credential, whatever they hold. The
	// count decides: a second empty line must not fold into "Bearer a, " and
	// become the token "a,", and two full lines must not let the caller pick
	// which one is verified. Sent as raw bytes so the wire carries exactly the
	// lines under test; a Go client may drop an empty header value.
	for _, c := range []struct{ name, second string }{
		{"two Authorization lines, second empty", ""},
		{"two Authorization lines, both non-empty", "Bearer b"},
	} {
		t.Run(c.name, func(t *testing.T) {
			center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, activeOperator))
			guard := guardFor(center, io.Discard)
			handler := guard.Require(Scope("fleet:control"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("handler ran")
			}))
			srv := httptest.NewServer(handler)
			defer srv.Close()
			status, body := sendRaw(t, srv, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n"+
				"Authorization: Bearer a\r\nAuthorization: "+c.second+"\r\n\r\n")
			if status != http.StatusUnauthorized {
				t.Errorf("status %d, want 401", status)
			}
			if !strings.Contains(body, MessageMissingToken) {
				t.Errorf("body %q, want %q", body, MessageMissingToken)
			}
			if center.Calls() != 0 {
				t.Errorf("center called %d times, want 0", center.Calls())
			}
		})
	}
}

// sendRaw writes one HTTP/1.1 request verbatim to srv and returns the status
// code and body of the reply.
func sendRaw(t *testing.T, srv *httptest.Server, raw string) (int, string) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, raw); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(body)
}

func TestConcurrentRequestsGetTheirOwnIdentity(t *testing.T) {
	center := newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, r *http.Request, body string) {
		token := strings.TrimPrefix(body, "token=")
		// Jitter so answers come back out of order.
		time.Sleep(time.Duration(len(token)%7) * time.Millisecond)
		fmt.Fprintf(w, `{"active":true,"sub":"user_%s","scope":"fleet:control","exp":4102444800,"kind":"operator"}`, token)
	})
	guard := guardFor(center, io.Discard)

	const n = 64
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			token := fmt.Sprintf("t%d", i)
			out := serveThroughGuard(guard, Scope("fleet:control"), http.MethodPost, "Bearer "+token, true)
			if !out.ran || out.identity == nil || out.identity.Sub != "user_"+token {
				errs <- fmt.Errorf("request %d: status %d identity %+v", i, out.rec.Code, out.identity)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if center.Calls() != n {
		t.Errorf("center called %d times for %d requests (no cache, no dedup, no retry)", center.Calls(), n)
	}
}

func TestIgnoreCredentialsNeverAsksTheCenter(t *testing.T) {
	for _, center := range []*stubCenter{
		newStubCenter(t, "/auth/v1/introspect", answerWith(200, `{"active":false}`)),
		closedPortCenter(t),
	} {
		guard := guardFor(center, io.Discard)
		_ = guard // the point: IgnoreCredentials takes no guard at all
		ran := false
		h := IgnoreCredentials(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ran = true
			if IdentityFrom(r.Context()) != nil {
				t.Error("an ignoring route received an identity")
			}
		}))
		for _, header := range []string{"", "Bearer garbage", "Bearer abc def", "Basic x"} {
			ran = false
			r := httptest.NewRequest(http.MethodGet, "/health", nil)
			if header != "" {
				r.Header.Set("Authorization", header)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if !ran || rec.Code != http.StatusOK {
				t.Errorf("%q: ran=%v status %d", header, ran, rec.Code)
			}
		}
		if center.Calls() != 0 {
			t.Errorf("center called %d times", center.Calls())
		}
	}
	d, ok := DeclarationOf(IgnoreCredentials(http.NotFoundHandler()))
	if !ok || !d.IgnoresCredentials {
		t.Error("IgnoreCredentials does not carry its declaration")
	}
}

func TestUndeclaredRequirementIsNeverServed(t *testing.T) {
	center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, activeOperator))
	guard := guardFor(center, io.Discard)
	for _, req := range []Requirement{{}, Scope("")} {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodPost, http.MethodDelete} {
			out := serveThroughGuard(guard, req, method, "Bearer abc", true)
			if out.ran || out.rec.Code != http.StatusInternalServerError {
				t.Errorf("%s on %s: ran=%v status %d", method, req, out.ran, out.rec.Code)
			}
		}
	}
	if center.Calls() != 0 {
		t.Errorf("center called %d times", center.Calls())
	}
}

func TestEveryMutatingMethodIsSubjectToDefaultDeny(t *testing.T) {
	center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, activeOperator))
	guard := guardFor(center, io.Discard)
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "put", "Delete", "PROPFIND"} {
		out := serveThroughGuard(guard, None(), method, "", false)
		if out.ran || out.rec.Code != http.StatusInternalServerError {
			t.Errorf("%s: ran=%v status %d", method, out.ran, out.rec.Code)
		}
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS", "get", "head", "options"} {
		out := serveThroughGuard(guard, None(), method, "", false)
		if !out.ran {
			t.Errorf("%s: status %d, want a visitor", method, out.rec.Code)
		}
	}
	if center.Calls() != 0 {
		t.Errorf("center called %d times", center.Calls())
	}
}

func TestCallerCancellationIsNotRetried(t *testing.T) {
	center := newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, r *http.Request, _ string) {
		<-r.Context().Done()
	})
	c := NewClient(Config{URL: center.URL, Secret: testSecret}, log.New(io.Discard, "", 0))
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if got := c.Introspect(ctx, "abc"); got.State != StateUnavailable {
		t.Fatalf("state %v", got.State)
	}
	if center.Calls() != 1 {
		t.Errorf("center called %d times", center.Calls())
	}
}

// Go's struct binding would have folded case and let the last duplicate win,
// so an answer like {"active":false,"Active":true} was an active session.
// Pinned at the parser too, where the reason is visible.
func TestParseAnswerTakesOnlyExactKeysOnce(t *testing.T) {
	for _, body := range []string{
		`{"active":false,"Active":true,"sub":"user_1","scope":"fleet:control","exp":1,"kind":"operator"}`,
		`{"active":true,"sub":"user_1","scope":"x","Scope":"fleet:control","exp":1,"kind":"operator"}`,
		`{"ACTIVE":true,"SUB":"user_1","SCOPE":"fleet:control","EXP":1,"KIND":"operator"}`,
		`{"active":true,"sub":"user_1","scope":null,"exp":1,"kind":"operator"}`,
		// The only case-variant that is neither a duplicate nor a missing
		// required key: read as absent, it would be a scope-less session.
		`{"active":true,"sub":"user_1","Scope":"fleet:control","exp":1,"kind":"operator"}`,
		`{"active":true,"active":true,"sub":"user_1","exp":1,"kind":"operator"}`,
	} {
		if a, err := parseAnswer([]byte(body)); err == nil || a.State != StateUnavailable {
			t.Errorf("%s: state %v err %v, want unavailable", body, a.State, err)
		}
	}
	// Unknown keys, in any case, are still ignored.
	a, err := parseAnswer([]byte(`{"active":true,"sub":"user_1","exp":1,"kind":"operator","client_id":"x","Client_ID":1}`))
	if err == nil {
		t.Errorf("an unknown key repeated in another case was accepted: %+v", a)
	}
	a, err = parseAnswer([]byte(`{"active":true,"sub":"user_1","exp":1,"kind":"operator","Iss":"x"}`))
	if err != nil || a.State != StateActive {
		t.Errorf("an unknown key made the answer unusable: %v", err)
	}
}

func TestScopeIsSplitOnASCIIWhitespaceOnly(t *testing.T) {
	cases := map[string][]string{
		"a fleet:control":             {"a", "fleet:control"},
		" \ta\t\tfleet:control\r\nb ": {"a", "fleet:control", "b"},
		"fleet:control other":         {"fleet:control other"},
		"fleet:control other":         {"fleet:control other"},
		"fleet:control\u0085other":    {"fleet:control\u0085other"},
		"fleet:control\vother":        {"fleet:control\vother"},
		"":                            {},
		" \t\r\n":                     {},
	}
	for scope, want := range cases {
		body, _ := json.Marshal(map[string]any{"active": true, "sub": "user_1", "exp": 1, "kind": "operator", "scope": scope})
		a, err := parseAnswer(body)
		if err != nil || a.State != StateActive {
			t.Fatalf("%q: %v", scope, err)
		}
		if a.Identity.Scopes == nil || !reflect.DeepEqual(a.Identity.Scopes, want) {
			t.Errorf("%q: scopes %#v, want %#v", scope, a.Identity.Scopes, want)
		}
	}
	// End to end: a Unicode space does not split out fleet:control.
	center := newStubCenter(t, "/auth/v1/introspect",
		answerWith(200, `{"active":true,"sub":"user_1","scope":"fleet:control x","exp":4102444800,"kind":"operator"}`))
	out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
	if out.ran || out.rec.Code != http.StatusForbidden {
		t.Errorf("got %d, want 403", out.rec.Code)
	}
}

// A center that answers a large body QUICKLY: the elapsed-time test above
// cannot tell a capped read from io.ReadAll here, so count what the center
// managed to hand over before the client hung up.
func TestLargeFastBodyIsNotReadPastTheCap(t *testing.T) {
	const total = 32 << 20
	var written atomic.Int64
	done := make(chan struct{})
	center := newStubCenter(t, "/auth/v1/introspect", func(w http.ResponseWriter, _ *http.Request, _ string) {
		defer close(done)
		w.Header().Set("Content-Length", strconv.Itoa(total))
		w.WriteHeader(200)
		chunk := []byte(strings.Repeat(" ", 32<<10))
		for written.Load() < total {
			n, err := w.Write(chunk)
			written.Add(int64(n))
			if err != nil {
				return
			}
		}
	})
	out := serveThroughGuard(guardFor(center, io.Discard), Scope("fleet:control"), http.MethodPost, "Bearer abc", true)
	if out.rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d, want 503", out.rec.Code)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the center is still writing: the client neither read nor hung up")
	}
	t.Logf("center wrote %d of %d bytes", written.Load(), total)
	if got := written.Load(); got >= total {
		t.Fatalf("the center delivered all %d bytes: the client read past the %d-byte cap", got, MaxResponseBytes)
	}
}

// The token is opaque: every byte of it must reach the center, form-encoded,
// so that & or = cannot add a field and + cannot turn into a space.
func TestTokenIsFormEncodedVerbatim(t *testing.T) {
	const token = "a+b/c=d&token=evil&e%41f g\r\nh"
	center := newStubCenter(t, "/auth/v1/introspect", answerWith(200, activeOperator))
	c := NewClient(Config{URL: center.URL, Secret: testSecret}, log.New(io.Discard, "", 0))
	if a := c.Introspect(context.Background(), token); a.State != StateActive {
		t.Fatalf("state %v", a.State)
	}
	reqs := center.Requests()
	if len(reqs) != 1 {
		t.Fatalf("%d requests", len(reqs))
	}
	const wantBody = "token=a%2Bb%2Fc%3Dd%26token%3Devil%26e%2541f+g%0D%0Ah"
	if reqs[0].Body != wantBody {
		t.Errorf("body %q, want %q", reqs[0].Body, wantBody)
	}
	form, err := url.ParseQuery(reqs[0].Body)
	if err != nil || len(form) != 1 || len(form["token"]) != 1 || form.Get("token") != token {
		t.Errorf("center decoded %#v (err %v), want exactly the token", form, err)
	}
	if reqs[0].ContentType != "application/x-www-form-urlencoded" {
		t.Errorf("content type %q", reqs[0].ContentType)
	}
}

// The startup walk refuses a mutating route that ignores credentials, but mux
// accepts routes after it. The handler itself refuses.
func TestIgnoreCredentialsRefusesMutatingMethods(t *testing.T) {
	ran := false
	h := IgnoreCredentials(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { ran = true }))
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, "CONNECT", "TRACE", "PROPFIND"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/health", nil))
		if rec.Code != http.StatusInternalServerError || assertEnvelope(t, rec) != MessageUndeclaredRoute {
			t.Errorf("%s: got %d %s", method, rec.Code, rec.Body.String())
		}
	}
	if ran {
		t.Error("the ignoring handler ran for a mutating method")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodOptions, "get"} {
		ran = false
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(method, "/health", nil))
		if !ran {
			t.Errorf("%s: not served (%d)", method, rec.Code)
		}
	}
}
