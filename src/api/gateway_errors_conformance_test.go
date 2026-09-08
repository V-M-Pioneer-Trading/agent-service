package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vnm/agent-info-service/spacetraders"
)

// The shared upstream-error contract, driven from the vendored fixtures.
//
// Every service that calls SpaceTraders through st-gateway must answer these
// conditions identically — see meta/docs/design/upstream-errors.md. The cases live
// in ../spacetraders/testdata/gateway-errors.json, a verbatim copy of
// meta/fixtures/gateway-errors.json; change meta first, then re-copy.
//
// Driven through the router rather than through the client, because the contract
// is about what a caller receives. A 2xx body this service cannot decode never
// becomes an *UpstreamError at all — it is the handler that turns it into the 502
// the contract asks for, and a client-level test would have to restate that
// mapping to check it.

type conformanceCase struct {
	Name    string `json:"name"`
	Why     string `json:"why"`
	Gateway struct {
		Transport  string            `json:"transport"`
		Status     int               `json:"status"`
		Body       string            `json:"body"`
		Headers    map[string]string `json:"headers"`
		BodyRepeat *struct {
			Chunk string `json:"chunk"`
			Times int    `json:"times"`
		} `json:"bodyRepeat"`
	} `json:"gateway"`
	Expect map[string]json.RawMessage `json:"expect"`
}

// knownExpectations is every assertion key this test can check. An unrecognised
// one fails the case rather than being skipped: when meta adds a key, a copy that
// does not understand it would otherwise quietly degrade to a status-only test and
// go on reporting green — a conformance suite that stops conforming without
// saying so.
var knownExpectations = map[string]bool{
	"status": true, "message": true, "messageContains": true,
	"messageNotEmpty": true, "messageMaxLength": true, "headers": true,
}

func loadConformanceCases(t *testing.T) []conformanceCase {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "spacetraders", "testdata", "gateway-errors.json"))
	if err != nil {
		t.Fatalf("reading vendored fixtures: %v", err)
	}
	var file struct {
		Cases []conformanceCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("parsing vendored fixtures: %v", err)
	}
	// A silently empty fixture file would make this whole test pass on nothing.
	if len(file.Cases) < 10 {
		t.Fatalf("expected the full contract, got %d cases", len(file.Cases))
	}
	return file.Cases
}

func TestAnswersEveryGatewayConditionTheContractNames(t *testing.T) {
	for _, testCase := range loadConformanceCases(t) {
		t.Run(testCase.Name, func(t *testing.T) {
			rec := driveOneCase(t, testCase)
			assertRelayed(t, testCase, rec)
		})
	}
}

func driveOneCase(t *testing.T, testCase conformanceCase) *httptest.ResponseRecorder {
	t.Helper()

	var client *spacetraders.Client
	if testCase.Gateway.Transport == "no-response" {
		// A server that is already gone: the connection is refused, which is the
		// same class of failure as DNS or a timeout and the only condition this
		// service is entitled to classify itself.
		dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		url := dead.URL
		dead.Close()
		client = spacetraders.NewClientWithBaseURL(url)
	} else {
		body := testCase.Gateway.Body
		if testCase.Gateway.BodyRepeat != nil {
			body = strings.Repeat(testCase.Gateway.BodyRepeat.Chunk, testCase.Gateway.BodyRepeat.Times)
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			for name, value := range testCase.Gateway.Headers {
				w.Header().Set(name, value)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(testCase.Gateway.Status)
			w.Write([]byte(body))
		}))
		t.Cleanup(server.Close)
		client = spacetraders.NewClientWithBaseURL(server.URL)
	}

	return doRequest(t, newTestRouter(t, nil, client), http.MethodGet, "/api/agent/v1/agent", bearer())
}

func assertRelayed(t *testing.T, testCase conformanceCase, rec *httptest.ResponseRecorder) {
	t.Helper()

	for key := range testCase.Expect {
		if !knownExpectations[key] {
			t.Fatalf("fixture asserts %q, which this test does not know how to check", key)
		}
	}

	rawStatus, ok := testCase.Expect["status"]
	if !ok {
		t.Fatal("every case must assert a status")
	}
	var wantStatus int
	if err := json.Unmarshal(rawStatus, &wantStatus); err != nil {
		t.Fatalf("status: %v", err)
	}
	if rec.Code != wantStatus {
		t.Fatalf("got status %d, want %d (body: %s)", rec.Code, wantStatus, rec.Body.String())
	}

	// http.Error appends a newline; the relayed sentence is the rest.
	message := strings.TrimRight(rec.Body.String(), "\n")

	if raw, ok := testCase.Expect["message"]; ok {
		var want string
		json.Unmarshal(raw, &want)
		// Exact: the caller needs the upstream's own sentence unaltered, so that
		// matching on it downstream means the same thing whoever relayed it.
		if message != want {
			t.Errorf("got message %q, want %q", message, want)
		}
	}
	if raw, ok := testCase.Expect["messageContains"]; ok {
		var want string
		json.Unmarshal(raw, &want)
		if !strings.Contains(message, want) {
			t.Errorf("got message %q, want it to contain %q", message, want)
		}
	}
	if raw, ok := testCase.Expect["messageNotEmpty"]; ok {
		var want bool
		json.Unmarshal(raw, &want)
		if want && strings.TrimSpace(message) == "" {
			t.Error("got an empty message, want something an operator can act on")
		}
	}
	if raw, ok := testCase.Expect["messageMaxLength"]; ok {
		var want int
		json.Unmarshal(raw, &want)
		if len(message) > want {
			t.Errorf("message is %d bytes, want at most %d", len(message), want)
		}
	}
	if raw, ok := testCase.Expect["headers"]; ok {
		var want map[string]string
		json.Unmarshal(raw, &want)
		for name, value := range want {
			if got := rec.Header().Get(name); got != value {
				t.Errorf("got header %s=%q, want %q", name, got, value)
			}
		}
	}
}
