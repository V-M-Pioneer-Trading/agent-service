# agent-service contract suite

A black-box HTTP suite for agent-service. It knows nothing about the language the
service is written in: it starts an image (or a process), talks HTTP to it, and
plays st-gateway and auth-service itself. It was written against the Go image and is the parity record
of the port: the TypeScript service, which replaced Go at the cutover (agent-service#38),
passes it unchanged.

It is step 3 of the Go to TypeScript migration (the epic in `meta`; link to follow).

## Parity, as decided

* Same status codes.
* Same relevant headers: `Content-Type`, `Cache-Control`, `Allow`, `Location`, the
  pacing headers (`Retry-After`, `X-RateLimit-*`) and everything `Access-Control-*`
  (plus `Vary`, `WWW-Authenticate`, `Set-Cookie`). The *set* of these that a response
  carries must match exactly: an extra `Cache-Control` fails as surely as a missing
  CORS header. Headers outside that list (`Date`, `Content-Length`, `ETag`,
  `X-Powered-By`, `X-Content-Type-Options`, ...) are not compared.
* JSON bodies are parsed and deep-compared, so key order and whitespace are free but
  null versus missing, and a number versus a string, are not.
* Plain-text bodies (every error that is not the auth envelope) are compared byte for
  byte, with two exceptions: the tail of a decoder error is not pinned (see
  "Decoder wording" below), and Go's fixed `net/http` texts are, and are tagged
  `[net-http-text]`.
* HEAD, trailing slashes, percent-decoding, unknown routes and wrong methods are all
  part of the contract.

## Running it

In CI: the `contract` job of `.github/workflows/container.yml` builds the image, starts `mysql:9` as a
service container and runs the suite on every pull request and push to `main`.

Locally, with Docker and a MySQL the container can reach:

```sh
docker build -t agent-service:contract ..            # from this directory
docker compose -f ../docker-compose.yml up -d mysql  # root / example / vnm-agent-db
npm ci
CONTRACT_IMAGE=agent-service:contract npm test       # node --test --test-timeout=60000 contract.test.ts
```

`npm run typecheck` checks the suite itself. Node 24 runs the `.ts` files directly
(type stripping), so the sources use erasable syntax only: no enums, no parameter
properties, no namespaces, `import type` for types.

| Variable | Default | Meaning |
|---|---|---|
| `CONTRACT_IMAGE` | (required, unless `CONTRACT_COMMAND`) | Image to run. It must listen on `PORT` and read the environment below. |
| `CONTRACT_COMMAND` | | Run this shell command instead of docker, for a fast loop while porting. Same environment; the stubs are addressed as `127.0.0.1`. |
| `CONTRACT_CONTAINER_PORT` | `80` | The port the image listens on (passed to it as `PORT`). |
| `CONTRACT_MYSQL_HOST` | `host.docker.internal` (`127.0.0.1` with `CONTRACT_COMMAND`) | |
| `CONTRACT_MYSQL_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | `3306` / `root` / `example` / `vnm-agent-db` | |
| `CONTRACT_STUB_HOST` | `host.docker.internal` (`127.0.0.1` with `CONTRACT_COMMAND`) | How the service reaches the stubs. |

The service is started with `ST_GATEWAY_URL`, `AUTH_INTROSPECTION_URL`,
`AUTH_INTROSPECTION_SECRET`, `CORS_ALLOWED_ORIGIN` (`https://contract.example.test`),
`MYSQL_*` and `PORT`, with `--add-host=host.docker.internal:host-gateway` and its
port published on 127.0.0.1. The container is removed at the end of the run, also
after a failure or an interrupt. The service's log is written to `.out/service.log`.

**Use a fresh database for a port.** The service creates its tables with `CREATE TABLE IF NOT EXISTS` and widens or indexes them only if they differ, so pointing a port at a database the Go service has already used makes it inherit Go's schema and hides any difference in its own migrations. Give each implementation an empty database (or a per-run `CONTRACT_MYSQL_DATABASE`); CI gets a new one with every `mysql:9` service container.

The whole run takes well under a minute plus the image build. The database does not
have to be empty and is never cleaned: every test uses symbols nobody else uses, and
the suite observes the database only through the API (no SQL client).

## How it is built

`contract.test.ts` is the only test file: the stubs live in the test process, so one
process means one service. It starts both stubs and the service in a root `before`,
resets the stubs before each test, and after each test fails if the service called
st-gateway with nothing scripted for it.

* `harness/stubs.ts`: the st-gateway stub (records every request, including the
  `Authorization` header verbatim; scripted per `METHOD /target`; can drop the
  connection, die mid-body, hang, or stop listening to be refused) and the
  introspection-center stub (`POST /auth/v1/introspect`, form `token=`, checks
  `X-Introspection-Secret`; scripted per token: active, inactive, any status,
  hang, delay, redirect, raw bytes).
* `harness/service.ts`: docker (or process) lifecycle, plus `runToExit` for
  configurations the service must refuse to start with.
* `harness/http.ts`: a low-level client over `node:http`. `fetch` cannot be used for
  the path and header cases: it normalises `..` and `//` in the URL and folds
  repeated headers.
* `harness/expect.ts`: the assertions that encode the parity rules above.
* `fixtures/`: gateway payloads and the route table; `gateway-errors.json` is the
  shared upstream-error contract, a verbatim copy pinned by sha256 (see
  `fixtures/SOURCE.txt`). `suites/pins.ts` fails if the copy drifts.
* `suites/`: operational (health, swagger), routing, cors, auth, proxy,
  upstream-errors, validation, persistence, head, startup.

### Decoder wording is not pinned

A body the service cannot decode (a request body in a 400, a gateway answer in a 502)
is answered with the Go decoder's own explanation, e.g. `json: cannot unmarshal string
into Go struct field Agent.data.credits of type int64`. The suite has one mode and does
not pin that wording: it asserts the status, `Content-Type: text/plain; charset=utf-8`,
the stable prefix (`invalid request body: ` for a request body, nothing for a 502) and
that a non-empty explanation follows. The route-specific sentences that are the
service's own (`symbol and units (>0) are required`, `limit must be a positive
integer`, ...) stay exact.

### `[net-http-text]`

Go's `net/http` and router answer a few fixed texts that are cheap to reproduce and
stay pinned exactly: `404 page not found` and `400 Bad Request`. Those tests carry the
tag `[net-http-text]`, so `node --test --test-name-pattern='\[net-http-text\]'
contract.test.ts` runs exactly them.

## Coverage

Every route of the original Go service's `src/api/routes.go` (deleted in agent-service#38; the TypeScript service has the same table):

* `GET /health`, `GET /api/agent/health`, `GET /api/agent/swagger/`
* `GET /api/agent/v1/{current-agent, agent, ships, ships/{symbol}, contracts, contracts/{id}}`
* `POST /api/agent/v1/{contracts/{id}/accept, contracts/{id}/fulfill, ships/purchase, ships/{symbol}/purchase, ships/{symbol}/sell, contracts/{id}/deliveries}`
* `GET /api/agent/v1/{contracts/{id}/deliveries, transactions}`

for: the success shape; each auth failure (no credential, every malformed form of
one, inactive, wrong scope, center 5xx, timeout, malformed, oversized, redirecting)
with exact bodies; public routes that introspect a presented token; the whole
`gateway-errors.json` fixture replayed against every route that calls the gateway;
`Authorization` forwarded verbatim and nothing else of the caller's; the request made
to the center; HEAD; OPTIONS and CORS on normal and abnormal responses; unknown
routes, wrong methods, trailing slashes, redirects, percent-decoding and path
escaping toward the gateway; `/transactions` parameters; best-effort persistence;
request body validation; start-up configuration.

Not covered, on purpose: the gateway's 30 s timeout (a stuck gateway is a 504 after
half a minute, which would triple the run time), the swagger UI's HTML and
the spec's content, the service's behaviour when MySQL is down, and
`contracts` persistence, which no endpoint can read back (accept/fulfill are only
tested to stay 200 whether or not the row is written).

## Behaviour notes

What the Go service does that a reader of its source would not necessarily expect, and
that the suite therefore pins. This list is input for the porters: every item is a
place where a framework default (Express, tsoa, a JSON library, an HTTP client) is
likely to differ.

### Routing and HTTP

1. **There are two "not found" answers, and no 405 under `/api/agent`.** Any path
   that is not under the string prefix `/api/agent` (`/api/agentx` is under it) gets
   a **bare 405** for every method but OPTIONS: no body, no `Content-Type`, no
   `Allow`. That is because a catch-all `OPTIONS` route (the CORS preflight) matches
   every path, so every other method reads as "wrong method". Any path under
   `/api/agent` that no route takes, *and any wrong method on a route there*
   (`POST /api/agent/v1/agent`, `GET .../accept`, `DELETE /api/agent/health`), gets
   **`404` with body `404 page not found\n`**, `text/plain; charset=utf-8`. Neither
   carries CORS headers, and `Allow` is never set. `/health` is outside the prefix, so
   `POST /health` is a 405 but `POST /api/agent/health` a 404.
2. **Unclean paths are redirected, not routed.** The router cleans the *decoded*
   path (`//`, `/./`, `/../`, also written `%2E%2E`) and answers `301` with
   `Location` set to the cleaned path (query string kept; a trailing slash kept),
   for every method including OPTIONS, before the auth check and the CORS
   middleware: no CORS headers, no body.
3. **Routing is on the decoded path.** `/api/agent/v1/%61gent` is `/agent`;
   `%2F` is a slash, so `/ships/A%2FB` has three segments and matches nothing (404);
   `%2561gent` decodes once and matches nothing. A malformed escape (`%zz`, a lone
   `%`) never reaches the router: the HTTP layer answers `400 Bad Request` as plain
   text with `Connection: close`.
4. **Every path symbol is escaped again, with Go's `url.PathEscape`, toward the
   gateway.** Only letters, digits and `- _ . ~` plus `$ & + = : @` stay literal;
   `, ; ? # % / \ " < > |`, space and every non-ASCII byte become `%XX` (upper-case
   hex). `encodeURIComponent` is not the same function (it leaves `! ' ( ) *` alone
   and escapes `$ & + = : @`); `harness/util.ts` has a reference implementation.
5. **`GET /ships/purchase` is the ship called "purchase"**, because the GET
   route `/ships/{shipSymbol}` matches it (`/ships/purchase` itself is POST-only);
   `POST /ships/purchase/purchase` buys cargo for that ship. `HEAD /ships/purchase` is a HEAD
   of that ship. Both `GET` and `POST` exist on `/contracts/{id}/deliveries`.
6. **No trailing slash is tolerated** anywhere (404 under `/api/agent`, 405
   elsewhere).
7. **Swagger is a third-party handler, and only its reachability is pinned**: the docs
   route answers 2xx or 3xx, following its redirects ends in `200 text/html`, the spec
   that page loads (today `doc.json`) is JSON, and the center is never asked. Today the
   bare prefix is a `301` to `index.html`, `HEAD` is a 405 and the other methods are a
   bare 405, but none of that is contract. It never reads `Authorization`.
8. **HEAD is GET without the body**: the same handler runs, so a HEAD on a proxied
   route calls the gateway (with `GET`), a HEAD on `/transactions` queries the
   database, and an auth failure is the same status and `Content-Type` as the GET's.
   The exception is swagger (above), which is not pinned.
9. **OPTIONS** is answered `204` with no body and no `Content-Type` on *every* path
   under the CORS middleware (known, unknown, and POST-only routes), before the auth
   check: `Authorization` is not even read. The CORS headers are constants
   (`Access-Control-Allow-Origin` is the configured value, never the caller's
   `Origin`; `Allow-Methods: GET, POST, OPTIONS`; `Allow-Headers: Content-Type,
   Authorization`; `Expose-Headers: Retry-After, X-RateLimit-Limit,
   X-RateLimit-Remaining, X-RateLimit-Reset`); there is no `Vary`, no
   `Allow-Credentials`, no `Max-Age`. They are on every response a *matched* route
   produces (200, 401, 403, 503, relayed gateway errors, validation errors, the
   swagger 301) and on none of the 404, 405, 301-from-cleaning or malformed-URL 400
   answers.
10. **No `Cache-Control`, no `Allow` and no `Vary` is ever sent.** Go also adds
    `Date`, `Content-Length` and, on `http.Error` answers, `X-Content-Type-Options:
    nosniff`; none of those is compared, but a port that lets Express add `ETag` and
    `X-Powered-By` is adding headers the Go service never sent.
11. **JSON answers are `Content-Type: application/json` with no charset**, and
    end with a newline. Plain-text errors are `text/plain; charset=utf-8` and end
    with a newline too (`http.Error` appends one).

### Authorization

12. **What counts as a credential** is exactly `<scheme> <one token>`: two
    whitespace-separated parts (any run of blanks, a tab will do), scheme
    case-insensitive and equal to `bearer`. `Bearer`, `Bearer `, `Basic x`, `Bearer a
    b`, a bare token, and **two `Authorization` header lines** (whatever they hold)
    are *no credential*: 401 on the read and write tiers without calling the center.
13. **On the public routes "no credential" is a visitor**, so a malformed header, a
    `Basic` header and two `Authorization` lines are all *served*, with the center
    never asked. A well-formed token the center calls inactive is a 401 and one it
    cannot judge is a 503, on every method including HEAD.
14. **The header is forwarded to the gateway byte for byte** (`Bearer   tok`,
    `bearer tok`, a tab), as one header line, and nothing else of the caller's
    (`Cookie`, `X-Priority`, `Origin`, `X-Forwarded-For`...) is.
15. **The center is asked once per request**, whatever the number of gateway calls
    (`/current-agent` makes three), with `POST`, `Content-Type:
    application/x-www-form-urlencoded`, `Accept: application/json`,
    `X-Introspection-Secret`, and the body `token=<form-encoded token>`. No retry, no
    cache, no redirect following, 1 s for the whole exchange, 64 KiB cap, nesting cap
    1000. Every failure, including the center's own 401 about the service's secret and
    a valid answer wrapped in a non-2xx, is the same `503` with the same sentence.
16. **Rejections are `application/json` with `{"error":{"message":...}}`**: 401
    `a bearer token is required` / `invalid or expired session`, 403 `this action
    requires a scope this session does not carry`, 503 `the authentication service
    could not process this request`.
17. **Auth runs before everything**: an unparseable body with no session is a 401, with
    a scopeless session a 403. `fleet:control` is exact membership in a list split on
    runs of space, tab, CR and LF only (fixture v6): VT, FF, a non-breaking space or
    an em space does not split.
18. **The center's answer is validated like the Go client does**: a contract key in
    the wrong case, a repeated key (in any case, at any depth), trailing data, a
    null/wrong-typed member, an `active` answer without `sub`/`exp`/`kind`, an
    unknown or wrongly cased `kind`, are all "unavailable" (503), not "inactive"
    (401). A missing `scope` is the empty list. A float or negative `exp` is fine; the
    service never looks at `exp`. A 2xx other than 200 is read as 200.

### What comes back from the gateway

19. **The answer is rebuilt from typed structures, never passed through.** Missing
    members become zero values (`""`, `0`, `false`, `"0001-01-01T00:00:00Z"`),
    **missing or null lists become `null`** (a ship's `modules`, `mounts`,
    `cargo.inventory`, a contract's `terms.deliver`, and the whole body of `/ships` or
    `/contracts` when `data` is absent), an empty list stays `[]`, unknown members are
    dropped at every depth, `null` is a zero value, `meta` is decoded and dropped.
20. **An empty 2xx body is not an error**: `200`, `204` and a 3xx without a
    `Location`, with no body, and a JSON `null` or `{}`, all answer `200` with the zero
    value. A body of only whitespace *is* an error (502).
21. **Decoding is the Go decoder's**: member names match **case-insensitively**
    (`SYMBOL` binds `symbol`), but not with other punctuation (`starting_faction`
    does not bind `startingFaction`); the last of a repeated key wins; invalid UTF-8
    and lone surrogates become U+FFFD; `\u0000`..`\u001f` are legal. After parsing,
    Go's escaping of `<`, `>`, `&`, U+2028 and U+2029 (`<` ...) is invisible; only a
    byte comparison would see it.
22. **Numbers.** Integer fields are 64-bit (`credits`, `shipCount`, ...): values
    beyond 2^53 survive exactly in both directions, so read them with a parser that
    keeps them (tests assert them on the raw text). `1.5`, `5.0`, `1e3` and
    out-of-range integers for an integer field are decode errors, not coerced.
23. **Times** are RFC 3339 only (upper-case `T` and `Z`, an offset or `Z` required, no
    space, no date alone, leap second `:60` rejected) and are written back with the
    offset they came with, `Z` for UTC (including `+00:00`), and the shortest exact
    fraction: `.000Z` loses its fraction, `.120Z` becomes `.12Z`, digits beyond the ninth
    are cut off. A `null` time is the zero time.
24. **A body that does not fit is `502`** with the decoder's explanation as a
    `text/plain` body (wording not pinned, see "Decoder wording"). That includes `meta`,
    which is otherwise dropped, and a third `/current-agent` answer that is bad after
    two good ones (nothing of the first two is returned).
25. **Redirects from the gateway are followed**, up to ten requests in all, carrying
    the `Authorization` header (and a POST body on 307/308); a loop that is still
    redirecting after ten requests is "st-gateway did not answer", a `504`.
26. **Error relay.** A gateway status from 400 to 599 is the caller's status with the
    gateway's sentence as a `text/plain` body; anything else that is not a success
    (600+) is `502` with the same sentence. That includes a gateway `401`, which
    reaches the caller as a *plain-text* 401, not as the auth envelope. The sentence is
    `error.message` of an envelope when it is a non-blank string (kept as is, not
    trimmed, not cut); otherwise the raw body, cut to 500 *characters* (not bytes);
    `st-gateway returned an error with no message` for a blank body. At most 64 KiB of
    an error body is read, so a larger envelope is cut in half and is raw text. A
    half-delivered error body is used as far as it came. `Retry-After` and
    `X-RateLimit-{Limit,Remaining,Reset}` are copied when non-empty, on *any* error
    status and nothing else of the gateway's headers is; none on success.
27. **A gateway that does not answer is `504 st-gateway did not answer`**: connection
    refused, a closed connection, a 2xx body that dies half way, a redirect loop. The
    sentence names neither the address nor the cause.

### Request bodies

28. **The body decoder reads one JSON value and ignores the rest**: text after the
    object, even a second object or half of a third, is accepted and the first is
    used. Member names match case-insensitively, the last repeated key wins, unknown
    members are ignored, `null` is "absent". `Content-Type` is never checked.
    `units: 2.0`, `1e2` and a string are 400; a `-0` is 0 and then "required".
    Whitespace-only strings are valid values.
29. **Sentences**: `invalid request body: <decoder explanation>` for syntax and type
    errors (wording not pinned); then the required-member sentence of each route
    (`symbol and units (>0) are required`, ...), which stay exact. **1 MiB cap**: a value that
    runs past it is the same `invalid request body: ` 400. Validation precedes any
    gateway call, and accept/fulfill read no body at all.
30. Forwarded bodies carry only the known members (`{shipType, waypointSymbol}`,
    `{symbol, units}`), with `units` as an integer.

### Persistence and queries

31. **History is best effort.** A failed insert (a value over its column's length, a
    number over `INT`, a time outside `TIMESTAMP`'s 1970..2038) is logged and the caller
    still gets the gateway's answer, whole: the suite triggers each of those and checks
    the answer is intact and the row missing. Contract persistence cannot be observed.
32. **Where each stored value comes from**: cargo trades use the ship symbol from the
    *path* (decoded) and everything else from the gateway's answer, not the request;
    a ship purchase uses the new ship's symbol from the answer. `occurredAt` is the
    gateway's timestamp, or *now* when it is missing or the zero time. MySQL keeps whole
    seconds and **rounds** (`.4` down, `.6` up); money is `BIGINT` (beyond 2^53 survives),
    quantities are `INT`.
33. **Collation.** `shipSymbol` and the contract id are compared by MySQL under its
    default collation, so case and accents are ignored (`cafe` finds `Café`), and the
    stored spelling is returned. Do not filter in application code.
34. **Rows are returned newest first** by `occurred_at` (second resolution: ties are
    in no defined order), deliveries oldest first. Lists are `[]`, never `null`. A
    `SHIP_PURCHASE` row has no `tradeSymbol`/`units`/`pricePerUnit` member and a cargo
    row has no `shipType` member (absent, not null); zero values of those that are
    present stay (`"units":0`).
35. **`POST .../deliveries` answers with nanosecond-precision time** (the instant the
    handler read), `GET` with the stored whole second, always `Z`. Compare them with a
    tolerance; the suite accepts one to nine fraction digits on the POST.
36. **`/transactions` parameters**: `type` is validated first (`type must be one of:
    SHIP_PURCHASE, PURCHASE, SELL`, case-sensitive), then `limit` (`limit must be a
    positive integer`). `limit` is parsed like Go's `Atoi`: `05` and `+5` (as `%2B5`) are
    5, a space, `1e3`, `1.5`, `0x10`, non-ASCII digits and anything beyond 64 bits are
    400; above 1000 it is **capped** to 1000, the default is 100. Empty parameters mean
    "not given", the first of a repeated parameter wins, names are case-sensitive,
    unknown ones are ignored, a pair containing a `;` or a malformed `%` escape is
    **dropped as if absent** (so `limit=2;x=1` is no limit). Validation errors are `400
    text/plain` and need no session.
37. **A 500 from the database is `failed to record delivery: <driver error>`**
    (or `failed to load ...`). The tail is the MySQL driver's text and is not pinned;
    the suite asserts the prefix, the status and the content type.

### Start-up

38. The process **exits with status 1 and never listens** for a missing, blank or
    badly shaped `AUTH_INTROSPECTION_URL` (not absolute, not http/https, no host,
    credentials, a query, an empty query, a fragment) or `AUTH_INTROSPECTION_SECRET`
    (blank, surrounding whitespace, a control character) and never prints the secret.
39. `CORS_ALLOWED_ORIGIN` defaults to `http://localhost:3000` when unset or empty
    and is used verbatim. `ST_GATEWAY_URL` has **all** trailing slashes trimmed and
    `/proxy` appended; a path in it is kept as a prefix.
