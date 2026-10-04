# CLAUDE.md

Contributor and agent notes for agent-service. The README explains what the service is and
why; this file is what you need to change it safely.

The service is TypeScript (Node 24, Express 4, tsoa, mysql2). It replaced a Go implementation
at the cutover (agent-service#38, meta#103, auth-design.md decision 23), and its behaviour is
pinned to that implementation's by the black-box suite in `contract/`. Many comments say
"like Go"; read them as "as the contract suite pins it", and never edit `contract/` to make
code pass.

## Commands

| Task | Command |
|---|---|
| Install | `npm ci --ignore-scripts` (never plain `npm ci`, never `npm install` in CI) |
| Typecheck / build / test | `npm run typecheck` / `npm run build` / `npm test` |
| Real-MySQL integration test | `TEST_MYSQL_HOST=127.0.0.1 npm test` (CI does; `docker compose up -d mysql` locally) |
| Regenerate the OpenAPI spec | `npm run openapi` (CI fails on drift in `openapi.json`) |
| Dependency allowlist | `npm run check:deps`; a new direct dependency needs a line in `allowed-dependencies.txt` |
| Contract suite against this build | `npm run build`, then `node scripts/run-contract.js` (runs `contract/` unchanged with `CONTRACT_COMMAND`; set `CONTRACT_IMAGE` to use an image). Needs a MySQL: `CONTRACT_MYSQL_*` as in `contract/README.md`, and a fresh database |
| Production probe | `node scripts/cutover-probe.mjs --dry-run` lists the checks; a real run needs `OPERATOR_TOKEN` (see the script header). Prints status codes and member names only, never a token. `cutoverProbe.test.ts` runs it against a stub |
| Run locally | `PORT=8080 AUTH_INTROSPECTION_URL=http://localhost:8082/auth/v1/introspect AUTH_INTROSPECTION_SECRET=local-dev-introspection-secret npm start` (after `npm run build`) |
| Start MySQL only | `docker compose up -d mysql` |

CI is `.github/workflows/container.yml`. Required checks on `main` (enforce_admins on):
`test`, `image`, `contract`. A job must keep exactly those names. The deploy job (`docker`)
needs `test`, builds the root `Dockerfile` for arm64, and only on the tip of `main` tags
`:latest` and redeploys through SSM; a `v*` tag pushes `sha-<tip>` and deploys nothing.

* **Skip list.** `contract-skip.txt` is empty: the whole contract suite runs and has to pass, bar the
  one case the suite skips itself (`dynamic-skips=1` in `contract-skip.expected`: the swagger page
  names no spec URL because the spec is embedded in it). The mechanism stays: a listed pattern is a
  regex matched like `--test-skip-pattern`, `scripts/run-contract.js` runs the whole suite unfiltered
  and judges it, a case off the list must pass, a case on it must not (bar the vacuous ones in
  `contract-skip-passing.txt`), a pattern that matches nothing fails, and the measured numbers must
  equal `contract-skip.expected`. Never add a line for a case that fails for another reason.
* **Auth.** Routes are declared in `src/auth.ts` (`routePolicy`); tsoa's generated routes are
  registered through `declaring()`, which puts the clerk-client declaration first and refuses to start
  on a route with no entry. The app is also `secured()`, so a route registered anywhere else without a
  declaration refuses startup too. `AUTH_INTROSPECTION_*` are validated in `src/config.ts` (the verdicts
  are recorded in `config.test.ts`) and the URL must be fetch-identical: clerk-client calls
  `fetch(url)`, and WHATWG URL rewrites or rejects URLs the old implementation sent as written.
  clerk-client's own loader is not used.
* **HTTP artefacts.** `src/http/muxCompat.ts` reproduces gorilla/mux and net/http (400 on a bad escape,
  301 path cleaning, decoded-path routing, bare 405 / `404 page not found`), before any Express default;
  `json.ts` writes `application/json` with no charset, `cors.ts` four constant headers. Express runs case
  sensitive and strict (no trailing slash). No body parser is mounted: handlers read bodies themselves
  (contract README notes 19-30: int64 beyond 2^53 kept exact, RFC 3339 normalisation, case-insensitive
  member names, one JSON value then the rest ignored, Content-Type never checked, 1 MiB cap, validation
  before any gateway call but after auth). `express.json()` and tsoa's own body validation would answer first.
* **Gateway errors.** `src/gateway/errors.ts` is the mapping for st-gateway's answers; the fixture
  (`contract/fixtures/gateway-errors.json`, pinned by sha256, a copy of `meta/fixtures/gateway-errors.json`)
  is driven through it by `gatewayErrors.test.ts`. Failures are thrown (`UpstreamError`,
  `UnreadableAnswer`) and relayed by the app error handler in `server.ts`.
* **Gateway client.** `src/gateway/client.ts` is the only outbound HTTP: `GatewayClient`, redirects
  followed by hand (10 requests, then 504; `fetch`'s own follow would stop at 20 and strip Authorization
  on any origin change). Authorization goes only to the original host or a subdomain, and once a hop has
  left that domain it stays off, also if a later hop comes back (CVE-2024-45336); hosts compare as
  written, and Authorization goes only where both `gateway/location.ts`'s reading of the `Location` and
  the URL actually fetched say it may. `location.ts` reads a `Location` like Go's `url.Parse` and hands
  fetch a URL assembled from the parts (`scheme://host/path?query`), never the reference itself, because
  WHATWG reads several of them differently. A caller who hangs up cancels the call (`CallerGone`: nothing
  is answered or logged as a gateway failure) and `/current-agent` makes no further calls. Answers are
  decoded by `gateway/decode.ts` (schemas in `gateway/schema.ts`) on top of the lossless parser
  `gateway/json.ts`: int64 is bigint, a missing list is null, names fold like Go's. Stricter than the old
  implementation, on purpose: with a single-label or IP-literal gateway host only that exact host gets
  Authorization, and a hop from https to http never carries it. Times follow Go 1.25's lenient
  `time.Parse` (see `decode.ts`); an offset of a day or more is read but unencodable, and the answer is
  200 with an empty body (`UnencodableTime`). Known redirect deviations are listed in the contract README.
* **Controllers** write their answers themselves (`controllers/support.ts`): tsoa would 204 a null list and
  cannot print a bigint. `controllers/models.ts` is the spec's view of the same shapes, and a type
  assertion there fails the build if it drifts from the decoder. Path symbols are read from
  `lastSegmentOf(req)` (the exact decoded bytes, kept by muxCompat) and re-escaped with `pathEscape`, so
  bytes that are not UTF-8 survive; a variable followed by a literal (`/ships/{shipSymbol}/sell`) is
  `segmentFromEnd(req, 1)`.
* **Bodies and queries are read by the handlers**, never by Express or tsoa. `http/body.ts` takes the first
  JSON value (`parseFirstJson`), never looks at Content-Type, answers `http: request body too large` past
  the cap; `decodeFirstValue` binds it with the gateway decoder's rules, and a refusal is the 400
  `invalid request body: <why>`. `http/query.ts` reads the query; Express' query parser is switched off
  (`app.set("query parser", false)`) so tsoa's `@Query()` parameters, which only document the route in
  OpenAPI, see nothing and validate nothing; the same goes for the optional `@Body()` parameters.
  `writes.test.ts` pins that tsoa never answers first. Validation comes after auth and before any gateway call.
* **MySQL** is `mysql2` with raw SQL and no ORM; `db/sql.ts` is the only module that imports it and the only
  door (`Sql`), which unit tests replace with `testSupport/fakeSql.ts`. Statements run prepared. The session
  is UTC (`SET time_zone='+00:00'` on each new connection) and times are sent as UTC text, microseconds
  truncated (`db/time.ts`); MySQL rounds a TIMESTAMP(0) and refuses what is outside 1970..2038 itself.
  BIGINT comes back as a string (`supportBigNumbers` + `bigNumberStrings`) and goes in as decimal text, so
  nothing passes through a double; a `LIMIT` is sent as text for the same reason. Pool: 10 connections, 10
  idle, none older than 3 minutes (checked at checkout), 15 pings 2 s apart at startup, all before any port is
  bound. `db/migrate.ts` is the schema, shared unchanged with the earlier implementation (a rollback to it
  must keep working).
* **The server** is `http.createServer` with `connectionsCheckingInterval: 1000` (Node's default of 30 s
  makes the 10 s header timeout 10 to 40 s) and `headersTimeout`/`requestTimeout`; an answer that leaves the
  request body unread closes the connection (`closeWhenBodyUnread`: no listener on the socket, which would
  detach it from the parser and wedge a connection other callers share behind a proxy). A caller that is too
  slow is closed without a 408. `100 Continue` is sent by `http/body.ts` when a handler starts reading. The
  five Swagger assets are read into memory at startup and answered from there (a file stream per response
  blows memory up when a caller pipelines requests and never reads). `connections.test.ts` pins both on real
  sockets; `mysql.integration.test.ts` runs against a real MySQL with the server's global time zone moved to
  +05:00, so a session not pinned to UTC fails in behaviour. Node's heap still grows under pipelining
  clients: the memory cap is the host's (`--memory` in infrastructure's bootstrap document).
* **History is best effort** (`persistence.ts`, invariant 5): a failed write is logged and the answer still
  goes out. Cargo trades take the ship from the path, a ship purchase from the answer, `occurredAt` from the
  answer or now when it is the zero time; an empty 2xx records a zero row. A path symbol that is not UTF-8
  cannot be a JavaScript string, so it is a refused insert and a query parameter is passed as bytes.
* **Swagger UI** is `swagger-ui-express` over the committed `openapi.json` (copied next to `dist/` in the
  image), mounted by `swagger.ts`. `/api/agent/swagger` without the slash is `404 page not found`, as is any
  method but GET and HEAD. The slash path serves the page itself, `HEAD` is served, the spec is embedded in
  `swagger-ui-init.js`. Only our page, `swagger-ui-init.js` and the files in `ASSETS` are served;
  swagger-ui-dist's own `index.html` and `swagger-initializer.js` (the Petstore demo) are `404`.
* **Known deviations** from the old implementation: `deliveredAt` has millisecond precision; MySQL's error text
  in a 500 body or log line is mysql2's; forwarded JSON is not HTML-escaped; three or more repeats of one list
  key with a shorter middle one decode differently (stale-slice quirk, not reproduced).

## Module map

| File | Owns | Depends on |
|---|---|---|
| `src/server.ts` | Process lifecycle: config read, dependency construction, HTTP server, error handler, Swagger mount | everything below |
| `src/config.ts` | Environment variables and their validation; `AUTH_INTROSPECTION_*` | stdlib |
| `src/auth.ts` | `routePolicy` (the authorization table), `declaring()`, `secured()`, `fleet:control` | clerk-client |
| `src/controllers/*.controller.ts` | The routes, tsoa-annotated; they shape requests and responses | `gateway`, `db`, `persistence` |
| `src/controllers/support.ts`, `models.ts` | Answer writers, path-symbol helpers; the spec's view of the shapes | `http`, `gateway` |
| `src/gateway/` | The only outbound HTTP to st-gateway: `client.ts`, `decode.ts`, `schema.ts`, `json.ts`, `location.ts`, `errors.ts` | stdlib |
| `src/db/` | `sql.ts` (mysql2 door), `setup.ts` (startup wait), `migrate.ts` (DDL), `history.ts` (rows), `time.ts` | `mysql2` |
| `src/persistence.ts` | Best-effort history writes after the game confirms | `db` |
| `src/http/` | muxCompat, body, query, json, cors | stdlib |
| `src/swagger.ts` | Swagger UI over `openapi.json` | `swagger-ui-express` |
| `src/generated/` | **Generated** by tsoa (`npm run codegen`); never hand-edit, not committed | — |
| `openapi.json` | **Generated** and committed; `npm run openapi` | — |
| `contract/` | The black-box suite (own `package.json`); never edited to make code pass | — |

### Dependency rules

* `db`, `gateway` and `http` never import `controllers`. `db` and `gateway` never import each other; they are
  joined only in controllers and `persistence.ts`.
* Only `gateway/client.ts` and clerk-client make outbound HTTP calls. A new upstream call is a method on
  `GatewayClient`, not a `fetch` in a handler.
* Only `db` writes SQL. Handlers call named functions, never build queries.
* Nothing in this module parses, decodes or logs a token, or logs the introspection secret. No JWT library is
  a dependency, in code or in tests.
* Direct dependencies are exactly `allowed-dependencies.txt`, installed with `--ignore-scripts`.

## Invariants

Stated so a violation is recognisable in review:

1. **No SpaceTraders credential exists in this service.** Not as a header, a parameter or a field. st-gateway
   injects it (auth-design.md decision 5). Anything that reintroduces one is a regression, not a feature.
2. **`Authorization` is always the Clerk session, and it is forwarded verbatim.** It is read in exactly two
   places: clerk-client's guard, and the gateway call that relays the caller's header to st-gateway (decision 2).
   A handler that reads `Authorization` directly is wrong.
3. **The access tier is declared in `routePolicy`, never inside a handler.** A route with no entry refuses
   startup; a route answering a mutating method that declares `none` or ignores credentials refuses startup; a
   route added outside tsoa without a declaration refuses startup too. `policy.test.ts` pins the whole table
   against `openapi.json`.
4. **Every SpaceTraders-backed route is `session` or a scope**, and relays the caller's session. A route that
   sends st-gateway no session lands every call in the background lane.
5. **History writes never fail a request.** The upstream call has already changed game state that cannot be
   rolled back. `persistence.ts` logs and returns.
6. **List endpoints return `[]`, never `null`.**
7. **The migration is idempotent and runs on every boot.** Any statement added must be `IF NOT EXISTS` or
   guarded by an `information_schema` check. It must stay readable by the previous implementation.
8. **Every path segment sent upstream is escaped (`pathEscape`).** An unescaped `../` steers the gateway at a
   different proxy path.
9. **Configuration errors fail before any port is bound**, with a message naming the variable and never the secret.
10. **This service decides one upstream verdict and relays the rest.** "st-gateway did not answer me" is a `504`;
    every status the gateway did send is relayed unchanged, with its `error.message` and pacing headers. `502`
    means only "answered with something this service could not decode". Normative across all three gateway
    clients: `meta/docs/design/upstream-errors.md`.
11. **`UpstreamError.message` is the upstream's own sentence and nothing else.** Where the call happened goes in
    the endpoint field, and a 504's transport error stays out of the caller's body (it names the internal gateway).
12. **A caller that hangs up is not a gateway failure** (`CallerGone`).
13. **One question to auth-service per request, and no other verification path.** 1 s timeout, no retry, no
    cache. Every failure is the one `503`. A bad token is a `401` on every method, never a visitor. `kind` is the
    centre's answer, never derived from `sub`. Scopes match by exact membership only.

## Critical sequences

**Startup, in order.** Read and validate the introspection config first (instant; a missing
`AUTH_INTROSPECTION_*` must crash the container inside the bootstrap script's ~30 s liveness window rather than
after a slow MySQL ping loop), then the database (pool, ping with retry, migrate), the gateway address (read
once), the route policy, and only then bind `PORT` (default 80).

**Migration order:** create tables, widen columns, create indexes. Widening precedes indexing so an index is
never built on a column about to be rebuilt.

**A write request:** ask auth-service (once), check scope, read and validate the body, call the gateway (session
forwarded), persist, respond. The upstream call is the point of no return; nothing after it may return an error status.

## Public surface

Changing any of these breaks a known consumer.

| Identifier | Consumer | Notes |
|---|---|---|
| `/api/agent/v1/*` route paths | command-interface, automation-service, fleet-service | The `/v1` prefix is the versioning story; new shapes go to `/v2` |
| `/health`, `/api/agent/health` | compose healthcheck, CloudFront | Both must stay; CloudFront only routes configured path patterns |
| `Authorization` forwarded verbatim to st-gateway | st-gateway's priority derivation | A human session lands in the interactive lane; a machine token in background |
| `fleet:control` scope string | Clerk session config, fleet-service | |
| `SHIP_PURCHASE`, `PURCHASE`, `SELL` | anything reading `GET /transactions` | Also the `?type=` filter's accepted values |
| JSON field names of transactions, deliveries and the current-agent bundle | command-interface | |
| `{"error":{"message":…}}` auth envelope | shared with automation-service / fleet-service | |
| `POST /contracts/{id}/deliveries` request body | fleet-service | `{shipSymbol, tradeSymbol, units}`; needs `fleet:control` since meta#71 |
| `AUTH_INTROSPECTION_URL`, `AUTH_INTROSPECTION_SECRET`, `X-Introspection-Secret` | infrastructure `agent-service/main.tf`, meta compose, auth-service | Names fixed by `meta/fixtures/introspection.json` |
| The five auth sentences and their statuses | command-interface, automation-service's classifier | clerk-client's messages |
| The MySQL schema | the previous (Go) image, for a rollback | See invariant 7 |

## Domain and upstream facts

* **st-gateway, not SpaceTraders.** Every outbound call goes to `ST_GATEWAY_URL + /proxy + <the SpaceTraders
  path>`. The gateway owns the shared rate budget (meta#1/meta#7). Calling SpaceTraders directly would bypass it.
* **Priority is the gateway's call (decision 2).** It derives it from the Clerk session this service forwards: an
  operator is interactive, anything else (automation-service's machine token, no session) is background.
* **SpaceTraders wraps everything in `data`.**
* **Accept and fulfil return the same shape** (contract and agent), as do purchase-cargo and sell-cargo.
* **Purchase and sell live here, not in fleet-service**, because they move credits and this service owns the
  transaction history.
* **auth-service verifies, this service asks (decision 21).** The answer's `scope` is one string, split on runs of
  space, tab, CR and LF only (fixture v6); it is ABSENT for a scopeless session, which is the empty list.
* **Agent credits exceed `INT`.** Money columns are `BIGINT` for that reason.
* **MySQL is `mysql:9`, in compose and in production alike** (`infrastructure/agent-service/main.tf`). Both track
  the latest 9.x on purpose. Do not pin one side to a different major: MySQL refuses to start against a data
  directory written by a newer server. `mysql_native_password` was removed in 9, so neither side sets
  `MYSQL_NATIVE_PASSWORD`; mysql2 authenticates with `caching_sha2_password`.

## Testing

| Layer | Where | Harness |
|---|---|---|
| Routes, auth, validation, writes, reads | `src/__tests__/app.test.ts`, `reads.test.ts`, `writes.test.ts`, `requestBody.test.ts`, `segments.test.ts`, `policy.test.ts` | supertest against the real app (`testSupport/createTestApp.ts`), `FakeSql` for the DB, a stub gateway and a stub auth centre on loopback |
| Gateway client and decoding | `client.test.ts`, `decode.test.ts`, `json.test.ts`, `gatewayErrors.test.ts` | stub HTTP server; the pinned fixture |
| Config, DB, persistence | `config.test.ts`, `db.test.ts`, `sql.test.ts`, `persistence.test.ts` | `FakeSql` |
| Connections | `connections.test.ts` | real sockets |
| Real MySQL | `mysql.integration.test.ts` | runs when `TEST_MYSQL_HOST` is set |
| Tooling | `dependencies.test.ts`, `runContract.test.ts` | the dependency checker and the contract judge, pure |
| Black box | `contract/`, via `scripts/run-contract.js` | the built image or process, MySQL, stubs it plays itself |

Tests sign nothing: tokens are opaque strings a stub auth-service answers for. Never assert on wall-clock
timing without a two-orders-of-magnitude margin.

## Extending things

* **A new upstream call:** a method on `GatewayClient`, a schema in `gateway/schema.ts`, then a controller method.
* **A new route:** add the tsoa controller method, an entry in `routePolicy` (a mutating route cannot be
  `none`), a case in `contract/` if it is part of the public surface, then `npm run openapi` and commit the spec.
* **A new transaction type:** add it to the list the `?type=` filter, its error message and the spec enum derive from.
* **A new table or column:** `CREATE TABLE IF NOT EXISTS` in `db/migrate.ts`, a guarded entry in `WIDENED_COLUMNS`
  or `INDEXES` for existing databases. Money columns are `BIGINT`; time columns are read back as UTC.
* **A new config value:** read it once at startup in `config.ts`, never per request, and add it to the README's table.
* **A new tunable:** a named constant with a comment saying what it bounds, plus a row in the README's table.
* **A new dependency:** a line in `allowed-dependencies.txt`, justified in the PR; `npm ci --ignore-scripts` only.

---

Update this file in the same PR as the change it describes.
