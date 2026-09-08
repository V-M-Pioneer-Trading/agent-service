package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	httpSwagger "github.com/swaggo/http-swagger"

	"vnm/agent-info-service/db"
	_ "vnm/agent-info-service/docs"
	"vnm/agent-info-service/spacetraders"
	"vnm/agent-info-service/spacetraders/schema"
)

const (
	// maxBodyBytes caps a request body. Every POST here carries a handful of
	// short fields; without a ceiling an unauthenticated caller can make the
	// service buffer an arbitrarily large body before validation runs.
	maxBodyBytes = 1 << 20 // 1 MiB

	defaultTransactionLimit = 100
	maxTransactionLimit     = 1000
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

type purchaseShipRequest struct {
	ShipType       string `json:"shipType"`
	WaypointSymbol string `json:"waypointSymbol"`
}

type cargoTransactionRequest struct {
	Symbol string `json:"symbol"`
	Units  int    `json:"units"`
}

type handlers struct {
	conn *sql.DB
	st   *spacetraders.Client
}

// SetUpRouter wires every route to one of three access tiers. st may be nil
// only when no SpaceTraders-backed route will be exercised.
func SetUpRouter(conn *sql.DB, st *spacetraders.Client, auth AuthConfig) (*mux.Router, error) {
	h := &handlers{conn: conn, st: st}
	v, err := newVerifier(auth)
	if err != nil {
		return nil, err
	}

	// The three access tiers, named once (auth-design.md decision 18):
	//
	//   read   — forwards live to SpaceTraders on the fleet's credential (which
	//            st-gateway injects, decision 5): a signed-in Clerk session, no
	//            particular scope. Not anonymous: these are reads about the one
	//            account, and decision 3 allows anonymous live reads only where a
	//            visitor cannot expand them.
	//   write  — mutations, which additionally need fleet:control, same as
	//            fleet-service.
	//   public — reads served entirely from this service's own MySQL history.
	//            They never call SpaceTraders, so there is no credential
	//            problem to gate against; matches decision 2 and
	//            automation-service's Postgres-backed reads.
	read := func(next http.HandlerFunc) http.HandlerFunc {
		return v.requireSession(forwardCallerSession(next))
	}
	write := func(next http.HandlerFunc) http.HandlerFunc {
		return v.requireScope(SCOPEFleetControl, forwardCallerSession(next))
	}

	r := mux.NewRouter()
	r.Use(loggingMiddleware, corsMiddleware())
	// Catch-all for CORS preflight: corsMiddleware answers OPTIONS requests itself and
	// never calls this handler, but a route has to exist here for OPTIONS to match at all.
	r.Methods(http.MethodOptions).HandlerFunc(func(w http.ResponseWriter, r *http.Request) {})

	r.HandleFunc("/health", handleHealth).Methods(http.MethodGet)

	agentAPI := r.PathPrefix("/api/agent").Subrouter()

	// Resource routes are versioned; swagger and health below are operational
	// tooling and stay directly under /api/agent, not nested under /v1. Health
	// is mounted both bare above (local dev/compose) and here (production
	// CloudFront only routes requests matching a configured path pattern).
	agentAPI.HandleFunc("/health", handleHealth).Methods(http.MethodGet)

	v1 := agentAPI.PathPrefix("/v1").Subrouter()

	v1.HandleFunc("/current-agent", read(h.getCurrentAgent)).Methods(http.MethodGet)
	v1.HandleFunc("/agent", read(h.getAgent)).Methods(http.MethodGet)
	v1.HandleFunc("/ships", read(h.getShips)).Methods(http.MethodGet)
	v1.HandleFunc("/ships/{shipSymbol}", read(h.getShip)).Methods(http.MethodGet)
	v1.HandleFunc("/contracts", read(h.getContracts)).Methods(http.MethodGet)
	v1.HandleFunc("/contracts/{contractId}", read(h.getContract)).Methods(http.MethodGet)

	v1.HandleFunc("/contracts/{contractId}/accept", write(h.acceptContract)).Methods(http.MethodPost)
	v1.HandleFunc("/contracts/{contractId}/fulfill", write(h.fulfillContract)).Methods(http.MethodPost)
	v1.HandleFunc("/ships/purchase", write(h.purchaseShip)).Methods(http.MethodPost)
	v1.HandleFunc("/ships/{shipSymbol}/purchase", write(h.purchaseCargo)).Methods(http.MethodPost)
	v1.HandleFunc("/ships/{shipSymbol}/sell", write(h.sellCargo)).Methods(http.MethodPost)

	// recordDelivery is an internal call from fleet-service, not a browser
	// route. It is the one *write* on this tier — see "known limitations" in
	// the README.
	v1.HandleFunc("/contracts/{contractId}/deliveries", h.recordDelivery).Methods(http.MethodPost)
	v1.HandleFunc("/contracts/{contractId}/deliveries", h.getDeliveries).Methods(http.MethodGet)
	v1.HandleFunc("/transactions", h.getTransactions).Methods(http.MethodGet)

	agentAPI.PathPrefix("/swagger/").Handler(httpSwagger.WrapHandler)

	return r, nil
}

// getCurrentAgent godoc
// @Summary      Get agent, ships and contracts in one call
// @Description  Convenience bundle of GET /agent + GET /ships + GET /contracts.
// @Tags         agent
// @Security     BearerAuth
// @Produce      json
// @Success      200  {object}  CurrentAgentResponse
// @Failure      401  {object}  authError  "no Clerk session, or no game token"
// @Failure      502  {string}  string     "st-gateway answered with something unreadable"
// @Failure      504  {string}  string     "st-gateway did not answer"
// @Router       /current-agent [get]
func (h *handlers) getCurrentAgent(w http.ResponseWriter, r *http.Request) {
	var response CurrentAgentResponse

	agent, err := h.st.GetMyAgent(r.Context())
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	ships, err := h.st.GetMyShips(r.Context())
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	contracts, err := h.st.GetMyContracts(r.Context())
	if err != nil {
		writeUpstreamError(w, err)
		return
	}

	response.Agent, response.Ships, response.Contracts = agent, ships, contracts
	writeJSON(w, response)
}

// getAgent godoc
// @Summary      Get the current agent's profile
// @Tags         agent
// @Security     BearerAuth
// @Produce      json
// @Success      200  {object}  schema.Agent
// @Failure      401  {object}  authError  "no Clerk session, or no game token"
// @Failure      502  {string}  string     "st-gateway answered with something unreadable"
// @Failure      504  {string}  string     "st-gateway did not answer"
// @Router       /agent [get]
func (h *handlers) getAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := h.st.GetMyAgent(r.Context())
	respond(w, agent, err)
}

// getShips godoc
// @Summary      List the agent's ships
// @Tags         ships
// @Security     BearerAuth
// @Produce      json
// @Success      200  {array}   schema.Ship
// @Failure      401  {object}  authError  "no Clerk session, or no game token"
// @Failure      502  {string}  string     "st-gateway answered with something unreadable"
// @Failure      504  {string}  string     "st-gateway did not answer"
// @Router       /ships [get]
func (h *handlers) getShips(w http.ResponseWriter, r *http.Request) {
	ships, err := h.st.GetMyShips(r.Context())
	respond(w, ships, err)
}

// getShip godoc
// @Summary      Get a single ship
// @Tags         ships
// @Security     BearerAuth
// @Produce      json
// @Param        shipSymbol  path      string  true  "Ship symbol"
// @Success      200         {object}  schema.Ship
// @Failure      401         {object}  authError  "no Clerk session, or no game token"
// @Failure      404         {string}  string     "ship not found"
// @Failure      502         {string}  string     "st-gateway answered with something unreadable"
// @Failure      504         {string}  string     "st-gateway did not answer"
// @Router       /ships/{shipSymbol} [get]
func (h *handlers) getShip(w http.ResponseWriter, r *http.Request) {
	ship, err := h.st.GetMyShip(r.Context(), mux.Vars(r)["shipSymbol"])
	respond(w, ship, err)
}

// getContracts godoc
// @Summary      List the agent's contracts
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Success      200  {array}   schema.Contract
// @Failure      401  {object}  authError  "no Clerk session, or no game token"
// @Failure      502  {string}  string     "st-gateway answered with something unreadable"
// @Failure      504  {string}  string     "st-gateway did not answer"
// @Router       /contracts [get]
func (h *handlers) getContracts(w http.ResponseWriter, r *http.Request) {
	contracts, err := h.st.GetMyContracts(r.Context())
	respond(w, contracts, err)
}

// getContract godoc
// @Summary      Get a single contract
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {object}  schema.Contract
// @Failure      401         {object}  authError  "no Clerk session, or no game token"
// @Failure      404         {string}  string     "contract not found"
// @Failure      502         {string}  string     "st-gateway answered with something unreadable"
// @Failure      504         {string}  string     "st-gateway did not answer"
// @Router       /contracts/{contractId} [get]
func (h *handlers) getContract(w http.ResponseWriter, r *http.Request) {
	contract, err := h.st.GetMyContract(r.Context(), mux.Vars(r)["contractId"])
	respond(w, contract, err)
}

// acceptContract godoc
// @Summary      Accept a contract
// @Description  Calls SpaceTraders' accept-contract, then persists the resulting contract state.
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {object}  schema.ContractAndAgent
// @Failure      401         {object}  authError  "no Clerk session, or no game token"
// @Failure      403         {object}  authError  "session lacks fleet:control"
// @Failure      502         {string}  string     "st-gateway answered with something unreadable"
// @Failure      504         {string}  string     "st-gateway did not answer"
// @Router       /contracts/{contractId}/accept [post]
func (h *handlers) acceptContract(w http.ResponseWriter, r *http.Request) {
	h.contractStateChange(w, r, h.st.AcceptContract)
}

// fulfillContract godoc
// @Summary      Fulfill a contract
// @Description  Calls SpaceTraders' fulfill-contract, then persists the resulting contract state.
// @Tags         contracts
// @Security     BearerAuth
// @Produce      json
// @Param        contractId  path      string  true  "Contract ID"
// @Success      200         {object}  schema.ContractAndAgent
// @Failure      401         {object}  authError  "no Clerk session, or no game token"
// @Failure      403         {object}  authError  "session lacks fleet:control"
// @Failure      502         {string}  string     "st-gateway answered with something unreadable"
// @Failure      504         {string}  string     "st-gateway did not answer"
// @Router       /contracts/{contractId}/fulfill [post]
func (h *handlers) fulfillContract(w http.ResponseWriter, r *http.Request) {
	h.contractStateChange(w, r, h.st.FulfillContract)
}

// contractStateChange is accept-contract and fulfill-contract: same inputs,
// same response shape, same persistence step, different upstream call.
func (h *handlers) contractStateChange(
	w http.ResponseWriter,
	r *http.Request,
	call func(ctx context.Context, contractId string) (schema.ContractAndAgent, error),
) {
	result, err := call(r.Context(), mux.Vars(r)["contractId"])
	if err != nil {
		writeUpstreamError(w, err)
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
	var body deliveryRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.ShipSymbol == "" || body.TradeSymbol == "" || body.Units <= 0 {
		http.Error(w, "shipSymbol, tradeSymbol and units (>0) are required", http.StatusBadRequest)
		return
	}

	delivery := db.Delivery{
		ContractID:  mux.Vars(r)["contractId"],
		ShipSymbol:  body.ShipSymbol,
		TradeSymbol: body.TradeSymbol,
		Units:       body.Units,
		DeliveredAt: time.Now().UTC(),
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
	deliveries, err := db.GetDeliveriesForContract(h.conn, mux.Vars(r)["contractId"])
	if err != nil {
		http.Error(w, "failed to load deliveries: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, deliveries)
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
// @Failure      400   {string}  string     "invalid request body"
// @Failure      401   {object}  authError  "no Clerk session, or no game token"
// @Failure      403   {object}  authError  "session lacks fleet:control"
// @Failure      502   {string}  string     "st-gateway answered with something unreadable"
// @Failure      504   {string}  string     "st-gateway did not answer"
// @Router       /ships/purchase [post]
func (h *handlers) purchaseShip(w http.ResponseWriter, r *http.Request) {
	var body purchaseShipRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.ShipType == "" || body.WaypointSymbol == "" {
		http.Error(w, "shipType and waypointSymbol are required", http.StatusBadRequest)
		return
	}

	result, err := h.st.PurchaseShip(r.Context(), body.ShipType, body.WaypointSymbol)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	shipType := result.Transaction.ShipType
	persistTransaction(h.conn, db.Transaction{
		Type:           db.ShipPurchase,
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
// @Failure      400         {string}  string     "invalid request body"
// @Failure      401         {object}  authError  "no Clerk session, or no game token"
// @Failure      403         {object}  authError  "session lacks fleet:control"
// @Failure      502         {string}  string     "st-gateway answered with something unreadable"
// @Failure      504         {string}  string     "st-gateway did not answer"
// @Router       /ships/{shipSymbol}/purchase [post]
func (h *handlers) purchaseCargo(w http.ResponseWriter, r *http.Request) {
	h.tradeCargo(w, r, db.CargoPurchase, h.st.PurchaseCargo)
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
// @Failure      400         {string}  string     "invalid request body"
// @Failure      401         {object}  authError  "no Clerk session, or no game token"
// @Failure      403         {object}  authError  "session lacks fleet:control"
// @Failure      502         {string}  string     "st-gateway answered with something unreadable"
// @Failure      504         {string}  string     "st-gateway did not answer"
// @Router       /ships/{shipSymbol}/sell [post]
func (h *handlers) sellCargo(w http.ResponseWriter, r *http.Request) {
	h.tradeCargo(w, r, db.CargoSell, h.st.SellCargo)
}

// tradeCargo is purchase-cargo and sell-cargo: same request body, same
// response shape, same history row modulo its type.
func (h *handlers) tradeCargo(
	w http.ResponseWriter,
	r *http.Request,
	txType db.TransactionType,
	call func(ctx context.Context, shipSymbol, tradeSymbol string, units int) (schema.MarketTransactionResult, error),
) {
	var body cargoTransactionRequest
	if !decodeBody(w, r, &body) {
		return
	}
	if body.Symbol == "" || body.Units <= 0 {
		http.Error(w, "symbol and units (>0) are required", http.StatusBadRequest)
		return
	}

	shipSymbol := mux.Vars(r)["shipSymbol"]
	result, err := call(r.Context(), shipSymbol, body.Symbol, body.Units)
	if err != nil {
		writeUpstreamError(w, err)
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
// @Param        type        query     string  false  "Filter by transaction type"  Enums(SHIP_PURCHASE, PURCHASE, SELL)
// @Param        limit       query     int     false  "Max results, 1-1000"  default(100)
// @Success      200         {array}   db.Transaction
// @Failure      400         {string}  string  "invalid query parameter"
// @Failure      500         {string}  string  "failed to load transactions"
// @Router       /transactions [get]
func (h *handlers) getTransactions(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	// An unrecognised type used to fall through as a filter that matches
	// nothing, so a typo looked exactly like an empty history.
	var txType db.TransactionType
	if raw := query.Get("type"); raw != "" {
		parsed, ok := db.ParseTransactionType(raw)
		if !ok {
			http.Error(w, "type must be one of: "+db.TransactionTypeNames(), http.StatusBadRequest)
			return
		}
		txType = parsed
	}

	// An unparseable limit used to be silently replaced by the default, and
	// an arbitrarily large one was passed straight to MySQL.
	limit := defaultTransactionLimit
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			http.Error(w, "limit must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = min(parsed, maxTransactionLimit)
	}

	transactions, err := db.ListTransactions(h.conn, query.Get("shipSymbol"), txType, limit)
	if err != nil {
		http.Error(w, "failed to load transactions: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, transactions)
}

// persistTransaction and persistContract record history on a best-effort
// basis. The SpaceTraders call they follow has already succeeded and cannot be
// undone, so a failed write is logged and the caller still gets its result —
// the history is allowed to be incomplete, the game state is not.
func persistTransaction(conn *sql.DB, t db.Transaction) {
	if t.OccurredAt.IsZero() {
		t.OccurredAt = time.Now().UTC()
	}
	if err := db.InsertTransaction(conn, t); err != nil {
		log.Default().Printf("failed to persist %s transaction for %s: %v", t.Type, t.ShipSymbol, err)
	}
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

// forwardCallerSession puts the already-verified Clerk session on the request
// context so the spacetraders client forwards it to st-gateway, which derives
// queue priority from it (auth-design.md decision 2). Sits inside the verifier
// wrappers deliberately: only a session that passed verification is forwarded.
func forwardCallerSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := spacetraders.WithCallerAuthorization(r.Context(), r.Header.Get("Authorization"))
		next(w, r.WithContext(ctx))
	}
}

// decodeBody reads a size-capped JSON body, answering 400 and reporting false
// when it cannot.
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(dst); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

// respond writes v as JSON, or maps err onto a status code — the shape of
// every handler that only forwards a SpaceTraders read.
func respond[T any](w http.ResponseWriter, v T, err error) {
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	writeJSON(w, v)
}

// writeUpstreamError relays st-gateway's verdict: its status, its message, and the
// pacing headers it forwards on a passed-through 429. See
// meta/docs/design/upstream-errors.md.
//
// The 502 fallback is for anything that is not an *UpstreamError at all — a 2xx
// body this service could not decode being the realistic one, which is exactly
// what 502 means here. A gateway that did not answer is already a 504 by the time
// it reaches this function.
func writeUpstreamError(w http.ResponseWriter, err error) {
	// Logged here and not in each handler: one inbound request can make several
	// upstream calls — /current-agent makes three — and the caller only ever sees
	// the sentence, never which call produced it.
	log.Default().Printf("upstream call failed: %v", err)

	var upstreamErr *spacetraders.UpstreamError
	if errors.As(err, &upstreamErr) {
		status := upstreamErr.StatusCode
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		for name, value := range upstreamErr.Headers {
			w.Header().Set(name, value)
		}
		http.Error(w, upstreamErr.Message, status)
		return
	}
	http.Error(w, err.Error(), http.StatusBadGateway)
}

func writeJSON(w http.ResponseWriter, v any) {
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

// corsMiddleware resolves CORS_ALLOWED_ORIGIN once, when the router is built,
// rather than on every request.
func corsMiddleware() mux.MiddlewareFunc {
	allowedOrigin := os.Getenv("CORS_ALLOWED_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "http://localhost:3000"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			// Pacing headers relayed from st-gateway. None is CORS-safelisted, so
			// without this a browser sees the 429 and not the instructions that
			// came with it — the relay would reach the network and stop at the
			// last hop that matters.
			w.Header().Set("Access-Control-Expose-Headers",
				"Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
