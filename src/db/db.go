package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

// go-sql-driver/mysql doesn't run multiple statements in one Exec() (that needs
// multiStatements=true on the DSN, which we'd rather not enable globally just for
// startup migrations), so each table is its own statement, executed separately below.
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
		total_price     INT NOT NULL,
		agent_credits   INT NOT NULL,
		occurred_at     TIMESTAMP NOT NULL
	)`,
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func SetUpDatabase() *sql.DB {
	log.Default().Printf("Establishing connection to MySql DB...")

	host := getEnv("MYSQL_HOST", "mysql")
	port := getEnv("MYSQL_PORT", "3306")
	user := getEnv("MYSQL_USER", "root")
	password := getEnv("MYSQL_PASSWORD", "example")
	database := getEnv("MYSQL_DATABASE", "vnm-agent-db")

	dsn := fmt.Sprintf("%s:%s@(%s:%s)/%s?parseTime=true", user, password, host, port, database)
	conn, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatal(err)
	}

	// MySQL takes a few seconds to accept connections after its container starts, and
	// docker-compose's `depends_on` only waits for the container to start, not for MySQL
	// itself to be ready. Retry instead of failing fast on the first attempt.
	waitForDatabase(conn)
	log.Default().Printf("Connection to DB is established.")

	for _, stmt := range schema {
		if _, err := conn.Exec(stmt); err != nil {
			log.Fatal(err)
		}
	}
	log.Default().Printf("Schema migrations applied.")

	return conn
}

func waitForDatabase(conn *sql.DB) {
	const maxAttempts = 15
	const delay = 2 * time.Second

	var err error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err = conn.Ping(); err == nil {
			return
		}
		log.Default().Printf("DB not ready yet (attempt %d/%d): %v", attempt, maxAttempts, err)
		time.Sleep(delay)
	}
	log.Fatalf("could not connect to DB after %d attempts: %v", maxAttempts, err)
}
