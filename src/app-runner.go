package main

import (
	"net/http"

	"vnm/agent-info-service/api"
	"vnm/agent-info-service/db"
)

// @title Agent Info Service API
// @version 1.0
// @description Service for accessing information about the agent - profile, fleet, contracts.
// @BasePath /api/agent
func main() {

	conn := db.SetUpDatabase()
	r := api.SetUpRouter(conn)

	http.ListenAndServe(":80", r)

}
