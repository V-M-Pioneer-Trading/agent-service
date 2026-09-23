package introspection

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Names fixed by the fixture's contract block; three implementations agree on
// these spellings.
const (
	EnvURL       = "AUTH_INTROSPECTION_URL"
	EnvSecret    = "AUTH_INTROSPECTION_SECRET"
	SecretHeader = "X-Introspection-Secret"
)

const (
	// DefaultTimeout is the contract's clientTimeoutMs. It covers the whole
	// exchange, body read included: a center that answers instantly and then
	// dribbles bytes forever is as unavailable as one that never answers.
	DefaultTimeout = time.Second

	// MaxResponseBytes caps the center's answer. A real one is ~150 bytes; an
	// answer larger than this is a center we do not understand, and reading
	// the rest of it only spends memory on the way to the same 503.
	MaxResponseBytes = 64 << 10
)

// State is what one introspection call learned.
type State int

const (
	// StateUnavailable deliberately carries no detail. It covers a center that
	// was unreachable, timed out, answered non-2xx (its 401 about OUR secret
	// included), answered a body that is not the contract, or redirected.
	StateUnavailable State = iota
	StateInactive
	StateActive
)

// Answer is the center's verdict on one token.
type Answer struct {
	State    State
	Identity Identity // set only when State is StateActive
}

// Introspector asks the center about one token.
type Introspector interface {
	Introspect(ctx context.Context, token string) Answer
}

// Config is the startup configuration.
type Config struct {
	// URL is the FULL endpoint, /auth/v1/introspect included, POSTed to
	// verbatim: never joined, suffixed or taken apart.
	URL string
	// Secret authenticates this service to the center. Never logged.
	Secret string
}

// LoadConfig reads AUTH_INTROSPECTION_URL and AUTH_INTROSPECTION_SECRET
// through getenv (os.Getenv in production). Both are required: a service that
// starts without them would answer 503 to every mutation and look like an
// auth outage, where a crash-loop with this message is diagnosed in one log
// line. No error ever contains the secret's value, and none contains the URL
// either beyond its scheme.
func LoadConfig(getenv func(string) string) (Config, error) {
	rawURL := getenv(EnvURL)
	if strings.TrimSpace(rawURL) == "" {
		return Config{}, fmt.Errorf("%s is required — refusing to start without it", EnvURL)
	}
	secret := getenv(EnvSecret)
	if strings.TrimSpace(secret) == "" {
		return Config{}, fmt.Errorf("%s is required — refusing to start without it", EnvSecret)
	}
	if secret != strings.TrimSpace(secret) || strings.ContainsFunc(secret, isControl) {
		// A header value cannot carry control characters, and surrounding
		// whitespace would be stripped on the wire, so the center would see a
		// different secret from the one configured. Refuse, without echoing it.
		return Config{}, fmt.Errorf("%s must not contain surrounding whitespace or control characters", EnvSecret)
	}

	parsed, err := url.Parse(rawURL)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" {
		return Config{}, fmt.Errorf("%s must be an absolute URL, for example http://localhost:3005/auth/v1/introspect", EnvURL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		// The scheme is the useful half of the diagnosis and carries nothing
		// sensitive; the rest of the URL is not echoed.
		return Config{}, fmt.Errorf("%s must use http or https, not %q", EnvURL, parsed.Scheme)
	}
	if parsed.User != nil {
		return Config{}, fmt.Errorf("%s must not carry credentials; the secret travels in %s", EnvURL, EnvSecret)
	}
	if parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		// A token never goes in a URL, and neither does anything else: an
		// endpoint URL carrying a query is a sign the secret was put there.
		return Config{}, fmt.Errorf("%s must be a plain endpoint URL with no query string or fragment", EnvURL)
	}
	return Config{URL: rawURL, Secret: secret}, nil
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

// Client is the HTTP introspector. One POST per call, no retries, no cache.
type Client struct {
	url    string
	secret string
	http   *http.Client
	logger *log.Logger
}

// NewClient builds the client. logger receives one line per failed call,
// naming the failure class and never the token or the secret; nil means
// log.Default().
func NewClient(cfg Config, logger *log.Logger) *Client {
	if logger == nil {
		logger = log.Default()
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// No proxy: the token and our secret go to the endpoint we were given and
	// nowhere else, whatever HTTP_PROXY happens to say.
	transport.Proxy = nil
	return &Client{
		url:    cfg.URL,
		secret: cfg.Secret,
		logger: logger,
		http: &http.Client{
			Timeout:   DefaultTimeout,
			Transport: transport,
			// A redirect would carry our caller secret to whatever host the
			// Location header named. A 3xx is simply not a 2xx.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

var unavailable = Answer{State: StateUnavailable}

// Introspect asks the center about token. The token travels only in the form
// body, never in the URL; it is not inspected here in any way.
func (c *Client) Introspect(ctx context.Context, token string) Answer {
	body := url.Values{"token": {token}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, strings.NewReader(body))
	if err != nil {
		c.logger.Printf("introspection: could not build the request to the center")
		return unavailable
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set(SecretHeader, c.secret)

	resp, err := c.http.Do(req)
	if err != nil {
		// *url.Error names the endpoint (which LoadConfig guarantees carries no
		// credential or query) and the transport failure. Neither the body —
		// where the token is — nor the headers are part of it.
		c.logger.Printf("introspection: center unreachable: %v", err)
		return unavailable
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		// Includes the center's 401 about OUR secret: relaying it as a 401
		// would send an operator to sign in again, forever.
		c.logger.Printf("introspection: center answered %d", resp.StatusCode)
		return unavailable
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		c.logger.Printf("introspection: reading the center's answer failed: %v", err)
		return unavailable
	}
	if len(raw) > MaxResponseBytes {
		c.logger.Printf("introspection: center's answer exceeds %d bytes", MaxResponseBytes)
		return unavailable
	}

	answer, err := parseAnswer(raw)
	if err != nil {
		// The body is not logged: a proxy's error page is not ours to copy
		// into a log, and nothing in it helps the operator more than this.
		c.logger.Printf("introspection: center's answer is not the contract: %v", err)
		return unavailable
	}
	return answer
}

// contractKeys are the five names the contract defines, spelled exactly.
var contractKeys = map[string]bool{"active": true, "sub": true, "scope": true, "exp": true, "kind": true}

var errNotContract = errors.New("not the introspection contract")

// decodeObject reads raw as exactly one JSON object and returns its members
// by their exact key. It does NOT go through encoding/json's struct binding,
// which matches keys case-insensitively and lets the last duplicate win:
// {"active":false,"Active":true} would bind active=true. Here a key repeated
// in any spelling, or a contract key in any spelling but its own, makes the
// whole answer unusable rather than letting one copy win.
func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if tok != json.Delim('{') {
		return nil, errors.New("top level is not an object")
	}
	members := map[string]json.RawMessage{}
	seen := map[string]bool{} // lowercased keys
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errors.New("object key is not a string")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		folded := strings.ToLower(key)
		if seen[folded] {
			return nil, fmt.Errorf("key %q appears more than once (ignoring case)", folded)
		}
		seen[folded] = true
		if contractKeys[folded] && key != folded {
			return nil, fmt.Errorf("key %q is not spelled %q", key, folded)
		}
		members[key] = value
	}
	if _, err := dec.Token(); err != nil { // the closing brace
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the object")
	}
	return members, nil
}

// member decodes one present, non-null member into dst. present is false
// when the key is absent; a present null or a wrong type is an error.
func member(members map[string]json.RawMessage, key string, dst any) (present bool, err error) {
	value, ok := members[key]
	if !ok {
		return false, nil
	}
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return true, fmt.Errorf("`%s` is null", key)
	}
	if err := json.Unmarshal(value, dst); err != nil {
		return true, fmt.Errorf("`%s`: %v", key, err)
	}
	return true, nil
}

// isScopeSeparator is the ASCII whitespace RFC 7662's scope list is split on
// (space, tab, CR, LF). Unicode spaces are not separators: a scope string
// carrying U+00A0 or U+2003 is one opaque scope, never two.
func isScopeSeparator(r rune) bool {
	return r == ' ' || r == '\t' || r == '\r' || r == '\n'
}

// parseAnswer turns a body into an answer. A partial or wrongly typed answer
// is NOT active:false: treating it as an inactive token would turn a
// half-deployed center into a fleet-wide 401 storm.
func parseAnswer(raw []byte) (Answer, error) {
	members, err := decodeObject(raw)
	if err != nil {
		return unavailable, fmt.Errorf("%w: %v", errNotContract, err)
	}

	var active bool
	if present, err := member(members, "active", &active); err != nil || !present {
		return unavailable, fmt.Errorf("%w: no boolean `active`", errNotContract)
	}
	if !active {
		return Answer{State: StateInactive}, nil
	}

	var sub string
	if present, err := member(members, "sub", &sub); err != nil || !present || sub == "" {
		return unavailable, fmt.Errorf("%w: active without `sub`", errNotContract)
	}
	var exp float64
	if present, err := member(members, "exp", &exp); err != nil || !present {
		return unavailable, fmt.Errorf("%w: active without numeric `exp`", errNotContract)
	}
	var kind string
	if present, err := member(members, "kind", &kind); err != nil || !present ||
		(Kind(kind) != KindOperator && Kind(kind) != KindMachine) {
		return unavailable, fmt.Errorf("%w: active with an unknown `kind`", errNotContract)
	}

	// `scope` may be ABSENT: auth-service encodes it with omitempty, so a
	// session carrying no scopes arrives without the key (RFC 7662 makes it
	// optional too). Absent is the empty list. Present-but-null and
	// present-but-not-a-string are not the contract.
	var scope string
	if _, err := member(members, "scope", &scope); err != nil {
		return unavailable, fmt.Errorf("%w: %v", errNotContract, err)
	}
	// Separator RUNS, empties discarded, as every verifier in the fleet did
	// before decision 21 — but ASCII whitespace only.
	scopes := strings.FieldsFunc(scope, isScopeSeparator)
	if scopes == nil {
		scopes = []string{}
	}
	return Answer{State: StateActive, Identity: Identity{
		Sub:    sub,
		Kind:   Kind(kind),
		Scopes: scopes,
	}}, nil
}
