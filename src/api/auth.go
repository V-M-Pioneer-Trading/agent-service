package api

// Route-level authorization: how agent-service's gorilla/mux router binds a
// credential requirement to every route (auth-design.md decision 21,
// meta#80 step 6).
//
// agent-service no longer verifies a Clerk token. The policy — which answer
// for which header and which center response — lives in package
// introspection and is pinned by meta/fixtures/introspection.json. This file
// is only the adapter, and its one job is the part the fixture cannot reach:
// making sure every route the router can dispatch to carries a declaration,
// and that no mutating route declares "nothing needed".
//
// That is enforced twice:
//
//   - at startup, secureRouter walks the router and refuses to build it if any
//     route's handler carries no declaration, or if a route that answers a
//     mutating method (or any method at all) declares none or ignores
//     credentials. SetUpRouter returns the error and main exits.
//   - at request time, refuseUndeclared answers 500 for a matched route whose
//     handler carries no declaration — belt and braces for a route added after
//     the walk, which gorilla/mux permits.
//
// The requirement is carried by the handler value itself, so it is bound
// exactly where mux binds the handler. HEAD is registered on the same route
// object as GET, so HEAD /x is governed by what GET /x declared by
// construction rather than by a lookup that could miss.

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gorilla/mux"

	"vnm/agent-info-service/introspection"
)

// SCOPEFleetControl is the only scope this service enforces.
const SCOPEFleetControl = "fleet:control"

// authError documents the {"error":{"message":…}} envelope every auth
// rejection uses, for Swagger. The envelope itself is written by
// introspection.WriteError.
type authError struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

// secureRouter installs the request-time check and then walks every route.
// Call it after the last route is registered.
func secureRouter(r *mux.Router) error {
	r.Use(refuseUndeclared)

	var problems []string
	err := r.Walk(func(route *mux.Route, _ *mux.Router, _ []*mux.Route) error {
		handler := route.GetHandler()
		if handler == nil {
			// A subrouter mount: a matcher, not a handler. Its own routes are
			// walked next.
			return nil
		}
		name := describeRoute(route)

		decl, ok := introspection.DeclarationOf(handler)
		if !ok {
			problems = append(problems, name+" declares no credential requirement")
			return nil
		}
		if !decl.IgnoresCredentials && !decl.Requirement.Declared() {
			problems = append(problems, name+" was built with an undeclared requirement")
			return nil
		}

		methods, err := route.GetMethods()
		if err != nil {
			methods = nil // no method matcher: the route answers every method
		}
		mutating := len(methods) == 0
		for _, m := range methods {
			if !introspection.IsSafeMethod(m) {
				mutating = true
			}
		}
		if mutating && (decl.IgnoresCredentials || decl.Requirement.IsNone()) {
			problems = append(problems, name+" answers a mutating method but declares no session or scope")
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(problems) > 0 {
		return errors.New("refusing to start: " + strings.Join(problems, "; "))
	}
	return nil
}

func describeRoute(route *mux.Route) string {
	path, err := route.GetPathTemplate()
	if err != nil {
		path = "(any path)"
	}
	methods, err := route.GetMethods()
	if err != nil || len(methods) == 0 {
		return fmt.Sprintf("route [any method] %s", path)
	}
	return fmt.Sprintf("route %v %s", methods, path)
}

// refuseUndeclared is the request-time half of default-deny. A matched route
// whose handler carries no declaration is never served, on any method: a
// resolver miss is a routing-table defect, never "none".
func refuseUndeclared(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route := mux.CurrentRoute(r)
		if route == nil {
			introspection.WriteError(w, http.StatusInternalServerError, introspection.MessageUndeclaredRoute, nil)
			return
		}
		if _, ok := introspection.DeclarationOf(route.GetHandler()); !ok {
			introspection.WriteError(w, http.StatusInternalServerError, introspection.MessageUndeclaredRoute, nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// getRoute registers a safe read: GET, and HEAD on the SAME route object, so
// the two can never carry different requirements. Go's server discards a
// HEAD response body itself.
func getRoute(r *mux.Router, path string, h introspection.Declared) {
	r.Handle(path, h).Methods(http.MethodGet, http.MethodHead)
}

// postRoute registers a mutation. secureRouter refuses it at startup unless h
// declares a session or a scope.
func postRoute(r *mux.Router, path string, h introspection.Declared) {
	r.Handle(path, h).Methods(http.MethodPost)
}
