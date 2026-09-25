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
| Run locally | `PORT=8080 AUTH_INTROSPECTION_URL=http://localhost:8082/auth/v1/introspect AUTH_INTROSPECTION_SECRET=local-dev-introspection-secret go run .` |
| Regenerate Swagger | `swag init -g app-runner.go --parseInternal --output ./docs` |
| Start MySQL only | `docker compose up -d mysql` (from repo root) |

CI runs format check, vet and the race/shuffle test suite on both pull requests and pushes to
`main`; the image build and deploy is gated on that job passing.

## Module map

| File | Owns | Depends on |
|---|---|---|
| `src/app-runner.go` | Process lifecycle: config read, dependency construction, HTTP server, Swagger's top-level annotations | `api`, `db`, `introspection`, `spacetraders` |
| `src/api/routes.go` | Route table, access tiers, handlers, request/response shaping, `forwardCallerSession` | `db`, `introspection`, `spacetraders`, `spacetraders/schema`, `docs` (blank) |
| `src/api/auth.go` | The mux adapter: `secureRouter` (startup walk + request-time `refuseUndeclared`), `getRoute`/`postRoute`, the `authError` Swagger type | `introspection`, `gorilla/mux` |
| `src/introspection/policy.go` | The decision 21 policy: `Requirement` (`None`/`Session`/`Scope`, zero value = undeclared), `BearerFrom`, `IsSafeMethod`, `Authorizer`, the five messages | stdlib |
| `src/introspection/center.go` | The one call to auth-service (`Client`), answer parsing, `LoadConfig` for `AUTH_INTROSPECTION_*` | stdlib |
| `src/introspection/http.go` | net/http middleware: `Guard.Require`, `IgnoreCredentials`, `DeclarationOf`, `IdentityFrom`, the error envelope | stdlib |
| `src/spacetraders/client.go` | The only outbound HTTP in the service; gateway address, timeout, path escaping, and the `WithCallerAuthorization` context helpers | `spacetraders/schema` |
| `src/spacetraders/errors.go` | `UpstreamError`: st-gateway's status, its message, its pacing headers, and the endpoint for the log line | — |
| `src/spacetraders/schema/` | Wire types for the SpaceTraders API | — |
| `src/db/db.go` | DSN, pool, startup wait, `Migrate` | `go-sql-driver/mysql` |
| `src/db/transactions.go` | `TransactionType` enum, transaction row read/write | stdlib |
| `src/db/contracts.go` | Contract upsert, delivery row read/write | stdlib |
| `src/docs/` | **Generated.** Never hand-edit | — |

### Dependency rules

* `db`, `spacetraders` and `introspection` never import `api`. `introspection` imports nothing from this module.
* `db` never imports `spacetraders` and vice versa. They are joined only in `api` handlers.
* `spacetraders/schema` imports nothing from this module — it is pure wire types.
* Only `spacetraders/client.go` and `introspection/center.go` make outbound HTTP calls. If you
  need a new upstream call, add a method on `spacetraders.Client` rather than a `http.Get` in a
  handler.
* Only `db` writes SQL. Handlers call named functions, never build queries.
* Nothing in this module parses, decodes or logs a token, or logs the introspection secret. No
  JWT library is a dependency, in code or in tests.

## Invariants

Stated so a violation is recognisable in review:

1. **No SpaceTraders credential exists in this service.** Not as a header, a context value,
   a parameter or a field. st-gateway injects it (auth-design.md decision 5). Anything that
   reintroduces one is a regression, not a feature.
2. **`Authorization` is always the Clerk session, and it is forwarded verbatim.** It is read
   in exactly two places: the introspection guard (`introspection/http.go`), and
   `forwardCallerSession`, which puts it on the
   request context for the spacetraders client to relay to st-gateway (decision 2). A handler
   that reads `Authorization` directly is wrong.
3. **The access tier is declared at the router, never inside a handler.** Every route in
   `SetUpRouter` goes through `read(…)`, `write(…)`, `public(…)` or `ignore(…)`. A bare
   handler is refused: `secureRouter` fails startup for an undeclared route, or for a route
   answering a mutating method (or every method) that declares `none` or ignores credentials,
   and `refuseUndeclared` answers `500` for one added after the walk. Register reads with
   `getRoute` (GET + HEAD on one route object) and mutations with `postRoute`.
   `TestEveryRouteDeclaresExactlyThisPolicy` pins the whole table.
4. **Every SpaceTraders-backed route sits behind `read(…)` or `write(…)`**, both of which
   wrap `forwardCallerSession`. A route wired without them silently sends st-gateway no
   session, and every call from it lands in the background lane.
5. **History writes never fail a request.** The upstream call has already changed game state
   that cannot be rolled back. `persistTransaction` / `persistContract` log and return.
6. **List endpoints return `[]`, never `null`.** `ListTransactions` and
   `GetDeliveriesForContract` initialise their slices. A `var xs []T` in either is a regression.
7. **`Migrate` is idempotent and runs on every boot.** Any statement added there must either be
   `IF NOT EXISTS` or guarded by an `information_schema` check.
8. **Every path segment sent upstream is `url.PathEscape`d.** Symbols come straight from
   `mux.Vars`; an unescaped `../` steers the gateway at a different proxy path.
9. **`SetUpRouter` returns an error rather than exiting.** Only `main` calls `log.Fatal`.
10. **This service decides one upstream verdict and relays the rest.** "st-gateway did not
    answer me" is a `504` and is genuinely its own observation; every status the gateway
    *did* send is relayed unchanged, with the gateway's `error.message` and its pacing
    headers. `502` means only "answered with something this service could not decode".
    An unreachable gateway used to escape as a bare transport error and render as an
    undifferentiated `502`, indistinguishable from `503 SpaceTraders credential not
    configured` — the one message that says an operator must act rather than wait. The
    rule is normative across all three gateway clients:
    `meta/docs/design/upstream-errors.md`.
11. **`UpstreamError.Message` is the upstream's own sentence and nothing else.** No
    `"GET /my/agent:"` prefix — handlers write it straight to the caller, so matching on it
    downstream has to mean the same thing whichever service relayed it. Where the call
    happened goes in `Endpoint`, and a 504's transport error goes in `Err` (reachable via
    `errors.Is`); both are for the log line `writeUpstreamError` writes, never for the
    caller. The transport error names the internal gateway address, which is not a
    caller's business.
12. **A caller that hangs up is not a gateway failure.** `request` checks `ctx.Err()`
    before reaching for the 504, so an abandoned request does not put a gateway outage in
    the logs. Nobody is left to read the answer either way.
13. **One question to auth-service per request, and no other verification path.** 1 s timeout,
    no retry, no cache, no redirect, no proxy, body capped at 64 KiB. Every failure is the
    one `503`. A bad token is a `401` on every method, never a visitor. `kind` is the
    center's answer, never derived from `sub`. Scopes match by exact membership only.

## Critical sequences

**Startup — the order matters.** `main` reads the introspection config *before* the database
wait: it is instant, and a missing `AUTH_INTROSPECTION_*` must crash the container inside the
bootstrap script's ~30 s liveness window rather than after a slow MySQL ping loop. All of it
must succeed before any port is bound.

```
introspection.LoadConfig(os.Getenv) → AUTH_INTROSPECTION_URL + _SECRET, else error naming the var
db.SetUpDatabase()                  → open pool, set limits, ping-with-retry, Migrate
spacetraders.NewClient()            → reads ST_GATEWAY_URL once
api.SetUpRouter(...)                → secureRouter; fails here on an undeclared route
server.ListenAndServe()             → binds PORT (default 80)
```

**Migration order within `Migrate`:** create tables → widen columns → create indexes. Widening
must precede indexing so an index is never built on a column about to be rebuilt.

**A write request:** ask auth-service (once) → check scope → put the session on the context →
decode and validate body → upstream call (session forwarded) → persist → respond. The upstream call is the point of no
return; nothing after it may return an error status.

## Public surface

Changing any of these breaks a known consumer.

| Identifier | Consumer | Notes |
|---|---|---|
| `/api/agent/v1/*` route paths | command-interface, automation-service, fleet-service | The `/v1` prefix is the versioning story; new shapes go to `/v2` |
| `/health`, `/api/agent/health` | compose healthcheck, CloudFront | Both must stay; CloudFront only routes configured path patterns |
| `Authorization` forwarded verbatim to st-gateway | st-gateway's priority derivation | A human session lands in the interactive lane; a machine token in background |
| `fleet:control` scope string | Clerk session config, fleet-service | `SCOPEFleetControl` |
| `SHIP_PURCHASE`, `PURCHASE`, `SELL` | anything reading `GET /transactions` | Defined once in `db.TransactionTypes`; also the `?type=` filter's accepted values |
| JSON field names on `db.Transaction`, `db.Delivery`, `CurrentAgentResponse` | command-interface | |
| `{"error":{"message":…}}` auth envelope | shared with automation-service / fleet-service | |
| `POST /contracts/{id}/deliveries` request body | fleet-service | `{shipSymbol, tradeSymbol, units}`; needs `fleet:control` since meta#71 |
| `AUTH_INTROSPECTION_URL`, `AUTH_INTROSPECTION_SECRET`, `X-Introspection-Secret` | infrastructure `agent-service/main.tf`, meta compose, auth-service | Names fixed by `meta/fixtures/introspection.json` |
| The five auth sentences and their statuses | command-interface, automation-service's classifier | `introspection.Message*` |

## Domain and upstream facts

* **st-gateway, not SpaceTraders.** Every outbound call goes to `ST_GATEWAY_URL + /proxy + <the
  SpaceTraders path>`. The gateway owns the shared rate budget (meta#1/meta#7). Calling
  SpaceTraders directly would bypass it and get the whole org rate-limited.
* **Priority is the gateway's call (decision 2).** st-gateway derives it from the Clerk session
  this service forwards: an operator is interactive, anything else (automation-service's
  machine token, no session) is background. This service never declares a priority; the
  old `X-Priority` header is ignored by the gateway and no longer sent.
* **SpaceTraders wraps everything in `data`.** Hence the `…Response` structs whose only field is
  `Data`.
* **Accept and fulfil return the same shape** (`ContractAndAgent`), as do purchase-cargo and
  sell-cargo (`MarketTransactionResult`). That is why each pair shares one implementation.
* **Purchase and sell live here, not in fleet-service**, because they move credits and this
  service owns the transaction history.
* **auth-service verifies, this service asks (decision 21).** `POST` form `token=` to
  `AUTH_INTROSPECTION_URL` verbatim, `X-Introspection-Secret` header. The answer's `scope` is
  one string, split on whitespace runs; it is ABSENT for a scopeless session (auth-service
  encodes it `omitempty`), which is the empty list, not a malformed answer.
* **Agent credits exceed `INT`.** Money columns are `BIGINT` for that reason.
* **MySQL is `mysql:9`, in compose and in production alike** (`infrastructure/agent-service/main.tf`).
  Both track the latest 9.x on purpose — minor upgrades are safe in place, and the tag still
  blocks a silent jump to a future major. Do not pin one side to a different major: MySQL
  refuses to start against a data directory written by a newer server, so pinning local dev
  *down* (to 8.4, say) breaks any developer whose volume was created by 9.x, and pinning it
  *up* hides version-specific behaviour until production meets it. `mysql_native_password` was
  removed in 9, so neither side sets `MYSQL_NATIVE_PASSWORD`; the Go driver authenticates with
  `caching_sha2_password`, requesting the server's public key itself over plaintext TCP.

## Testing

Five layers, none of which need a database, an external network, or a container:

| Layer | Where | Harness |
|---|---|---|
| Router + handlers | `api/routes_test.go`, `api/auth_test.go` | `httptest` recorder against the real router, `sqlmock` for the DB, a stub gateway for upstream, a stub auth-service on loopback |
| Introspection contract | `introspection/conformance_test.go`, `introspection/center_test.go` | All 37 calling-service cases of `introspection/testdata/introspection.json` — a **verbatim copy** of `meta/fixtures/introspection.json`, pinned by sha256 in `testdata/SOURCE.txt` and `-text` in `.gitattributes` — against a real `httptest` center; the 11 gateway cases are skipped by name with a count assertion. Unknown fixture keys fail |
| Gateway client | `spacetraders/client_test.go` | `httptest.NewServer` standing in for st-gateway |
| Upstream-error contract | `api/gateway_errors_conformance_test.go` | A subtest per condition, driven from `spacetraders/testdata/gateway-errors.json` — a **verbatim copy** of `meta/fixtures/gateway-errors.json`. Change meta first, then re-copy, or the copy is just a local opinion. It runs through the router rather than the client, because the contract is about what a caller receives: a 2xx body this service cannot decode never becomes an `*UpstreamError` at all, and it is the handler that turns it into the 502 |
| Queries and migrations | `db/db_test.go` | `sqlmock`; migration tests assert the statement *sequence*, not the SQL dialect |

Shared helpers live in `api/authtest_test.go`: `newTestRouter` / `newTestRouterWithCenter`,
`stubGateway`, `newMockDB`, `doRequest`, `deadCenterURL`, and the bearer builders (`bearer`,
`bearerWithoutScope`, `machineBearer`, `inactiveBearer`). Tests sign nothing: the tokens are
opaque strings a stub auth-service answers for, over real HTTP through the real client.

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
* **A new route:** register it in `SetUpRouter` with `getRoute`/`postRoute` through `read`,
  `write`, `public` or `ignore`, add it to `TestEveryRouteDeclaresExactlyThisPolicy`, add the
  swagger annotations, then regenerate `docs/`. A mutating route cannot be `public`.
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

---

Update this file in the same PR as the change it describes.
