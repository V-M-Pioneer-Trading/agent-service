package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"vnm/agent-info-service/api"
	"vnm/agent-info-service/db"
	"vnm/agent-info-service/spacetraders"
)

// Server timeouts. Reading is bounded so a slow or stalled client can't hold a
// connection open indefinitely. Writing deliberately isn't: /current-agent makes
// three sequential upstream calls, each already bounded by the SpaceTraders
// client's own timeout, and a write deadline shorter than their sum would cut
// off legitimate responses.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second
	idleTimeout       = 120 * time.Second
)

// @title                       Agent Info Service API
// @version                     1.0
// @description                 Service for accessing information about the agent - profile, fleet, contracts.
// @BasePath                    /api/agent/v1
// @securityDefinitions.apikey  BearerAuth
// @in                          header
// @name                        Authorization
// @description                 Clerk session token, as "Bearer <jwt>".
// @securityDefinitions.apikey  GameToken
// @in                          header
// @name                        X-SpaceTraders-Token
// @description                 The caller's own SpaceTraders agent token, forwarded upstream verbatim and never stored.
func main() {
	conn, err := db.SetUpDatabase()
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()

	clerkJWTKey, err := api.RequireClerkJWTKey()
	if err != nil {
		log.Fatal(err)
	}

	router, err := api.SetUpRouter(conn, spacetraders.NewClient(), api.AuthConfig{
		ClerkJWTKeyPEM: clerkJWTKey,
		ClerkIssuer:    os.Getenv("CLERK_ISSUER"),
	})
	if err != nil {
		log.Fatal(err)
	}

	// PORT defaults to 80 so the container and its deployment keep the port
	// they already publish; it exists so `go run .` works as an unprivileged
	// user, which binding 80 does not.
	port := os.Getenv("PORT")
	if port == "" {
		port = "80"
	}

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           router,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
	}
	log.Default().Printf("agent-service listening on %s", server.Addr)
	// ListenAndServe always returns a non-nil error. Ignoring it made a failed
	// bind — a port already in use, most often — look like a clean exit.
	log.Fatal(server.ListenAndServe())
}
