package schema

import "time"

// ShipyardTransaction is the result of purchasing a new ship.
// https://spacetraders.stoplight.io/docs/spacetraders/6d5f8b0e5b6a3-shipyard-transaction
type ShipyardTransaction struct {
	WaypointSymbol string    `json:"waypointSymbol"`
	ShipType       string    `json:"shipType"`
	Price          int       `json:"price"`
	AgentSymbol    string    `json:"agentSymbol"`
	Timestamp      time.Time `json:"timestamp"`
}

// MarketTransaction is the result of purchasing or selling cargo at a market.
// https://spacetraders.stoplight.io/docs/spacetraders/97e267435466a-market-transaction
type MarketTransaction struct {
	WaypointSymbol string    `json:"waypointSymbol"`
	ShipSymbol     string    `json:"shipSymbol"`
	TradeSymbol    string    `json:"tradeSymbol"`
	Type           string    `json:"type"`
	Units          int       `json:"units"`
	PricePerUnit   int       `json:"pricePerUnit"`
	TotalPrice     int       `json:"totalPrice"`
	Timestamp      time.Time `json:"timestamp"`
}

type PurchaseShipResult struct {
	Agent       Agent               `json:"agent"`
	Ship        Ship                `json:"ship"`
	Transaction ShipyardTransaction `json:"transaction"`
}

type PurchaseShipResponse struct {
	Data PurchaseShipResult `json:"data"`
}

// MarketTransactionResult is the shared response shape of purchase-cargo and sell-cargo.
type MarketTransactionResult struct {
	Agent       Agent             `json:"agent"`
	Cargo       Cargo             `json:"cargo"`
	Transaction MarketTransaction `json:"transaction"`
}

type MarketTransactionResponse struct {
	Data MarketTransactionResult `json:"data"`
}
