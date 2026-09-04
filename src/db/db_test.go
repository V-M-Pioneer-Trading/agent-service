package db

import (
	"database/sql/driver"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/go-sql-driver/mysql"
)

// Regression: the DSN was assembled with fmt.Sprintf, so any password
// containing '@', '/' or ':' — all legal, all common in generated credentials —
// produced a string that parsed as a different host, user or database.
func TestDSNSurvivesSpecialCharactersInThePassword(t *testing.T) {
	t.Setenv("MYSQL_HOST", "db.internal")
	t.Setenv("MYSQL_PORT", "3307")
	t.Setenv("MYSQL_USER", "agent")
	t.Setenv("MYSQL_PASSWORD", "p@ss:w/ord?")
	t.Setenv("MYSQL_DATABASE", "vnm-agent-db")

	cfg, err := mysql.ParseDSN(DSN())
	if err != nil {
		t.Fatalf("the generated DSN does not parse: %v", err)
	}
	if cfg.Passwd != "p@ss:w/ord?" {
		t.Errorf("password round-tripped as %q", cfg.Passwd)
	}
	if cfg.Addr != "db.internal:3307" {
		t.Errorf("address round-tripped as %q", cfg.Addr)
	}
	if cfg.User != "agent" {
		t.Errorf("user round-tripped as %q", cfg.User)
	}
	if cfg.DBName != "vnm-agent-db" {
		t.Errorf("database round-tripped as %q", cfg.DBName)
	}
}

// Regression: MySQL converts TIMESTAMP columns to the session time zone on the
// way in and back out. With Go and MySQL disagreeing about that zone, every
// occurred_at and delivered_at came back as a different instant than was
// written. Pinning both ends to UTC is what makes the round-trip exact.
func TestDSNPinsBothEndsToUTC(t *testing.T) {
	cfg, err := mysql.ParseDSN(DSN())
	if err != nil {
		t.Fatalf("the generated DSN does not parse: %v", err)
	}
	if !cfg.ParseTime {
		t.Error("parseTime must be on, or time columns scan as []byte")
	}
	if cfg.Loc == nil || cfg.Loc.String() != "UTC" {
		t.Errorf("got loc %v, want UTC", cfg.Loc)
	}
	if got := cfg.Params["time_zone"]; got != "'+00:00'" {
		t.Errorf("got session time_zone %q, want '+00:00'", got)
	}
}

// Regression: total_price and agent_credits were INT. A late-game agent's
// credit balance passes INT's 2,147,483,647 ceiling, at which point MySQL in
// strict mode rejects the insert and in non-strict mode silently clamps it.
func TestMoneyColumnsAreWideEnoughForALateGameBalance(t *testing.T) {
	var transactionsDDL string
	for _, stmt := range schema {
		if strings.Contains(stmt, "CREATE TABLE IF NOT EXISTS transactions") {
			transactionsDDL = stmt
		}
	}
	if transactionsDDL == "" {
		t.Fatal("no transactions table in the schema")
	}

	for _, column := range []string{"total_price", "agent_credits"} {
		declaration := regexp.MustCompile(column + `\s+(\w+)`).FindStringSubmatch(transactionsDDL)
		if declaration == nil {
			t.Fatalf("%s is missing from the transactions table", column)
		}
		if declaration[1] != "BIGINT" {
			t.Errorf("%s is declared %s, want BIGINT", column, declaration[1])
		}
	}

	// Existing installs created the columns as INT, so the widening has to be
	// part of the migration too, not just the fresh-install DDL.
	for _, column := range []string{"total_price", "agent_credits"} {
		found := false
		for _, c := range widenedColumns {
			if c.table == "transactions" && c.column == column && strings.HasPrefix(c.definition, "BIGINT") {
				found = true
			}
		}
		if !found {
			t.Errorf("no in-place widening migration for transactions.%s", column)
		}
	}
}

// Regression: neither history table had an index, so every list — including
// the default unfiltered one the UI issues on load — was a full table scan.
func TestHistoryTablesAreIndexedForTheirQueries(t *testing.T) {
	want := map[string]string{
		"contract_deliveries": "contract_id",
		"transactions":        "occurred_at",
	}
	for table, column := range want {
		found := false
		for _, ix := range indexes {
			if ix.table == table && strings.Contains(ix.columns, column) {
				found = true
			}
		}
		if !found {
			t.Errorf("no index on %s covering %s", table, column)
		}
	}
}

func TestParseTransactionType(t *testing.T) {
	for _, valid := range TransactionTypes {
		if got, ok := ParseTransactionType(string(valid)); !ok || got != valid {
			t.Errorf("ParseTransactionType(%q) = %q, %v", valid, got, ok)
		}
	}
	for _, invalid := range []string{"", "purchase", "SHIP-PURCHASE", "BOGUS"} {
		if _, ok := ParseTransactionType(invalid); ok {
			t.Errorf("ParseTransactionType(%q) accepted an unknown type", invalid)
		}
	}
}

// Regression: the filter was expressed as `WHERE (? = ” OR ship_symbol = ?)`,
// binding each filter value twice whether or not it was in use. Unused filters
// now contribute no clause and no argument at all.
func TestListTransactionsOnlyBindsTheFiltersInUse(t *testing.T) {
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer conn.Close()

	cases := []struct {
		name       string
		shipSymbol string
		txType     TransactionType
		wantArgs   []driver.Value
	}{
		{"no filters", "", "", []driver.Value{50}},
		{"ship only", "TEST-1", "", []driver.Value{"TEST-1", 50}},
		{"type only", "", CargoSell, []driver.Value{"SELL", 50}},
		{"both", "TEST-1", CargoSell, []driver.Value{"TEST-1", "SELL", 50}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mock.ExpectQuery("SELECT").WithArgs(c.wantArgs...).WillReturnRows(sqlmock.NewRows(nil))

			if _, err := ListTransactions(conn, c.shipSymbol, c.txType, 50); err != nil {
				t.Fatalf("ListTransactions: %v", err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Errorf("unexpected query arguments: %v", err)
			}
		})
	}
}

// Regression: an empty result set produced a nil slice, which marshals to JSON
// null rather than [].
func TestListTransactionsReturnsAnEmptySliceNotNil(t *testing.T) {
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer conn.Close()
	mock.ExpectQuery("SELECT").WillReturnRows(sqlmock.NewRows(nil))

	got, err := ListTransactions(conn, "", "", 10)
	if err != nil {
		t.Fatalf("ListTransactions: %v", err)
	}
	if got == nil {
		t.Error("got a nil slice, which serialises as null")
	}
}

func TestGetDeliveriesForContractReturnsAnEmptySliceNotNil(t *testing.T) {
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer conn.Close()
	mock.ExpectQuery("SELECT").WillReturnRows(sqlmock.NewRows(nil))

	got, err := GetDeliveriesForContract(conn, "abc")
	if err != nil {
		t.Fatalf("GetDeliveriesForContract: %v", err)
	}
	if got == nil {
		t.Error("got a nil slice, which serialises as null")
	}
}

// Migrate has to be safe on every boot, on a fresh database and on one an
// earlier version created. These cover the branching, not the SQL dialect —
// see "known limitations" in the README.
func TestMigrateSkipsWorkThatIsAlreadyDone(t *testing.T) {
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer conn.Close()

	for range schema {
		mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnResult(sqlmock.NewResult(0, 0))
	}
	// Columns already BIGINT and indexes already present: no DDL should follow.
	for range widenedColumns {
		mock.ExpectQuery("information_schema.COLUMNS").
			WillReturnRows(sqlmock.NewRows([]string{"DATA_TYPE"}).AddRow("bigint"))
	}
	for range indexes {
		mock.ExpectQuery("information_schema.STATISTICS").
			WillReturnRows(sqlmock.NewRows([]string{"c"}).AddRow(1))
	}

	if err := Migrate(conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Migrate did more than it needed to: %v", err)
	}
}

func TestMigrateWidensAndIndexesAnOlderDatabase(t *testing.T) {
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer conn.Close()

	for range schema {
		mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnResult(sqlmock.NewResult(0, 0))
	}
	for range widenedColumns {
		mock.ExpectQuery("information_schema.COLUMNS").
			WillReturnRows(sqlmock.NewRows([]string{"DATA_TYPE"}).AddRow("int"))
		mock.ExpectExec("ALTER TABLE transactions MODIFY").WillReturnResult(sqlmock.NewResult(0, 0))
	}
	for range indexes {
		mock.ExpectQuery("information_schema.STATISTICS").
			WillReturnRows(sqlmock.NewRows([]string{"c"}).AddRow(0))
		mock.ExpectExec("CREATE INDEX").WillReturnResult(sqlmock.NewResult(0, 0))
	}

	if err := Migrate(conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("Migrate skipped a needed step: %v", err)
	}
}

// A table that doesn't exist yet reports no column type at all, which must not
// be mistaken for "exists, and is the wrong type".
func TestMigrateToleratesAnAbsentColumn(t *testing.T) {
	conn, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	defer conn.Close()

	for range schema {
		mock.ExpectExec("CREATE TABLE IF NOT EXISTS").WillReturnResult(sqlmock.NewResult(0, 0))
	}
	for range widenedColumns {
		mock.ExpectQuery("information_schema.COLUMNS").WillReturnRows(sqlmock.NewRows([]string{"DATA_TYPE"}))
	}
	for range indexes {
		mock.ExpectQuery("information_schema.STATISTICS").
			WillReturnRows(sqlmock.NewRows([]string{"c"}).AddRow(1))
	}

	if err := Migrate(conn); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unexpected statements: %v", err)
	}
}
