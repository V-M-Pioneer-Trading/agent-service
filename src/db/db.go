package db

import (
	"database/sql"
	"errors"
	"log"
	"net"
	"os"
	"time"

	"github.com/go-sql-driver/mysql"
)

// Connection-pool bounds. MySQL drops idle connections after wait_timeout
// (8h by default, far lower behind most proxies); a pooled connection that
// outlives the server's idea of it surfaces as a spurious "invalid connection"
// on the next query. Recycling well inside that window avoids it entirely.
const (
	connMaxLifetime = 3 * time.Minute
	maxOpenConns    = 10

	// pingAttempts/pingDelay cover MySQL's startup window: docker-compose's
	// depends_on waits for the container, not for MySQL to accept connections.
	pingAttempts = 15
	pingDelay    = 2 * time.Second
)

// go-sql-driver/mysql doesn't run multiple statements in one Exec() (that needs
// multiStatements=true on the DSN, which we'd rather not enable globally just for
// startup migrations), so each table is its own statement, executed separately below.
//
// Money columns are BIGINT, not INT: a late-game agent's credit balance passes
// INT's 2,147,483,647 ceiling, and MySQL in strict mode rejects the insert at
// that point (in non-strict mode it silently clamps, which is worse).
var schema = []string{
	`CREATE TABLE IF NOT EXISTS contracts (
		id             VARCHAR(64) PRIMARY KEY,
		faction_symbol VARCHAR(64) NOT NULL,
		type           VARCHAR(32) NOT NULL,
		accepted       BOOLEAN NOT NULL DEFAULT FALSE,
		fulfilled      BOOLEAN NOT NULL DEFAULT FALSE,
		raw_json       JSON NOT NULL,
		updated_at     TIMESTAMP NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS contract_deliveries (
		id            INT AUTO_INCREMENT PRIMARY KEY,
		contract_id   VARCHAR(64) NOT NULL,
		ship_symbol   VARCHAR(64) NOT NULL,
		trade_symbol  VARCHAR(64) NOT NULL,
		units         INT NOT NULL,
		delivered_at  TIMESTAMP NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS transactions (
		id              INT AUTO_INCREMENT PRIMARY KEY,
		type            VARCHAR(32) NOT NULL,
		ship_symbol     VARCHAR(64) NOT NULL,
		waypoint_symbol VARCHAR(64) NOT NULL,
		ship_type       VARCHAR(64) NULL,
		trade_symbol    VARCHAR(64) NULL,
		units           INT NULL,
		price_per_unit  INT NULL,
		total_price     BIGINT NOT NULL,
		agent_credits   BIGINT NOT NULL,
		occurred_at     TIMESTAMP NOT NULL
	)`,
}

// widenedColumns are money columns created as INT by earlier versions. MySQL
// has no conditional DDL, so the migration is guarded by a catalogue lookup
// instead — a bare ALTER on every boot would rebuild the table each time.
var widenedColumns = []struct{ table, column, definition string }{
	{"transactions", "total_price", "BIGINT NOT NULL"},
	{"transactions", "agent_credits", "BIGINT NOT NULL"},
}

// indexes back the only two access patterns either history table has: newest
// first, optionally narrowed to one ship or one contract. Without them every
// list is a full table scan. MySQL has no CREATE INDEX IF NOT EXISTS, so these
// are likewise guarded by a catalogue lookup.
var indexes = []struct{ table, name, columns string }{
	{"contract_deliveries", "idx_deliveries_contract", "(contract_id, delivered_at)"},
	{"transactions", "idx_transactions_occurred", "(occurred_at)"},
	{"transactions", "idx_transactions_ship", "(ship_symbol, occurred_at)"},
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// DSN builds the connection string from MYSQL_* environment variables.
//
// It goes through mysql.Config rather than fmt.Sprintf: a password containing
// '@', '/' or ':' — all legal, all common in generated credentials — produces a
// DSN that parses as a different host or user when pasted into a format string.
//
// Loc/time_zone pin both ends to UTC. MySQL converts TIMESTAMP columns to the
// session time zone on the way in and back out; with the two sides disagreeing,
// every occurred_at and delivered_at round-trips to a different instant.
func DSN() string {
	cfg := mysql.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(getEnv("MYSQL_HOST", "mysql"), getEnv("MYSQL_PORT", "3306"))
	cfg.User = getEnv("MYSQL_USER", "root")
	cfg.Passwd = getEnv("MYSQL_PASSWORD", "example")
	cfg.DBName = getEnv("MYSQL_DATABASE", "vnm-agent-db")
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Params = map[string]string{"time_zone": "'+00:00'"}
	return cfg.FormatDSN()
}

// SetUpDatabase opens the pool, waits for MySQL to accept connections, and
// applies migrations. It returns an error rather than calling log.Fatal so the
// caller owns the process lifecycle — and so this is reachable from a test.
func SetUpDatabase() (*sql.DB, error) {
	log.Default().Printf("Establishing connection to MySql DB...")

	conn, err := sql.Open("mysql", DSN())
	if err != nil {
		return nil, err
	}
	conn.SetConnMaxLifetime(connMaxLifetime)
	conn.SetMaxOpenConns(maxOpenConns)
	conn.SetMaxIdleConns(maxOpenConns)

	if err := waitForDatabase(conn); err != nil {
		conn.Close()
		return nil, err
	}
	log.Default().Printf("Connection to DB is established.")

	if err := Migrate(conn); err != nil {
		conn.Close()
		return nil, err
	}
	log.Default().Printf("Schema migrations applied.")

	return conn, nil
}

func waitForDatabase(conn *sql.DB) error {
	var err error
	for attempt := 1; attempt <= pingAttempts; attempt++ {
		if err = conn.Ping(); err == nil {
			return nil
		}
		log.Default().Printf("DB not ready yet (attempt %d/%d): %v", attempt, pingAttempts, err)
		if attempt < pingAttempts {
			time.Sleep(pingDelay)
		}
	}
	return err
}

// Migrate is idempotent: safe to run on every boot, on a fresh database or one
// created by an earlier version of this service.
func Migrate(conn *sql.DB) error {
	for _, stmt := range schema {
		if _, err := conn.Exec(stmt); err != nil {
			return err
		}
	}

	for _, c := range widenedColumns {
		dataType, err := columnType(conn, c.table, c.column)
		if err != nil {
			return err
		}
		if dataType == "" || dataType == "bigint" {
			continue
		}
		log.Default().Printf("widening %s.%s from %s to %s", c.table, c.column, dataType, c.definition)
		if _, err := conn.Exec("ALTER TABLE " + c.table + " MODIFY " + c.column + " " + c.definition); err != nil {
			return err
		}
	}

	for _, ix := range indexes {
		exists, err := indexExists(conn, ix.table, ix.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := conn.Exec("CREATE INDEX " + ix.name + " ON " + ix.table + " " + ix.columns); err != nil {
			return err
		}
	}
	return nil
}

// columnType returns the declared type of a column, or "" when the table or
// column does not exist.
func columnType(conn *sql.DB, table, column string) (string, error) {
	var dataType string
	err := conn.QueryRow(`
		SELECT DATA_TYPE FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
	`, table, column).Scan(&dataType)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return dataType, err
}

func indexExists(conn *sql.DB, table, name string) (bool, error) {
	var count int
	err := conn.QueryRow(`
		SELECT COUNT(*) FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
	`, table, name).Scan(&count)
	return count > 0, err
}
