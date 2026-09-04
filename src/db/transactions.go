package db

import (
	"database/sql"
	"strings"
	"time"
)

// TransactionType enumerates the credit-moving events this service records.
// This is the single definition list: handlers tag rows with these constants
// and the ?type= query filter is validated against the same set, so a typo in
// either place is a compile error or a 400 rather than a silently empty result.
type TransactionType string

const (
	ShipPurchase  TransactionType = "SHIP_PURCHASE"
	CargoPurchase TransactionType = "PURCHASE"
	CargoSell     TransactionType = "SELL"
)

// TransactionTypes lists every valid TransactionType, in the order documented.
var TransactionTypes = []TransactionType{ShipPurchase, CargoPurchase, CargoSell}

// ParseTransactionType resolves a caller-supplied string, reporting whether it
// names a real transaction type.
func ParseTransactionType(s string) (TransactionType, bool) {
	for _, t := range TransactionTypes {
		if string(t) == s {
			return t, true
		}
	}
	return "", false
}

// TransactionTypeNames renders the valid values for an error message.
func TransactionTypeNames() string {
	names := make([]string, len(TransactionTypes))
	for i, t := range TransactionTypes {
		names[i] = string(t)
	}
	return strings.Join(names, ", ")
}

type Transaction struct {
	Type           TransactionType `json:"type"`
	ShipSymbol     string          `json:"shipSymbol"`
	WaypointSymbol string          `json:"waypointSymbol"`
	ShipType       *string         `json:"shipType,omitempty"`
	TradeSymbol    *string         `json:"tradeSymbol,omitempty"`
	Units          *int            `json:"units,omitempty"`
	PricePerUnit   *int            `json:"pricePerUnit,omitempty"`
	TotalPrice     int             `json:"totalPrice"`
	AgentCredits   int             `json:"agentCredits"`
	OccurredAt     time.Time       `json:"occurredAt"`
}

const transactionColumns = `type, ship_symbol, waypoint_symbol, ship_type, trade_symbol,
	units, price_per_unit, total_price, agent_credits, occurred_at`

// InsertTransaction records a single ship-purchase, cargo-purchase, or cargo-sell
// event. Called by agent-service's own purchase/sell handlers immediately after
// the corresponding SpaceTraders call succeeds.
func InsertTransaction(conn *sql.DB, t Transaction) error {
	_, err := conn.Exec(`
		INSERT INTO transactions (`+transactionColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, t.Type, t.ShipSymbol, t.WaypointSymbol, t.ShipType, t.TradeSymbol,
		t.Units, t.PricePerUnit, t.TotalPrice, t.AgentCredits, t.OccurredAt)
	return err
}

// ListTransactions returns recorded transactions, newest first, optionally
// filtered by ship symbol and/or type (zero value = no filter on that field).
// The result is never nil: an empty history serialises as [], not null.
func ListTransactions(conn *sql.DB, shipSymbol string, txType TransactionType, limit int) ([]Transaction, error) {
	query := `SELECT ` + transactionColumns + ` FROM transactions`
	var conditions []string
	var args []any
	if shipSymbol != "" {
		conditions = append(conditions, "ship_symbol = ?")
		args = append(args, shipSymbol)
	}
	if txType != "" {
		conditions = append(conditions, "type = ?")
		args = append(args, string(txType))
	}
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY occurred_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	transactions := []Transaction{}
	for rows.Next() {
		var t Transaction
		if err := rows.Scan(&t.Type, &t.ShipSymbol, &t.WaypointSymbol, &t.ShipType, &t.TradeSymbol,
			&t.Units, &t.PricePerUnit, &t.TotalPrice, &t.AgentCredits, &t.OccurredAt); err != nil {
			return nil, err
		}
		transactions = append(transactions, t)
	}
	return transactions, rows.Err()
}
