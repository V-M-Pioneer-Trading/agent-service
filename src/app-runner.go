package main

import (
	"net/http"

	"vnm/agent-info-service/api"
	"vnm/agent-info-service/db"
)

func main() {

	conn := db.SetUpDatabase()
	r := api.SetUpRouter(conn)

	http.ListenAndServe(":80", r)

}
