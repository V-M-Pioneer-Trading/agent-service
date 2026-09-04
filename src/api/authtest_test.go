package api

// Test credentials: an ephemeral keypair, generated once per test binary run.
//
// Tests exercise the real verification path in auth.go — there is no stub
// verifier and no bypass flag. Only the trust anchor differs from production,
// matching the same approach as automation-service and fleet-service's
// testSupport/authTokens.ts.

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/golang-jwt/jwt/v5"

	"vnm/agent-info-service/spacetraders"
)

var (
	testPrivateKey, testPublicKey = mustGenerateKeyPair()
	foreignPrivateKey, _          = mustGenerateKeyPair()
	testClerkPublicKeyPEM         = mustEncodePublicKeyPEM(testPublicKey)
)

func mustGenerateKeyPair() (*rsa.PrivateKey, *rsa.PublicKey) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return key, &key.PublicKey
}

func mustEncodePublicKeyPEM(key *rsa.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		panic(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

type testTokenOptions struct {
	scopes           []string
	sub              string
	expiresInSeconds int
	issuer           string
}

func signTestToken(key *rsa.PrivateKey, opts testTokenOptions) string {
	if opts.sub == "" {
		opts.sub = "user_2TestOperator"
	}
	if opts.expiresInSeconds == 0 {
		opts.expiresInSeconds = 300
	}
	scope := strings.Join(opts.scopes, " ")

	claims := jwt.MapClaims{
		"sub":   opts.sub,
		"scope": scope,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(time.Duration(opts.expiresInSeconds) * time.Second).Unix(),
	}
	if opts.issuer != "" {
		claims["iss"] = opts.issuer
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	signed, err := token.SignedString(key)
	if err != nil {
		panic(err)
	}
	return signed
}

// bearer returns a ready-to-use Authorization header value for an operator
// with fleet:control.
func bearer() string {
	return "Bearer " + signTestToken(testPrivateKey, testTokenOptions{scopes: []string{SCOPEFleetControl}})
}

// bearerWithoutScope returns a signed-in operator who holds no scope at all.
func bearerWithoutScope() string {
	return "Bearer " + signTestToken(testPrivateKey, testTokenOptions{scopes: []string{}})
}

// expiredBearer returns a well-formed token whose exp has already passed.
func expiredBearer() string {
	return "Bearer " + signTestToken(testPrivateKey, testTokenOptions{scopes: []string{SCOPEFleetControl}, expiresInSeconds: -60})
}

// foreignBearer is correctly shaped, correct scopes, valid exp — signed by a
// key the service has never seen. The one token that proves the signature is
// actually checked rather than the payload merely being decoded.
func foreignBearer() string {
	return "Bearer " + signTestToken(foreignPrivateKey, testTokenOptions{scopes: []string{SCOPEFleetControl}})
}

func testAuthConfig() AuthConfig {
	return AuthConfig{ClerkJWTKeyPEM: testClerkPublicKeyPEM}
}

// Column lists mirroring the SELECTs in package db, so a stubbed row set
// matches what Scan expects.
var (
	transactionColumns = []string{"type", "ship_symbol", "waypoint_symbol", "ship_type", "trade_symbol",
		"units", "price_per_unit", "total_price", "agent_credits", "occurred_at"}
	deliveryColumns = []string{"contract_id", "ship_symbol", "trade_symbol", "units", "delivered_at"}
)

// newTestRouter builds the real router. Both dependencies are injected rather
// than discovered from process environment, so tests never mutate global state
// and can run in any order.
func newTestRouter(t *testing.T, conn *sql.DB, st *spacetraders.Client) http.Handler {
	t.Helper()
	router, err := SetUpRouter(conn, st, testAuthConfig())
	if err != nil {
		t.Fatalf("SetUpRouter: %v", err)
	}
	return router
}

// stubGateway stands in for st-gateway and returns a client pointed at it.
func stubGateway(t *testing.T, handler http.HandlerFunc) *spacetraders.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return spacetraders.NewClientWithBaseURL(server.URL)
}

func newMockDB(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn, mock
}

// decodeAuthError pulls error.message out of a JSON auth rejection.
func decodeAuthError(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body authError
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding auth error %q: %v", rec.Body.String(), err)
	}
	return body.Error.Message
}

func writeFile(path, contents string) error {
	return os.WriteFile(path, []byte(contents), 0o600)
}
