package introspection

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// Declaration is what a route handler declares about credentials. It is
// carried by the handler itself (see Declared), so a router adapter binds the
// requirement exactly where the framework's matcher binds the handler, and a
// handler without one is recognisable as undeclared.
type Declaration struct {
	// Requirement is the policy the guard applies. Undeclared for a handler
	// built with IgnoreCredentials.
	Requirement Requirement
	// IgnoresCredentials marks a route that never reads identity (health,
	// Swagger): the Authorization header is not read and the center is never
	// called, so it keeps answering when auth-service is down.
	IgnoresCredentials bool
}

// Declared is implemented by every handler this package builds. A router
// adapter uses it to refuse, at startup and at request time, a handler that
// carries no declaration.
type Declared interface {
	http.Handler
	Declaration() Declaration
}

// DeclarationOf returns h's declaration, or false when h carries none.
func DeclarationOf(h http.Handler) (Declaration, bool) {
	d, ok := h.(Declared)
	if !ok {
		return Declaration{}, false
	}
	return d.Declaration(), true
}

type identityKey struct{}

// IdentityFrom returns the verified caller the guard put on the context, or
// nil for a visitor (and for a route that ignores credentials).
func IdentityFrom(ctx context.Context) *Identity {
	id, _ := ctx.Value(identityKey{}).(*Identity)
	return id
}

// Guard is the net/http face of the Authorizer.
type Guard struct {
	authorizer *Authorizer
	logger     *log.Logger
}

// NewGuard builds a guard over a center. logger may be nil (log.Default()).
func NewGuard(center Introspector, logger *log.Logger) *Guard {
	if logger == nil {
		logger = log.Default()
	}
	return &Guard{authorizer: NewAuthorizer(center), logger: logger}
}

type guarded struct {
	guard *Guard
	req   Requirement
	next  http.Handler
}

func (g *guarded) Declaration() Declaration { return Declaration{Requirement: g.req} }

func (g *guarded) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	decision := g.guard.authorizer.Authorize(r.Context(), r.Method, g.req, authorizationHeader(r))
	if !decision.Proceed {
		g.guard.WriteError(w, decision.Status, decision.Message)
		return
	}
	if decision.Identity != nil {
		r = r.WithContext(context.WithValue(r.Context(), identityKey{}, decision.Identity))
	}
	g.next.ServeHTTP(w, r)
}

// authorizationHeader returns the Authorization header as one value. Two
// header lines are joined the way a proxy would fold them ("Bearer a, Bearer
// b"), which is four parts and therefore no credential: picking one would let
// a caller choose which of two credentials this service verifies.
// Header.Get alone would silently pick the first.
func authorizationHeader(r *http.Request) string {
	return strings.Join(r.Header.Values("Authorization"), ", ")
}

// Require wraps next in the policy for req. The returned handler carries the
// declaration, so an adapter can see it.
func (g *Guard) Require(req Requirement, next http.Handler) Declared {
	return &guarded{guard: g, req: req, next: next}
}

type ignoring struct{ next http.Handler }

func (i ignoring) Declaration() Declaration { return Declaration{IgnoresCredentials: true} }

func (i ignoring) ServeHTTP(w http.ResponseWriter, r *http.Request) { i.next.ServeHTTP(w, r) }

// IgnoreCredentials declares a route that never reads identity. The
// Authorization header is not read, the center is never called, and a bearer
// sent here — valid, garbage or none — changes nothing. For health and
// Swagger only; an adapter must refuse it on a mutating method.
func IgnoreCredentials(next http.Handler) Declared { return ignoring{next: next} }

// errorEnvelope is the family's {"error":{"message":…}} shape.
type errorEnvelope struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

// WriteError writes a rejection in the family envelope.
func (g *Guard) WriteError(w http.ResponseWriter, status int, message string) {
	WriteError(w, status, message, g.logger)
}

// WriteError writes a rejection in the family envelope. logger may be nil.
func WriteError(w http.ResponseWriter, status int, message string, logger *log.Logger) {
	var body errorEnvelope
	body.Error.Message = message
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		if logger == nil {
			logger = log.Default()
		}
		logger.Printf("failed to write auth error response: %v", err)
	}
}
