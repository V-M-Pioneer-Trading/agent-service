package db

import (
	"database/sql"
	"time"
)

type Transaction struct {
	Type           string    `json:"type"`
	ShipSymbol     string    `json:"shipSymbol"`
	WaypointSymbol string    `json:"waypointSymbol"`
	ShipType       *string   `json:"shipType,omitempty"`
	TradeSymbol    *string   `json:"tradeSymbol,omitempty"`
	Units          *int      `json:"units,omitempty"`
	PricePerUnit   *int      `json:"pricePerUnit,omitempty"`
	TotalPrice     int       `json:"totalPrice"`
	AgentCredits   int       `json:"agentCredits"`
	OccurredAt     time.Time `json:"occurredAt"`
}

// InsertTransaction records a single ship-purchase, cargo-purchase, or cargo-sell
// event. Called by agent-service's own purchase/sell handlers immediately after
// the corresponding SpaceTraders call succeeds.
func InsertTransaction(conn *sql.DB, t Transaction) error {
	_, err := conn.Exec(`
		INSERT INTO transactions
			(type, ship_symbol, waypoint_symbol, ship_type, trade_symbol, units, price_per_unit, total_price, agent_credits, occurred_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, t.Type, t.ShipSymbol, t.WaypointSymbol, t.ShipType, t.TradeSymbol, t.Units, t.PricePerUnit, t.TotalPrice, t.AgentCredits, t.OccurredAt)
	return err
}

// ListTransactions returns recorded transactions, newest first, optionally
// filtered by ship symbol and/or type (empty string = no filter on that field).
func ListTransactions(conn *sql.DB, shipSymbol, txType string, limit int) ([]Transaction, error) {
	rows, err := conn.Query(`
		SELECT type, ship_symbol, waypoint_symbol, ship_type, trade_symbol, units, price_per_unit, total_price, agent_credits, occurred_at
		FROM transactions
		WHERE (? = '' OR ship_symbol = ?) AND (? = '' OR type = ?)
		ORDER BY occurred_at DESC
		LIMIT ?
	`, shipSymbol, shipSymbol, txType, txType, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var transactions []Transaction
	for rows.Next() {
		var t Transaction
		if err := rows.Scan(&t.Type, &t.ShipSymbol, &t.WaypointSymbol, &t.ShipType, &t.TradeSymbol, &t.Units, &t.PricePerUnit, &t.TotalPrice, &t.AgentCredits, &t.OccurredAt); err != nil {
			return nil, err
		}
		transactions = append(transactions, t)
	}
	return transactions, rows.Err()
}
