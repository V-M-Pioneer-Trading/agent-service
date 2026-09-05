package api

// Clerk session verification, performed locally.
//
// Same shape as automation-service and fleet-service's auth.ts: networkless
// RS256 verification via a PEM public key (CLERK_JWT_KEY), no bypass flag.
// Only the trust anchor differs between local dev, CI and production.
//
// agent-service's routes split three ways under auth-design.md decision 18:
//   - reads that forward live to SpaceTraders (agent, ships, contracts) need
//     a signed-in session, no particular scope — agent-service holds no
//     SpaceTraders credential of its own, so an anonymous caller has nothing
//     to read regardless of scope, until auth-service exists.
//   - mutations (accept/fulfill contract, purchase ship, buy/sell cargo) need
//     fleet:control, same as fleet-service.
//   - reads backed by agent-service's own MySQL history (transactions,
//     deliveries) need neither — there is no credential problem for a read
//     that never calls SpaceTraders at all, so these stay public, matching
//     decision 2's "every GET is public" and automation-service's own
//     Postgres-backed reads.
//
// Decision 18's second header, X-SpaceTraders-Token, is gone: st-gateway now
// injects the SpaceTraders credential itself from auth-service (decision 5),
// so no caller has to hand one over. What this service forwards upstream
// instead is the caller's own verified Clerk token — see callerAuthorization.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// SCOPEFleetControl is the only scope this service enforces.
const SCOPEFleetControl = "fleet:control"

// AuthConfig holds the Clerk trust anchor.
type AuthConfig struct {
	ClerkJWTKeyPEM string
	ClerkIssuer    string // empty means "don't check"
}

type verifier struct {
	publicKey interface{}
	issuer    string
}

func newVerifier(cfg AuthConfig) (*verifier, error) {
	key, err := jwt.ParseRSAPublicKeyFromPEM([]byte(cfg.ClerkJWTKeyPEM))
	if err != nil {
		return nil, err
	}
	return &verifier{publicKey: key, issuer: cfg.ClerkIssuer}, nil
}

func bearerFrom(r *http.Request) string {
	header := r.Header.Get("Authorization")
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
		return ""
	}
	return parts[1]
}

// scopesFrom accepts the `scope` claim as either a space-delimited string
// (the OAuth convention Clerk's default session token uses) or an array, so a
// caller is never locked out by a formatting choice made in a dashboard.
func scopesFrom(claims jwt.MapClaims) []string {
	switch v := claims["scope"].(type) {
	case string:
		return strings.Fields(v)
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, s := range v {
			if str, ok := s.(string); ok {
				out = append(out, str)
			}
		}
		return out
	default:
		return nil
	}
}

// authError is the JSON envelope every auth rejection uses, matching the
// sibling services' shape.
type authError struct {
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	var body authError
	body.Error.Message = message
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Default().Printf("failed to write auth error response: %v", err)
	}
}

// verify runs the real check both requireScope and requireSession share: a
// well-formed, correctly-signed, unexpired Clerk session. hasScope decides
// what additionally has to be true of its claims.
func (v *verifier) verify(w http.ResponseWriter, r *http.Request, hasScope func([]string) bool) (*http.Request, bool) {
	token := bearerFrom(r)
	if token == "" {
		writeAuthError(w, http.StatusUnauthorized, "a bearer token is required")
		return r, false
	}

	parsed, err := jwt.Parse(token, func(t *jwt.Token) (interface{}, error) {
		return v.publicKey, nil
	}, jwt.WithValidMethods([]string{"RS256"}), issuerOption(v.issuer))
	if err != nil || !parsed.Valid {
		// Not surfacing the specific reason — "expired" vs "bad signature" vs
		// "wrong issuer" is a probing oracle, and the remedy is the same.
		writeAuthError(w, http.StatusUnauthorized, "invalid or expired session")
		return r, false
	}

	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !hasScope(scopesFrom(claims)) {
		writeAuthError(w, http.StatusForbidden, "this action requires a scope this session does not carry")
		return r, false
	}

	// Carry the verified header forward for st-gateway's priority derivation.
	// Re-normalised rather than copied verbatim so what leaves this service is
	// the token that was actually checked, not whatever spacing the caller used.
	return r.WithContext(context.WithValue(r.Context(), callerAuthKey, "Bearer "+token)), true
}

func issuerOption(issuer string) jwt.ParserOption {
	if issuer == "" {
		return func(*jwt.Parser) {}
	}
	return jwt.WithIssuer(issuer)
}

// requireScope wraps a handler, rejecting unless the caller presents a valid
// Clerk session carrying the given scope.
func (v *verifier) requireScope(scope string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r, ok := v.verify(w, r, func(scopes []string) bool {
			for _, s := range scopes {
				if s == scope {
					return true
				}
			}
			return false
		})
		if !ok {
			return
		}
		next(w, r)
	}
}

// requireSession wraps a handler, rejecting unless the caller presents a
// valid Clerk session — any scope, or none at all.
func (v *verifier) requireSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		r, ok := v.verify(w, r, func([]string) bool { return true })
		if !ok {
			return
		}
		next(w, r)
	}
}

// RequireClerkJWTKey reads Clerk's public key: inline CLERK_JWT_KEY (how
// production passes it from SSM through the bootstrap script) wins over
// CLERK_JWT_KEY_FILE (how compose mounts the local dev key). Neither has a
// default — matches the sibling services' config.ts exactly, including the
// reasoning: a service that can start without a trust anchor is one that can
// be deployed with authentication silently off.
func RequireClerkJWTKey() (string, error) {
	if inline := os.Getenv("CLERK_JWT_KEY"); inline != "" {
		return strings.ReplaceAll(inline, `\n`, "\n"), nil
	}
	if path := os.Getenv("CLERK_JWT_KEY_FILE"); path != "" {
		pem, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if len(strings.TrimSpace(string(pem))) == 0 {
			return "", errors.New("CLERK_JWT_KEY_FILE (" + path + ") is empty")
		}
		return string(pem), nil
	}
	return "", errors.New("CLERK_JWT_KEY or CLERK_JWT_KEY_FILE must be set")
}

// callerAuthKey carries the caller's verified Clerk Authorization header from
// verify to the handler. Its own unexported type keeps it from colliding with
// any other package's context keys.
type contextKey int

const callerAuthKey contextKey = iota

// callerAuthorization returns the caller's Clerk Authorization header, to be
// forwarded to st-gateway. It is only ever called from a handler behind
// requireSession or requireScope, so the value is always present and has
// already been verified.
//
// st-gateway does not use it as a credential — it injects the SpaceTraders
// token itself, from auth-service (auth-design.md decision 5). It uses it to
// derive the request's priority class from a verified identity rather than a
// self-declared header (decision 2): a human Clerk session (sub prefixed
// "user_") earns the interactive lane, a machine token ("mch_") and anything
// unverifiable get background. Forwarding it is what lets a browser request
// keep its interactive priority across this hop.
func callerAuthorization(r *http.Request) string {
	header, _ := r.Context().Value(callerAuthKey).(string)
	return header
}
