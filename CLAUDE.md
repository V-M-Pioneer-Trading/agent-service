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
| Regenerate OpenAPI spec | `go generate ./...` (pinned swag, see `//go:generate` in `app-runner.go`; CI fails on drift) |
| Start MySQL only | `docker compose up -d mysql` (from repo root) |

CI runs format check, vet and the race/shuffle test suite on both pull requests and pushes to
`main`; the image build and deploy is gated on that job passing.

## The TypeScript port (`ts/`, meta#103 decision 23)

The Go service above is what deploys until the cutover (agent-service#38). `ts/` is its
strict 1:1 replacement, built in three PRs (#35 scaffold, #36 live reads, #37 writes and MySQL).
`.github/workflows/ts.yml` runs it; `container.yml` and `contract.yml` do not know it exists.

| Task (from `ts/`) | Command |
|---|---|
| Install | `npm ci --ignore-scripts` (never plain `npm ci`, never `npm install` in CI) |
| Typecheck / build / test | `npm run typecheck` / `npm run build` / `npm test` |
| Regenerate the OpenAPI spec | `npm run openapi` (CI fails on drift in `ts/openapi.json`) |
| Dependency allowlist | `npm run check:deps`; a new direct dependency needs a line in `allowed-dependencies.txt` |
| Contract suite against the port | `npm run build` then, from the repo root, `node ts/scripts/run-contract.js` (runs `contract/` unchanged with `CONTRACT_COMMAND`; set `CONTRACT_IMAGE` to use an image). It needs a MySQL: `CONTRACT_MYSQL_*` as in `contract/README.md`, and a fresh database for a port |

* **Skip list.** `ts/contract-skip.txt` is empty: every route is ported (#37), so the whole contract
  suite has to pass, bar the one case the suite skips itself (`dynamic-skips=1` in
  `ts/contract-skip.expected`: the swagger page names no spec URL because the spec is embedded in it).
  The mechanism stays: a listed pattern is a regex matched like `--test-skip-pattern` (against the
  space-joined describe and test names, or any ancestor's), `ts/scripts/run-contract.js` runs the whole
  suite unfiltered and judges it, a case off the list must pass, a case on it must not (bar the vacuous
  ones in `ts/contract-skip-passing.txt`), a pattern that matches nothing fails, and the measured numbers
  must equal `ts/contract-skip.expected`. Never add a line for a case that fails for another reason,
  and never edit `contract/` to make the port pass.
* **Auth.** Routes are declared in `ts/src/auth.ts` (`routePolicy`, the TS twin of
  `SetUpRouter`); tsoa's generated routes are registered through `declaring()`, which puts the
  clerk-client declaration first and refuses to start on a route with no entry. The app is also
  `secured()`, so a route registered anywhere else without a declaration refuses startup too.
  `AUTH_INTROSPECTION_*` are validated in `ts/src/config.ts` as Go does (Go 1.25.x's `TrimSpace`
  and patched `url.Parse`; every verdict is recorded in `config.test.ts`) and, on purpose stricter
  than Go, the URL must be fetch-identical: clerk-client calls `fetch(url)`, and WHATWG URL rewrites
  or rejects URLs Go sends as written. clerk-client's own loader is not used.
* **HTTP artefacts.** `ts/src/http/muxCompat.ts` reproduces gorilla/mux and net/http (400 on a
  bad escape, 301 path cleaning, decoded-path routing, bare 405 / `404 page not found`), before
  any Express default; `json.ts` writes Go's `application/json` (no charset), `cors.ts` Go's four
  constant headers. Express runs case sensitive and strict (no trailing slash). No body parser is
  mounted: the route PRs read bodies themselves with the Go decoder's semantics (contract README
  notes 19-30: int64 beyond 2^53 kept exact, RFC 3339 normalisation, case-insensitive member names,
  one JSON value then the rest ignored, Content-Type never checked, 1 MiB cap, validation before any
  gateway call but after auth). `express.json()` and tsoa's own body validation would answer first.
* **Gateway errors.** `ts/src/gateway/errors.ts` is the mapping for st-gateway's answers; the
  fixture (`contract/fixtures/gateway-errors.json`, pinned) is driven through it by
  `gatewayErrors.test.ts`. Failures are thrown (`UpstreamError`, `UnreadableAnswer`) and relayed by
  the app error handler in `server.ts`.
* **Live reads (#36).** `ts/src/gateway/client.ts` is the only outbound HTTP: `GatewayClient`, redirects
  followed by hand like Go (10 requests, then 504; `fetch`'s own follow would stop at 20 and strip
  Authorization on any origin change). Authorization goes only to the original host or a subdomain, and
  once a hop has left that domain it stays off, also if a later hop comes back (Go 1.24, CVE-2024-45336);
  hosts compare as written, case included, and Authorization goes only where Go's reading of the
  `Location` and the URL that is actually fetched both say it may. `gateway/location.ts` reads a `Location`
  like `url.Parse` and then hands fetch a URL assembled from the parts Go's rules give
  (`scheme://host/path?query`), never the reference itself, because WHATWG reads several of them differently
  (`///evil/x` is a host to it and a path to Go; `https:/evil/x` is a host to it and an error to Go). Refused
  (so the call is a 504): a bad `%` in path, host or fragment, control characters, a colon in the first
  segment of a scheme-less reference, a bad port, a scheme other than http(s), a scheme with no host, userinfo.
  A backslash is a path character (`%5C`); a byte above 0x7f is escaped once, as bytes. A caller who hangs up
  cancels the
  call (`CallerGone`, nothing is answered or logged as a gateway failure) and `/current-agent` makes no
  further calls. Answers are decoded by `gateway/decode.ts` (schemas in `gateway/schema.ts`, member for
  member like `src/spacetraders/schema`) on top of the lossless parser `gateway/json.ts`: int64 is bigint, a
  missing list is null (a JSON null resets a list, and nothing else), names fold like Go's, and the same
  schema decodes gateway error envelopes. No dependency was added for any of this.
  * **Times** follow Go 1.25's lenient `time.Parse`, not the strict RFC 3339 check: a one-digit hour, a comma
    before the fraction, a zone offset with minute 60 or hour 24 are read, and written back with the offset
    recomputed (`+00:60` is `+01:00`). An offset of a day or more is read but Go's encoder refuses it, so the
    answer is **200, `application/json`, empty body** (`UnencodableTime`, `hasUnencodable`).
  * **Stricter than Go, on purpose:** when the gateway host is a single label (`st-gateway`) or an IP literal,
    only that exact host gets Authorization (no `x.st-gateway`: a DNS search domain could resolve it
    elsewhere); and a hop from https to http never carries it, on any host.
  * **Known deviations in following a redirect** (each is path-only on the same host, or refuses where Go
    requests; none can send Authorization anywhere Go would not): userinfo in a `Location` is refused (Go
    would send Basic credentials; nothing here forwards credentials to a redirect target); `%2e`/`%2E`
    segments are resolved as dot segments by WHATWG, Go leaves them; a relative path that starts with `%2f` is
    absolute to Go, relative here; spaces and non-ASCII in the query are percent-encoded, Go sends them raw;
    an IPv4 shorthand host (`2130706433`) is normalised by WHATWG; an IPv6 zone is refused; non-ASCII hosts go
    through UTS 46, Go's IDNA tables; repeated `Location` headers are read as the text up to the first `", "`
    (fetch joins them), so a single Location holding a comma and a space is cut there; Go sends
    `Content-Type` on the GET that follows a 301/302/303 of a POST, and so does this client now (#37; a call that had no
    body, accept and fulfill, has none to send).
  * **Writing** is in pieces (`http/json.ts` `sendJson`), so an answer too big for one string still goes out.
  * **Known deviation (stale slice).** Go decodes a repeated key into the earlier slice, and a slice that was
    shrunk by an earlier repeat leaks old elements when a third repeat grows it again
    (`"modules":[a,b],"modules":[c],"modules":[{},{}]` keeps `b` in Go). Here the third repeat starts from the
    second. Only three or more repeats of one list key, with the middle one shorter, can tell. Not
    reproduced on purpose.
  * The controllers write their answers themselves (`controllers/support.ts`): tsoa would 204 a null list and
    cannot print a bigint. `controllers/models.ts` is the spec's view of the same shapes, and a type
    assertion there fails the build if it drifts from the decoder. Path symbols are read from
    `lastSegmentOf(req)` (the exact decoded bytes, kept by muxCompat) and re-escaped with `pathEscape`, so
    bytes that are not UTF-8 survive; a variable followed by a literal (`/ships/{shipSymbol}/sell`) is
    `segmentFromEnd(req, 1)`.
* **Writes, history and Swagger (#37).** The six `fleet:control` POSTs are in `controllers/contracts.controller.ts`
  and `ships.controller.ts`, the two public DB reads in `history.controller.ts`.
  * **Bodies and queries are read by the handlers**, never by Express or tsoa. `http/body.ts` is Go's
    `json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode`: the first JSON value, the rest never read
    (`parseFirstJson`), Content-Type never looked at, a value cut short by the cap is `http: request body too
    large`; `decodeFirstValue` binds it with the gateway decoder's rules (names fold, last repeat wins, `null` is
    a no-op, int64 exact), and a refusal is the 400 `invalid request body: <why>` (the wording is ours bar
    `EOF`, `unexpected EOF` and the cap's). `http/query.ts` is `r.URL.Query()` and `strconv.Atoi`; Express'
    query parser is switched off (`app.set("query parser", false)`) so that tsoa's `@Query()` parameters, which
    exist only to document the route in OpenAPI, always see nothing and validate nothing; the same goes for the
    optional `@Body()` parameters (no body parser is mounted, `request.body` is undefined). `writes.test.ts`
    pins that tsoa never answers first. Validation comes after auth and before any gateway call.
  * **MySQL** is `mysql2` with raw SQL and no ORM; `db/sql.ts` is the only module that imports it and is the
    only door (`Sql`), which the unit tests replace with `testSupport/fakeSql.ts` (the sqlmock of the TS tests).
    Statements run prepared. The session is UTC (`SET time_zone='+00:00'` on each new connection) and times are
    sent as UTC text, microseconds truncated like the Go driver (`db/time.ts`); MySQL rounds a TIMESTAMP(0) and
    refuses what is outside 1970..2038 itself. BIGINT comes back as a string (`supportBigNumbers` +
    `bigNumberStrings`) and goes in as decimal text, so nothing passes through a double; a `LIMIT` is sent as
    text for the same reason. Pool: 10 connections, 10 idle, none older than 3 minutes (checked when a connection
    is taken: mysql2 has no lifetime), 15 pings 2 s apart at startup, all before any port is bound.
    `db/migrate.ts` is `src/db/db.go`'s DDL statement for statement, and `db.test.ts` compares the two while that file exists.
  * **History is best effort** (`persistence.ts`, invariant 5): a failed write is logged and the answer still goes
    out. Cargo trades take the ship from the path, a ship purchase from the answer, `occurredAt` from the answer
    or now when it is the zero time; an empty 2xx records a zero row. A path symbol that is not UTF-8 cannot be a
    JavaScript string, so it is a refused insert (what MySQL says to Go) and a query parameter is passed as bytes.
  * **Swagger UI** is `swagger-ui-express` over the committed `ts/openapi.json` (copied next to `dist/` in the
    image), mounted by `swagger.ts`. `/api/agent/swagger` without the slash stays `404 page not found`, as does
    any method but GET and HEAD. Accepted deviations (owner, 2026-10-03; contract note 7 pins reachability only):
    the slash path serves the page itself instead of http-swagger's redirect to `index.html`, `HEAD` is served
    (Go: 405), the spec is embedded in `swagger-ui-init.js` (Go: `doc.json`), and the static files carry
    `express.static`'s headers.
  * **Known deviations from Go**: the pool's lifetime is checked at checkout; `deliveredAt` has the precision of a
    JavaScript clock (milliseconds, Go nanoseconds); an over-long body is read and discarded where Go closes the
    connection; MySQL's error text in a 500 body or a log line is mysql2's, not go-sql-driver's (`Error 1406
    (22001): ...`); forwarded JSON is not HTML-escaped (`<` is not `<`; the same after parsing).

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
  one string, split on runs of space, tab, CR and LF only (fixture v6); it is ABSENT for a
  scopeless session (auth-service encodes it `omitempty`), which is the empty list, not a
  malformed answer.
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
| Introspection contract | `introspection/conformance_test.go`, `introspection/center_test.go` | All 51 calling-service cases of `introspection/testdata/introspection.json` — a **verbatim copy** of `meta/fixtures/introspection.json`, pinned by sha256 in `testdata/SOURCE.txt` and `-text` in `.gitattributes` — against a real `httptest` center; the 14 gateway cases are skipped by name with a count assertion. Unknown fixture keys fail |
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
  swagger annotations, then regenerate `docs/` (`go generate ./...`). A mutating route cannot be `public`.
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
