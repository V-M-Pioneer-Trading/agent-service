package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	httpSwagger "github.com/swaggo/http-swagger"

	_ "vnm/agent-info-service/docs"
	"vnm/agent-info-service/db"
	"vnm/agent-info-service/spacetraders"
	"vnm/agent-info-service/spacetraders/schema"
)

type CurrentAgentResponse struct {
	Agent     schema.Agent      `json:"agent"`
	Ships     []schema.Ship     `json:"ships"`
	Contracts []schema.Contract `json:"contracts"`
}

type deliveryRequest struct {
	ShipSymbol  string `json:"shipSymbol"`
	TradeSymbol string `json:"tradeSymbol"`
	Units       int    `json:"units"`
}

type handlers struct {
	conn *sql.DB
}

func SetUpRouter(conn *sql.DB) *mux.Router {
	h := &handlers{conn: conn}

	r := mux.NewRouter()
	r.Use(loggingMiddleware, corsMiddleware)
	// Catch-all for CORS preflight: corsMiddleware answers OPTIONS requests itself and
	// never calls this handler, but a route has to exist here for OPTIONS to match at all.
	r.Methods(http.MethodOptions).HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	r.HandleFunc("/health", handleHealth).Methods(http.MethodGet)

	api := r.PathPrefix("/api/agent").Subrouter()

	// Resource routes are versioned; swagger and health below are operational
	// tooling and stay directly under /api/agent, not nested under /v1. Health
	// is mounted both bare above (local dev/compose) and here (production
	// CloudFront only routes requests matching a configured path pattern).
	api.HandleFunc("/health", handleHealth).Methods(http.MethodGet)

	v1 := api.PathPrefix("/v1").Subrouter()

	v1.HandleFunc("/current-agent", h.getCurrentAgent).Methods(http.MethodGet)
	v1.HandleFunc("/agent", h.getAgent).Methods(http.MethodGet)
	v1.HandleFunc("/ships", h.getShips).Methods(http.MethodGet)
	v1.HandleFunc("/ships/{shipSymbol}", h.getShip).Methods(http.MethodGet)
	v1.HandleFunc("/contracts", h.getContracts).Methods(http.MethodGet)
	v1.HandleFunc("/contracts/{contractId}", h.getContract).Methods(http.MethodGet)
	v1.HandleFunc("/contracts/{contractId}/accept", h.acceptContract).Methods(http.MethodPost)
	v1.HandleFunc("/contracts/{contractId}/fulfill", h.fulfillContract).Methods(http.MethodPost)
	v1.HandleFunc("/contracts/{contractId}/deliveries", h.recordDelivery).Methods(http.MethodPost)
	v1.HandleFunc("/contracts/{contractId}/deliveries", h.getDeliveries).Methods(http.MethodGet)
	v1.HandleFunc("/agent/{agentId}", h.getAgentById).Methods(http.MethodGet)
	v1.HandleFunc("/ships/purchase", h.purchaseShip).Methods(http.MethodPost)
	v1.HandleFunc("/ships/{shipSymbol}/purchase", h.purchaseCargo).Methods(http.MethodPost)
	v1.HandleFunc("/ships/{shipSymbol}/sell", h.sellCargo).Methods(http.MethodPost)
	v1.HandleFunc("/transactions", h.getTransactions).Methods(http.MethodGet)

	api.PathPrefix("/swagger/").Handler(httpSwagger.WrapHandler)

	return r
}

// getCurrentAgent godoc
// @Summary      Get agent, ships and contracts in one call
// @Description  Convenience bundle of GET /agent + GET /ships + GET /contracts.
// @Tags         agent
// @Security     BearerAuth
// @Produce      json
// @Success      200  {object}  CurrentAgentResponse
// @Failure      401  {string}  string  "missing Authorization header"
// @Failure      502  {string}  string  "SpaceTraders upstream error"
// @Router       /current-agent [get]
func (h *handlers) getCurrentAgent(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}

	priority := priorityHeader(r)
	var response CurrentAgentResponse

	agent, err := spacetraders.GetMyAgent(authHeader, priority)
	if !writeIfError(w, err) {
		return
	}
	response.Agent = agent

	ships, err := spacetraders.GetMyShips(authHeader, priority)
	if !writeIfError(w, err) {
		return
	}
	response.Ships = ships

	contracts, err := spacetraders.GetMyContracts(authHeader, priority)
	if !writeIfError(w, err) {
		return
	}
	response.Contracts = contracts

	writeJSON(w, response)
}

// getAgent godoc
// @Summary      Get the current agent's profile
// @Tags         agent
// @Security     BearerAuth
// @Produce      json
// @Success      200  {object}  schema.Agent
// @Failure      401  {string}  string  "missing Authorization header"
// @Failure      502  {string}  string  "SpaceTraders upstream error"
// @Router       /agent [get]
func (h *handlers) getAgent(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	agent, err := spacetraders.GetMyAgent(authHeader, priorityHeader(r))
	if !writeIfError(w, err) {
		return
	}
	writeJSON(w, agent)
}

// getShips godoc
// @Summary      List the agent's ships
// @Tags         ships
// @Security     BearerAuth
// @Produce      json
// @Success      200  {array}   schema.Ship
// @Failure      401  {string}  string  "missing Authorization header"
// @Failure      502  {string}  string  "SpaceTraders upstream error"
// @Router       /ships [get]
func (h *handlers) getShips(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	ships, err := spacetraders.GetMyShips(authHeader, priorityHeader(r))
	if !writeIfError(w, err) {
		return
	}
	writeJSON(w, ships)
}

// getShip godoc
// @Summary      Get a single ship
// @Tags         ships
// @Security     BearerAuth
// @Produce      json
// @Param        shipSymbol  path      string  true  "Ship symbol"
// @Success      200         {object}  schema.Ship
// @Failure      401         {string}  string  "missing Authorization header"
// @Failure      404         {string}  string  "ship not found"
// @Failure      502         {string}  string  "SpaceTraders upstream error"
// @Router       /ships/{shipSymbol} [get]
func (h *handlers) getShip(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	shipSymbol := mux.Vars(r)["shipSymbol"]
	ship, err := spacetraders.GetMyShip(authHeader, priorityHeader(r), shipSymbol)
	if !writeIfError(w, err) {
		return
	}
	writeJSON(w, ship)
}

// getContracts godoc
// @Summary      List the agent's contracts
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Success      200  {array}   schema.Contract
// @Failure      401  {string}  string  "missing Authorization header"
// @Failure      502  {string}  string  "SpaceTraders upstream error"
// @Router       /contracts [get]
func (h *handlers) getContracts(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	contracts, err := spacetraders.GetMyContracts(authHeader, priorityHeader(r))
	if !writeIfError(w, err) {
		return
	}
	writeJSON(w, contracts)
}

// getContract godoc
// @Summary      Get a single contract
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {object}  schema.Contract
// @Failure      401         {string}  string  "missing Authorization header"
// @Failure      404         {string}  string  "contract not found"
// @Failure      502         {string}  string  "SpaceTraders upstream error"
// @Router       /contracts/{contractId} [get]
func (h *handlers) getContract(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	contractId := mux.Vars(r)["contractId"]
	contract, err := spacetraders.GetMyContract(authHeader, priorityHeader(r), contractId)
	if !writeIfError(w, err) {
		return
	}
	writeJSON(w, contract)
}

// acceptContract godoc
// @Summary      Accept a contract
// @Description  Calls SpaceTraders' accept-contract, then persists the resulting contract state.
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {object}  schema.ContractAndAgent
// @Failure      401         {string}  string  "missing Authorization header"
// @Failure      502         {string}  string  "SpaceTraders upstream error"
// @Router       /contracts/{contractId}/accept [post]
func (h *handlers) acceptContract(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	contractId := mux.Vars(r)["contractId"]

	result, err := spacetraders.AcceptContract(authHeader, priorityHeader(r), contractId)
	if !writeIfError(w, err) {
		return
	}
	persistContract(h.conn, result.Contract)
	writeJSON(w, result)
}

// fulfillContract godoc
// @Summary      Fulfill a contract
// @Description  Calls SpaceTraders' fulfill-contract, then persists the resulting contract state.
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {object}  schema.ContractAndAgent
// @Failure      401         {string}  string  "missing Authorization header"
// @Failure      502         {string}  string  "SpaceTraders upstream error"
// @Router       /contracts/{contractId}/fulfill [post]
func (h *handlers) fulfillContract(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	contractId := mux.Vars(r)["contractId"]

	result, err := spacetraders.FulfillContract(authHeader, priorityHeader(r), contractId)
	if !writeIfError(w, err) {
		return
	}
	persistContract(h.conn, result.Contract)
	writeJSON(w, result)
}

// recordDelivery godoc
// @Summary      Record a contract delivery (internal)
// @Description  Called by fleet-service after a successful deliver-contract action on SpaceTraders.
// @Tags         contracts
// @Accept       json
// @Produce      json
// @Param        contractId  path      string           true  "Contract ID"
// @Param        delivery    body      deliveryRequest  true  "Delivery details"
// @Success      200         {object}  db.Delivery
// @Failure      400         {string}  string  "invalid request body"
// @Failure      500         {string}  string  "failed to record delivery"
// @Router       /contracts/{contractId}/deliveries [post]
func (h *handlers) recordDelivery(w http.ResponseWriter, r *http.Request) {
	contractId := mux.Vars(r)["contractId"]

	var body deliveryRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.ShipSymbol == "" || body.TradeSymbol == "" || body.Units <= 0 {
		http.Error(w, "shipSymbol, tradeSymbol and units (>0) are required", http.StatusBadRequest)
		return
	}

	delivery := db.Delivery{
		ContractID:  contractId,
		ShipSymbol:  body.ShipSymbol,
		TradeSymbol: body.TradeSymbol,
		Units:       body.Units,
		DeliveredAt: time.Now(),
	}
	if err := db.InsertDelivery(h.conn, delivery); err != nil {
		http.Error(w, "failed to record delivery: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, delivery)
}

// getDeliveries godoc
// @Summary      List recorded deliveries for a contract
// @Tags         contracts
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {array}   db.Delivery
// @Failure      500         {string}  string  "failed to load deliveries"
// @Router       /contracts/{contractId}/deliveries [get]
func (h *handlers) getDeliveries(w http.ResponseWriter, r *http.Request) {
	contractId := mux.Vars(r)["contractId"]
	deliveries, err := db.GetDeliveriesForContract(h.conn, contractId)
	if err != nil {
		http.Error(w, "failed to load deliveries: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, deliveries)
}

type purchaseShipRequest struct {
	ShipType       string `json:"shipType"`
	WaypointSymbol string `json:"waypointSymbol"`
}

type cargoTransactionRequest struct {
	Symbol string `json:"symbol"`
	Units  int    `json:"units"`
}

// purchaseShip godoc
// @Summary      Purchase a new ship
// @Description  Calls SpaceTraders' purchase-ship, then records the transaction in agent-service's transaction history.
// @Tags         ships
// @Security     BearerAuth
// @Accept       json
// @Produce      json
// @Param        body  body      purchaseShipRequest  true  "Ship type and shipyard waypoint"
// @Success      200   {object}  schema.PurchaseShipResult
// @Failure      400   {string}  string  "invalid request body"
// @Failure      401   {string}  string  "missing Authorization header"
// @Failure      502   {string}  string  "SpaceTraders upstream error"
// @Router       /ships/purchase [post]
func (h *handlers) purchaseShip(w http.ResponseWriter, r *http.Request) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	var body purchaseShipRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.ShipType == "" || body.WaypointSymbol == "" {
		http.Error(w, "shipType and waypointSymbol are required", http.StatusBadRequest)
		return
	}

	result, err := spacetraders.PurchaseShip(authHeader, priorityHeader(r), body.ShipType, body.WaypointSymbol)
	if !writeIfError(w, err) {
		return
	}
	shipType := result.Transaction.ShipType
	persistTransaction(h.conn, db.Transaction{
		Type:           "SHIP_PURCHASE",
		ShipSymbol:     result.Ship.Symbol,
		WaypointSymbol: result.Transaction.WaypointSymbol,
		ShipType:       &shipType,
		TotalPrice:     result.Transaction.Price,
		AgentCredits:   result.Agent.Credits,
		OccurredAt:     result.Transaction.Timestamp,
	})
	writeJSON(w, result)
}

// purchaseCargo godoc
// @Summary      Purchase cargo into a ship's hold
// @Description  Calls SpaceTraders' purchase-cargo, then records the transaction in agent-service's transaction history.
// @Tags         ships
// @Security     BearerAuth
// @Accept       json
// @Produce      json
// @Param        shipSymbol  path      string                   true  "Ship symbol"
// @Param        body        body      cargoTransactionRequest  true  "Trade good symbol and units"
// @Success      200         {object}  schema.MarketTransactionResult
// @Failure      400         {string}  string  "invalid request body"
// @Failure      401         {string}  string  "missing Authorization header"
// @Failure      502         {string}  string  "SpaceTraders upstream error"
// @Router       /ships/{shipSymbol}/purchase [post]
func (h *handlers) purchaseCargo(w http.ResponseWriter, r *http.Request) {
	shipSymbol := mux.Vars(r)["shipSymbol"]
	h.tradeCargo(w, r, shipSymbol, "PURCHASE", spacetraders.PurchaseCargo)
}

// sellCargo godoc
// @Summary      Sell cargo from a ship's hold
// @Description  Calls SpaceTraders' sell-cargo, then records the transaction in agent-service's transaction history.
// @Tags         ships
// @Security     BearerAuth
// @Accept       json
// @Produce      json
// @Param        shipSymbol  path      string                   true  "Ship symbol"
// @Param        body        body      cargoTransactionRequest  true  "Trade good symbol and units"
// @Success      200         {object}  schema.MarketTransactionResult
// @Failure      400         {string}  string  "invalid request body"
// @Failure      401         {string}  string  "missing Authorization header"
// @Failure      502         {string}  string  "SpaceTraders upstream error"
// @Router       /ships/{shipSymbol}/sell [post]
func (h *handlers) sellCargo(w http.ResponseWriter, r *http.Request) {
	shipSymbol := mux.Vars(r)["shipSymbol"]
	h.tradeCargo(w, r, shipSymbol, "SELL", spacetraders.SellCargo)
}

func (h *handlers) tradeCargo(
	w http.ResponseWriter,
	r *http.Request,
	shipSymbol string,
	txType string,
	call func(authHeader, priority, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error),
) {
	authHeader, ok := requireAuthHeader(w, r)
	if !ok {
		return
	}
	var body cargoTransactionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Symbol == "" || body.Units <= 0 {
		http.Error(w, "symbol and units (>0) are required", http.StatusBadRequest)
		return
	}

	result, err := call(authHeader, priorityHeader(r), shipSymbol, body.Symbol, body.Units)
	if !writeIfError(w, err) {
		return
	}
	tradeSymbol := result.Transaction.TradeSymbol
	units := result.Transaction.Units
	pricePerUnit := result.Transaction.PricePerUnit
	persistTransaction(h.conn, db.Transaction{
		Type:           txType,
		ShipSymbol:     shipSymbol,
		WaypointSymbol: result.Transaction.WaypointSymbol,
		TradeSymbol:    &tradeSymbol,
		Units:          &units,
		PricePerUnit:   &pricePerUnit,
		TotalPrice:     result.Transaction.TotalPrice,
		AgentCredits:   result.Agent.Credits,
		OccurredAt:     result.Transaction.Timestamp,
	})
	writeJSON(w, result)
}

// getTransactions godoc
// @Summary      List recorded transactions
// @Description  Ship/cargo purchases and cargo sells, newest first. Optionally filtered by shipSymbol and/or type.
// @Tags         ships
// @Produce      json
// @Param        shipSymbol  query     string  false  "Filter by ship symbol"
// @Param        type        query     string  false  "Filter by transaction type (SHIP_PURCHASE, PURCHASE, SELL)"
// @Param        limit       query     int     false  "Max results (default 100)"
// @Success      200         {array}   db.Transaction
// @Failure      500         {string}  string  "failed to load transactions"
// @Router       /transactions [get]
func (h *handlers) getTransactions(w http.ResponseWriter, r *http.Request) {
	shipSymbol := r.URL.Query().Get("shipSymbol")
	txType := r.URL.Query().Get("type")
	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		if parsed, err := strconv.Atoi(l); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	transactions, err := db.ListTransactions(h.conn, shipSymbol, txType, limit)
	if err != nil {
		http.Error(w, "failed to load transactions: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, transactions)
}

func persistTransaction(conn *sql.DB, t db.Transaction) {
	if t.OccurredAt.IsZero() {
		t.OccurredAt = time.Now()
	}
	if err := db.InsertTransaction(conn, t); err != nil {
		log.Default().Printf("failed to persist %s transaction for %s: %v", t.Type, t.ShipSymbol, err)
	}
}

func (h *handlers) getAgentById(w http.ResponseWriter, r *http.Request) {
	agentId := mux.Vars(r)["agentId"]
	fmt.Fprintf(w, "You've requested information about the agent with id: %s", agentId)
}

func persistContract(conn *sql.DB, contract schema.Contract) {
	rawJSON, err := json.Marshal(contract)
	if err != nil {
		log.Default().Printf("failed to marshal contract %s for persistence: %v", contract.ID, err)
		return
	}
	if err := db.UpsertContract(conn, contract.ID, contract.FactionSymbol, contract.Type,
		contract.Accepted, contract.Fulfilled, rawJSON); err != nil {
		log.Default().Printf("failed to persist contract %s: %v", contract.ID, err)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"status": "ok"})
}

func requireAuthHeader(w http.ResponseWriter, r *http.Request) (string, bool) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, "missing Authorization header", http.StatusUnauthorized)
		return "", false
	}
	return authHeader, true
}

// priorityHeader forwards the caller's own X-Priority declaration through to
// st-gateway's priority queue (meta#37) — command-interface (browser) sends
// "interactive", automation-service (autopilot) sends nothing. Callers below
// this only ever check for the literal "interactive" string, so a missing or
// malformed header degrades to "background" rather than accidentally jumping
// the queue.
func priorityHeader(r *http.Request) string {
	return r.Header.Get("X-Priority")
}

// writeIfError maps an *UpstreamError to its SpaceTraders-reported status code (or 502 for
// anything else, e.g. network failures) and writes it to the response. Returns false when an
// error was written, so callers can `if !writeIfError(w, err) { return }`.
func writeIfError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	var upstreamErr *spacetraders.UpstreamError
	if errors.As(err, &upstreamErr) {
		status := upstreamErr.StatusCode
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		http.Error(w, upstreamErr.Message, status)
		return false
	}
	http.Error(w, err.Error(), http.StatusBadGateway)
	return false
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Default().Printf("failed to write JSON response: %v", err)
	}
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Default().Printf("%s request: to %s", r.Method, r.RequestURI)
		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	allowedOrigin := os.Getenv("CORS_ALLOWED_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:3000"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
