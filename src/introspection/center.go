package introspection

import (
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

// wireAnswer uses pointers so "absent" and "wrong type" are both visible.
// json.Unmarshal fails on a type mismatch (active: "true", exp: "soon"), on a
// top-level array or string, and on trailing bytes.
type wireAnswer struct {
	Active *bool    `json:"active"`
	Sub    *string  `json:"sub"`
	Scope  *string  `json:"scope"`
	Exp    *float64 `json:"exp"`
	Kind   *string  `json:"kind"`
}

var errNotContract = errors.New("not the introspection contract")

// parseAnswer turns a body into an answer. A partial or wrongly typed answer
// is NOT active:false: treating it as an inactive token would turn a
// half-deployed center into a fleet-wide 401 storm.
func parseAnswer(raw []byte) (Answer, error) {
	var w wireAnswer
	if err := json.Unmarshal(raw, &w); err != nil {
		return unavailable, fmt.Errorf("%w: %v", errNotContract, err)
	}
	if w.Active == nil {
		return unavailable, fmt.Errorf("%w: no boolean `active`", errNotContract)
	}
	if !*w.Active {
		return Answer{State: StateInactive}, nil
	}
	if w.Sub == nil || *w.Sub == "" {
		return unavailable, fmt.Errorf("%w: active without `sub`", errNotContract)
	}
	if w.Exp == nil {
		return unavailable, fmt.Errorf("%w: active without numeric `exp`", errNotContract)
	}
	if w.Kind == nil || (Kind(*w.Kind) != KindOperator && Kind(*w.Kind) != KindMachine) {
		return unavailable, fmt.Errorf("%w: active with an unknown `kind`", errNotContract)
	}
	// `scope` may be ABSENT: auth-service encodes it with omitempty, so a
	// session carrying no scopes arrives without the key (RFC 7662 makes it
	// optional too). Absent is the empty list. Present-but-not-a-string was
	// already refused by Unmarshal.
	scopes := []string{}
	if w.Scope != nil {
		// Whitespace RUNS, empties discarded — strings.Fields, as every
		// verifier in the fleet did before decision 21.
		scopes = strings.Fields(*w.Scope)
	}
	return Answer{State: StateActive, Identity: Identity{
		Sub:    *w.Sub,
		Kind:   Kind(*w.Kind),
		Scopes: scopes,
	}}, nil
}
