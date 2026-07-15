package db

import (
	"database/sql"
	"time"
)

// UpsertContract records the latest known state of a contract, keyed by SpaceTraders' contract ID.
func UpsertContract(conn *sql.DB, id, factionSymbol, contractType string, accepted, fulfilled bool, rawJSON []byte) error {
	_, err := conn.Exec(`
		INSERT INTO contracts (id, faction_symbol, type, accepted, fulfilled, raw_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			accepted   = VALUES(accepted),
			fulfilled  = VALUES(fulfilled),
			raw_json   = VALUES(raw_json),
			updated_at = VALUES(updated_at)
	`, id, factionSymbol, contractType, accepted, fulfilled, string(rawJSON), time.Now())
	return err
}

type Delivery struct {
	ContractID  string    `json:"contractId"`
	ShipSymbol  string    `json:"shipSymbol"`
	TradeSymbol string    `json:"tradeSymbol"`
	Units       int       `json:"units"`
	DeliveredAt time.Time `json:"deliveredAt"`
}

// InsertDelivery records a single deliver-contract event. Called by fleet-service after
// it successfully delivers cargo against a contract on SpaceTraders.
func InsertDelivery(conn *sql.DB, d Delivery) error {
	_, err := conn.Exec(`
		INSERT INTO contract_deliveries (contract_id, ship_symbol, trade_symbol, units, delivered_at)
		VALUES (?, ?, ?, ?, ?)
	`, d.ContractID, d.ShipSymbol, d.TradeSymbol, d.Units, d.DeliveredAt)
	return err
}

func GetDeliveriesForContract(conn *sql.DB, contractID string) ([]Delivery, error) {
	rows, err := conn.Query(`
		SELECT contract_id, ship_symbol, trade_symbol, units, delivered_at
		FROM contract_deliveries WHERE contract_id = ?
		ORDER BY delivered_at ASC
	`, contractID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var deliveries []Delivery
	for rows.Next() {
		var d Delivery
		if err := rows.Scan(&d.ContractID, &d.ShipSymbol, &d.TradeSymbol, &d.Units, &d.DeliveredAt); err != nil {
			return nil, err
		}
		deliveries = append(deliveries, d)
	}
	return deliveries, rows.Err()
}
