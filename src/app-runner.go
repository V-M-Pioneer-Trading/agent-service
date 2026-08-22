package main

import (
	"log"
	"net/http"
	"os"

	"vnm/agent-info-service/api"
	"vnm/agent-info-service/db"
)

// @title Agent Info Service API
// @version 1.0
// @description Service for accessing information about the agent - profile, fleet, contracts.
// @BasePath /api/agent/v1
func main() {

	conn := db.SetUpDatabase()

	clerkJWTKey, err := api.RequireClerkJWTKey()
	if err != nil {
		log.Fatal(err)
	}
	r, err := api.SetUpRouter(conn, api.AuthConfig{
		ClerkJWTKeyPEM: clerkJWTKey,
		ClerkIssuer:    os.Getenv("CLERK_ISSUER"),
	})
	if err != nil {
		log.Fatal(err)
	}

	http.ListenAndServe(":80", r)

}
