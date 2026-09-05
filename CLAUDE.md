# CLAUDE.md

Contributor and agent notes for agent-service. The README explains what the service is and
why; this file is what you need to change it safely.

## Commands

All Go commands run from `src/`.

| Task | Command |
|---|---|
| Build | `go build ./...` |
| Test | `go test ./...` |
| Test as CI does | `go test ./... -race -shuffle=on` |
| Vet | `go vet ./...` |
| Format check | `test -z "$(gofmt -l .)"` |
| Run locally | `PORT=8080 CLERK_JWT_KEY="$(cat key.pem)" go run .` |
| Regenerate Swagger | `swag init -g app-runner.go --parseInternal --output ./docs` |
| Start MySQL only | `docker compose up -d mysql` (from repo root) |

CI runs format check, vet and the race/shuffle test suite on both pull requests and pushes to
`main`; the image build and deploy is gated on that job passing.

## Module map

| File | Owns | Depends on |
|---|---|---|
| `src/app-runner.go` | Process lifecycle: config read, dependency construction, HTTP server, Swagger's top-level annotations | `api`, `db`, `spacetraders` |
| `src/api/routes.go` | Route table, access tiers, handlers, request/response shaping | `db`, `spacetraders`, `spacetraders/schema`, `docs` (blank) |
| `src/api/auth.go` | Clerk verification, the three guard wrappers, game-token middleware, `RequireClerkJWTKey` | `golang-jwt/jwt/v5` only |
| `src/spacetraders/client.go` | The only outbound HTTP in the service; gateway address, timeout, priority normalisation | `spacetraders/schema` |
| `src/spacetraders/errors.go` | `UpstreamError` | — |
| `src/spacetraders/schema/` | Wire types for the SpaceTraders API | — |
| `src/db/db.go` | DSN, pool, startup wait, `Migrate` | `go-sql-driver/mysql` |
| `src/db/transactions.go` | `TransactionType` enum, transaction row read/write | stdlib |
| `src/db/contracts.go` | Contract upsert, delivery row read/write | stdlib |
| `src/docs/` | **Generated.** Never hand-edit | — |

### Dependency rules

* `db` and `spacetraders` never import `api`. `api` is the only package that knows about HTTP.
* `db` never imports `spacetraders` and vice versa. They are joined only in `api` handlers.
* `spacetraders/schema` imports nothing from this module — it is pure wire types.
* Only `spacetraders/client.go` makes outbound HTTP calls. If you need a new upstream call, add
  a method there rather than a `http.Get` in a handler.
* Only `db` writes SQL. Handlers call named functions, never build queries.
* `api/auth.go` has no knowledge of routes, and `api/routes.go` has no knowledge of JWTs.

## Invariants

Stated so a violation is recognisable in review:

1. **The service never persists a SpaceTraders token.** It arrives on `X-SpaceTraders-Token`,
   is turned into an `Authorization: Bearer …` value for one upstream call, and is dropped.
   Anything that writes it to a table, a log line, or a struct field outliving a request is a
   bug.
2. **The two credentials never mix.** `Authorization` is always Clerk. `X-SpaceTraders-Token`
   is always the game. A handler that reads `Authorization` directly is wrong.
   *Interim — see "Pending: increment 3 Stage 5" below. The game token is on its
   way out entirely; this invariant describes today's code, not the target.*
3. **The access tier is declared at the router, never inside a handler.** Every route in
   `SetUpRouter` goes through `read(…)`, `write(…)`, or is deliberately bare (public). A
   handler that checks credentials itself has moved policy out of the one place it is readable.
4. **A handler behind `requireGameToken` can assume `gameToken(r)` is non-empty.** Wiring one
   without the wrapper silently produces upstream calls with an empty `Authorization`.
5. **History writes never fail a request.** The upstream call has already changed game state
   that cannot be rolled back. `persistTransaction` / `persistContract` log and return.
6. **List endpoints return `[]`, never `null`.** `ListTransactions` and
   `GetDeliveriesForContract` initialise their slices. A `var xs []T` in either is a regression.
7. **`Migrate` is idempotent and runs on every boot.** Any statement added there must either be
   `IF NOT EXISTS` or guarded by an `information_schema` check.
8. **Anything that isn't exactly `"interactive"` is background priority.** Normalisation happens
   once, in `spacetraders.normalizePriority`. Never compare priority strings elsewhere.
   *Interim — st-gateway no longer reads `X-Priority` at all. See "Pending" below.*
9. **`SetUpRouter` returns an error rather than exiting.** Only `main` calls `log.Fatal`.

## Critical sequences

**Startup — the order matters.** `main` opens the database *before* reading the Clerk key so a
misconfigured database surfaces first; both must succeed before any port is bound.

```
db.SetUpDatabase()      → open pool, set limits, ping-with-retry, Migrate
api.RequireClerkJWTKey() → CLERK_JWT_KEY, else CLERK_JWT_KEY_FILE, else error
spacetraders.NewClient() → reads ST_GATEWAY_URL once
api.SetUpRouter(...)     → parses the PEM; fails here if the key is malformed
server.ListenAndServe()  → binds PORT (default 80)
```

**Migration order within `Migrate`:** create tables → widen columns → create indexes. Widening
must precede indexing so an index is never built on a column about to be rebuilt.

**A write request:** verify Clerk session → check scope → require game token → decode and
validate body → upstream call → persist → respond. The upstream call is the point of no
return; nothing after it may return an error status.

## Public surface

Changing any of these breaks a known consumer.

| Identifier | Consumer | Notes |
|---|---|---|
| `/api/agent/v1/*` route paths | command-interface, automation-service, fleet-service | The `/v1` prefix is the versioning story; new shapes go to `/v2` |
| `/health`, `/api/agent/health` | compose healthcheck, CloudFront | Both must stay; CloudFront only routes configured path patterns |
| `X-SpaceTraders-Token` header name | every caller | Also listed in `Access-Control-Allow-Headers`. **Scheduled for deletion** — see "Pending" below; do not build on it |
| `X-Priority` header name and the value `interactive` | command-interface | **No longer read by st-gateway.** Effectively dead; see "Pending" below |
| `fleet:control` scope string | Clerk session config, fleet-service | `SCOPEFleetControl` |
| `SHIP_PURCHASE`, `PURCHASE`, `SELL` | anything reading `GET /transactions` | Defined once in `db.TransactionTypes`; also the `?type=` filter's accepted values |
| JSON field names on `db.Transaction`, `db.Delivery`, `CurrentAgentResponse` | command-interface | |
| `{"error":{"message":…}}` auth envelope | shared with automation-service / fleet-service | |
| `POST /contracts/{id}/deliveries` request body | fleet-service | `{shipSymbol, tradeSymbol, units}` |

## Domain and upstream facts

* **st-gateway, not SpaceTraders.** Every outbound call goes to `ST_GATEWAY_URL + /proxy + <the
  SpaceTraders path>`. The gateway owns the shared rate budget (meta#1/meta#7). Calling
  SpaceTraders directly would bypass it and get the whole org rate-limited.
* **Priority queue (meta#37, superseded by decision 2).** The gateway *used to* read `X-Priority`;
  this service used to hardcode `interactive`, which let autopilot traffic jump the queue meant
  for the browser. st-gateway now derives priority from a verified Clerk identity and ignores the
  header — `st-gateway/src/__tests__/priority.test.ts` has a case named *"ignores a self-declared
  X-Priority: interactive header entirely"*. What this service sends is currently inert.
* **SpaceTraders wraps everything in `data`.** Hence the `…Response` structs whose only field is
  `Data`.
* **Accept and fulfil return the same shape** (`ContractAndAgent`), as do purchase-cargo and
  sell-cargo (`MarketTransactionResult`). That is why each pair shares one implementation.
* **Purchase and sell live here, not in fleet-service**, because they move credits and this
  service owns the transaction history.
* **Clerk verification is offline.** The RSA public key is supplied by configuration; there is
  no network call and no JWKS fetch, so Clerk being down does not affect this service.
* **`scope` may be a string or an array.** Clerk's default session token uses the space-delimited
  OAuth convention; `scopesFrom` accepts both so a dashboard formatting choice can't lock
  callers out.
* **Agent credits exceed `INT`.** Money columns are `BIGINT` for that reason.

## Testing

Three layers, none of which need a database, a network, or a container:

| Layer | Where | Harness |
|---|---|---|
| Router + handlers | `api/routes_test.go`, `api/auth_test.go` | `httptest` recorder against the real router, `sqlmock` for the DB, a stub gateway for upstream |
| Gateway client | `spacetraders/client_test.go` | `httptest.NewServer` standing in for st-gateway |
| Queries and migrations | `db/db_test.go` | `sqlmock`; migration tests assert the statement *sequence*, not the SQL dialect |

Shared helpers live in `api/authtest_test.go`: `newTestRouter`, `stubGateway`, `newMockDB`,
`doRequest`, and the token builders (`bearer`, `bearerWithoutScope`, `expiredBearer`,
`foreignBearer`). Tests exercise the real verification path — there is no bypass flag; only the
trust anchor differs, an RSA keypair generated once per test binary.

### Flake patterns

* **Never use `os.Setenv` / `os.Unsetenv` in a test.** Both previously leaked for the remainder
  of the binary, making results depend on the order Go happened to pick. Use `t.Setenv`, which
  restores on cleanup and fails the build if the test is parallel. The one deliberate exception
  is `TestGatewayURLEnvIsReadOnlyAtConstruction`, which mutates env *specifically* to prove the
  client ignores it afterwards.
* **Prefer injection to environment.** `SetUpRouter` and `NewClientWithBaseURL` take their
  dependencies as arguments precisely so tests don't have to touch global state.
* **Always `t.Cleanup` an `httptest.NewServer`.** `stubGateway` and `newStubGateway` do this.
* **sqlmock expectations are ordered.** Arm exactly the queries the request will make, and call
  `mock.ExpectationsWereMet()` when the point of the test is *which* query ran.
* **Don't assert on wall-clock timing.** `TestARequestThatNeverAnswersEventuallyFails` uses a
  100 ms client timeout against a 5 s ceiling — a two-orders-of-magnitude gap, not a race.

Run `-shuffle=on` locally before pushing; it is what catches order dependence.

## Extending things

* **A new upstream call:** add a method on `spacetraders.Client`, a response struct in
  `spacetraders/schema/`, then a handler. Do not add a second `http.Client`.
* **A new route:** register it in `SetUpRouter` through `read`/`write`, or bare with a comment
  saying why it needs no credential. Add the swagger annotations, then regenerate `docs/`.
* **A new transaction type:** add the constant and put it in `db.TransactionTypes` — the
  `?type=` filter, its validation error message and the Swagger enum all derive from that list.
* **A new table or column:** add the `CREATE TABLE IF NOT EXISTS` to `schema`, and if existing
  databases need changing, add a guarded entry to `widenedColumns` or `indexes`. Money columns
  are `BIGINT`; time columns are read back as UTC.
* **A new config value:** read it once at startup (in `main`, or a package's constructor), never
  per request, and add it to the README's configuration table.
* **A new tunable:** a named constant with a comment saying what it bounds, plus a row in the
  README's tunables table. Reach for an environment variable only when an environment actually
  needs a different value.

## Pending: increment 3 Stage 5

**This service is behind the platform, and parts of this file describe that lag rather than
the design.** `auth-service` and st-gateway token injection have shipped (auth-design.md
decision 5): st-gateway fetches the SpaceTraders credential from auth-service and *overwrites*
the caller's `Authorization` on every proxied call. Decision 18 is explicit that
`X-SpaceTraders-Token` "disappears entirely once decision 5's injection lands".

agent-service has not caught up. Three things here are therefore interim, not intended:

| What | Today | After Stage 5 |
|---|---|---|
| `X-SpaceTraders-Token` | Required by `requireGameToken`; 401 without it | Gone — the guard, the context value, and the header |
| `Authorization` sent to st-gateway | The game token; discarded upstream, and it fails Clerk verification there, so every call degrades to background priority | agent-service's own Clerk M2M token (decision 19) |
| `X-Priority` | Forwarded, normalised in `spacetraders.normalizePriority` | Gone — priority is derived from the verified identity |

`st-gateway/src/auth.ts` documents the same gap from the other side, calling it "an accepted
interim UX regression, not a bug".

**Do not build on the game-token path**, and do not treat invariants 2, 4 and 8 as durable.

---

Update this file in the same PR as the change it describes.
