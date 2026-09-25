// Package introspection is agent-service's client for auth-service's
// POST /auth/v1/introspect (auth-design.md decision 21, meta#80 step 6).
//
// agent-service no longer verifies a Clerk token itself. It sends the bytes it
// received to the center, gets back {active, sub, scope, exp, kind}, and
// decides only what its own route needs. The whole policy is the 37
// calling-service cases of meta/fixtures/introspection.json, vendored into
// testdata/ and driven by conformance_test.go.
//
// Three layers, each usable without the next:
//
//   - policy.go (this file): the rules, with no HTTP server anywhere near them.
//   - center.go: the one HTTP call to auth-service, and startup config.
//   - http.go: net/http middleware — Require, IgnoreCredentials, the error
//     envelope and the identity on the request context.
//
// Nothing in this package parses, decodes or logs a token, and nothing logs
// the caller secret.
package introspection

import (
	"context"
	"net/http"
	"strings"
)

// The five sentences a calling service answers with. The first three are
// byte-identical to what every verifier in the fleet said before decision 21;
// the last two are new with it. Quoted from the fixture's contract.messages.
const (
	MessageMissingToken      = "a bearer token is required"
	MessageInvalidSession    = "invalid or expired session"
	MessageMissingScope      = "this action requires a scope this session does not carry"
	MessageUndeclaredRoute   = "this route declares no required scope"
	MessageCenterUnavailable = "the authentication service could not process this request"
)

// Kind is the center's classification of a subject. It is used verbatim and
// never re-derived from the `sub` prefix: the center is the one place in the
// fleet that knows Clerk's subject conventions.
type Kind string

const (
	KindOperator Kind = "operator"
	KindMachine  Kind = "machine"
)

// Identity is what a verified token carries, handed to the handler.
type Identity struct {
	Sub    string
	Kind   Kind
	Scopes []string
}

// HasScope is exact membership of the split list: no prefix, no namespace
// walk, no substring, no case-folding. `fleet:control:read` does not satisfy
// `fleet:control`, and neither does `FLEET:CONTROL`.
func (i Identity) HasScope(scope string) bool {
	for _, s := range i.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

type tier int

const (
	// tierUndeclared is the zero value on purpose: a Requirement nobody built
	// is not "none", it is a routing-table defect, and it is refused.
	tierUndeclared tier = iota
	tierNone
	tierSession
	tierScope
)

// Requirement is what a route declares it needs. Build one with None,
// Session or Scope; the zero value is "undeclared" and is never served.
type Requirement struct {
	tier  tier
	scope string
}

// None declares that the route needs no credential. On a mutating method it
// is refused with a 500 (default-deny); on GET, HEAD and OPTIONS a caller
// without a header proceeds as a visitor.
func None() Requirement { return Requirement{tier: tierNone} }

// Session declares that any verified session will do, with or without scopes.
func Session() Requirement { return Requirement{tier: tierSession} }

// Scope declares that the session must carry exactly this scope literal. An
// empty literal is not a scope; it yields an undeclared requirement, which is
// refused, rather than a requirement no token could meet or every token would.
func Scope(literal string) Requirement {
	if literal == "" {
		return Requirement{}
	}
	return Requirement{tier: tierScope, scope: literal}
}

// Declared reports whether the requirement was built by None, Session or Scope.
func (r Requirement) Declared() bool { return r.tier != tierUndeclared }

// IsNone reports whether the route declared that it needs no credential.
func (r Requirement) IsNone() bool { return r.tier == tierNone }

// String renders the requirement the way the fixture spells it: "none",
// "session" or the scope literal. An undeclared one is "undeclared".
func (r Requirement) String() string {
	switch r.tier {
	case tierNone:
		return "none"
	case tierSession:
		return "session"
	case tierScope:
		return r.scope
	default:
		return "undeclared"
	}
}

// IsSafeMethod is true for GET, HEAD and OPTIONS, compared case-insensitively.
// These are RFC 9110's safe methods and are exempt from DEFAULT-DENY only: a
// safe method on a route that did declare a session or a scope is enforced
// exactly as a POST is.
func IsSafeMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

// BearerFrom extracts the token from an Authorization header value, or
// returns "" when the header is not a bearer credential.
//
// A credential is EXACTLY the scheme plus one token68: two whitespace-separated
// parts, the scheme compared case-insensitively. Everything else is no
// credential at all — "Bearer" and "Bearer " carry no token, "Bearer abc def"
// is not the token "abcdef" nor "abc def" (a header is never concatenated or
// split-with-a-limit into a token nobody issued), and "Basic …" is not
// forwarded. The token itself is opaque: never parsed, decoded or validated.
func BearerFrom(header string) string {
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return ""
	}
	return parts[1]
}

// Decision is what the policy decided for one inbound request.
type Decision struct {
	// Proceed is true when the handler may run.
	Proceed bool
	// Identity is the verified caller when Proceed is true and a token was
	// presented; nil for a visitor. Always nil on a rejection.
	Identity *Identity
	// Status and Message describe a rejection. Zero when Proceed is true.
	Status  int
	Message string
}

func reject(status int, message string) Decision {
	return Decision{Status: status, Message: message}
}

// Authorizer applies the policy, asking the center when a token is presented.
type Authorizer struct {
	center Introspector
}

// NewAuthorizer builds the policy over a center.
func NewAuthorizer(center Introspector) *Authorizer {
	return &Authorizer{center: center}
}

// Authorize decides one request. authorization is the raw header value, ""
// when absent. The order of the rules is the rule:
//
//  1. A mutating method on a route declaring none (or nothing at all) is a
//     500 — decided BEFORE the header is read, so a valid token, an inactive
//     one and none at all get the same answer, and the center is not called.
//  2. No bearer credential: a visitor on a route declaring none (only safe
//     methods reach here), otherwise 401 without calling the center.
//  3. Otherwise ask the center exactly once and act on the answer.
func (a *Authorizer) Authorize(ctx context.Context, method string, req Requirement, authorization string) Decision {
	if !req.Declared() {
		// A resolver miss is never "none". Loud on every method.
		return reject(http.StatusInternalServerError, MessageUndeclaredRoute)
	}
	if req.IsNone() && !IsSafeMethod(method) {
		// 500, not 403: our own routing-table defect, which the caller can
		// never fix, and which automation-service would otherwise classify
		// as a terminal credentials problem.
		return reject(http.StatusInternalServerError, MessageUndeclaredRoute)
	}

	token := BearerFrom(authorization)
	if token == "" {
		if req.IsNone() {
			// A public read or a preflight with nothing presented. Nothing to
			// introspect, so the center is not touched.
			return Decision{Proceed: true}
		}
		return reject(http.StatusUnauthorized, MessageMissingToken)
	}

	answer := a.center.Introspect(ctx, token)
	switch answer.State {
	case StateActive:
	case StateInactive:
		// On every method, including a GET that would have been served to a
		// visitor. A bad credential is never downgraded to anonymous.
		return reject(http.StatusUnauthorized, MessageInvalidSession)
	default:
		// Unreachable, timed out, non-2xx (including the center rejecting OUR
		// secret), malformed. Fail closed; never relay the center's status.
		return reject(http.StatusServiceUnavailable, MessageCenterUnavailable)
	}

	identity := answer.Identity
	if req.tier == tierScope && !identity.HasScope(req.scope) {
		// 403: the session is valid, re-authenticating would loop. The
		// message never names the scope.
		return reject(http.StatusForbidden, MessageMissingScope)
	}
	return Decision{Proceed: true, Identity: &identity}
}
