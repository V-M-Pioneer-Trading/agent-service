# Repo map: V-M-Pioneer-Trading/agent-service
Verified against 0502eba 2026-10-29.

## Purpose
- Express 4 / tsoa / mysql2 service: agent, ship and contract reads and writes relayed to st-gateway, plus MySQL history of trades and deliveries. `package.json:5`
- Replaced the Go service; `contract/` pins Go behaviour, never edit it to make code pass. `CLAUDE.md:6-10`
- Node >=24. `package.json:8`

## Layout
- Controllers: `src/controllers/{agent,contracts,ships,history,health}.controller.ts`; health uses `@Route("")`. `src/controllers/health.controller.ts:14`
- Outbound HTTP, sole door: `src/gateway/client.ts` (`GatewayClient`); schemas `src/gateway/schema.ts`.
- SQL, sole mysql2 importer: `src/db/sql.ts:24`; DDL `src/db/migrate.ts`; startup wait `src/db/setup.ts`.
- Best-effort history writes: `src/persistence.ts`.
- HTTP artefacts (Go mux compat, body, query, cors): `src/http/`.
- Swagger UI over `openapi.json`: `src/swagger.ts`.
- src/generated/ is tsoa output, gitignored `.gitignore:3`, made by `scripts/codegen.cjs:9-14` (adds `// @ts-nocheck`).
- `openapi.json` committed; `npm run openapi` `package.json:15`.
- Existing docs: `README.md`, `CLAUDE.md`, `contract/README.md`, `contract/fixtures/SOURCE.txt`; no docs outside `docs/agents/` (verified 2026-10-29 @ 0502eba: `git ls-tree -r --name-only origin/main | grep '^docs/'` → no output).

## Entry points and auth
- Every route is in `routePolicy`. `src/auth.ts:22-44`
- An unlisted route, or `none`/`ignore` on a mutating method, throws at startup. `src/auth.ts:65-70`; app also `secured()` `src/server.ts:125`
- `session`: GET `/api/agent/v1/{current-agent,agent,ships,ships/:shipSymbol,contracts,contracts/:contractId}`. `src/auth.ts:26-31`
- `fleet:control` (`src/auth.ts:15`): POST contracts/:id/{accept,fulfill}, ships/purchase, ships/:sym/{purchase,sell}, contracts/:id/deliveries (meta#71). `src/auth.ts:34-39`
- Verification is a question to auth-service via clerk-client; `AUTH_INTROSPECTION_*` required, process exits before the DB wait. `src/config.ts:184-188`, `src/server.ts:191-194`

## Unauthenticated routes
- GET `/health`, GET `/api/agent/health`: `ignore`. `src/auth.ts:23-24`
- `/api/agent/swagger/` (GET/HEAD, page and whitelisted assets): `ignoreCredentials`; bare path and other methods 404. `src/swagger.ts:94`, `src/swagger.ts:63-66`
- GET `contracts/:id/deliveries` and GET `/transactions`: `none`, served from MySQL to anyone; a bad presented token is 401. `src/auth.ts:42-43`
- Any OPTIONS: CORS middleware answers 204 before auth. `src/http/cors.ts:16-19`, `src/server.ts:151`

## Money paths
- No SpaceTraders credential here; st-gateway injects it. `CLAUDE.md:153`
- `GatewayClient`: acceptContract/fulfillContract `src/gateway/client.ts:103-109`; purchaseShip POST `/my/ships` `:113-116`; purchaseCargo/sellCargo POST `/my/ships/{s}/purchase|sell` `:119-131`.
- After the gateway answers: persistShipPurchase `src/controllers/ships.controller.ts:42`, persistCargoTrade `:79`, persistContract `src/controllers/contracts.controller.ts:59`; failures logged, never fail the request. `src/persistence.ts:53-60`
- POST deliveries makes no gateway call; inserts a row, answers 500 on DB failure (not best effort). `src/controllers/contracts.controller.ts:86-89`

## Calls and called-by
- Out: st-gateway `ST_GATEWAY_URL` (default `http://localhost:3002`), trailing slashes trimmed, plus `/proxy`. `src/config.ts:217`, `src/config.ts:234`
- Out: auth-service via clerk-client v2.0.1 release tarball. `package.json:24`
- Out: MySQL, defaults host `mysql`, user `root`, db `vnm-agent-db`. `src/config.ts:238-242`
- In: command-interface `../command-interface/src/api/agentService.ts:21-46`; automation-service `../automation-service/src/gameClients.ts:351-383` (`agentShipAction` :351, sell :410, purchase :422); fleet-service POST deliveries `../fleet-service/src/controllers/contracts.controller.ts:50`.
- In: Caddy routes `/api/agent/*`. `../V-M-Pioneer-Trading_infrastructure/caddy/Caddyfile.tftpl:54`
- No sibling calls GET `/transactions` or GET deliveries (verified 2026-10-29 @ 0502eba: grep across sibling checkouts, per map).
- Vendored `contract/fixtures/gateway-errors.json` = meta copy, line 2 differs; sha256 pinned `contract/fixtures/SOURCE.txt:5`, asserted `contract/suites/pins.ts:22-24`; re-vendor `contract/fixtures/SOURCE.txt:14-20`; unit test `src/__tests__/gatewayErrors.test.ts:37`.
- `openapi.json` synced to meta: `.github/workflows/container.yml:335-343` calls `../meta/.github/workflows/openapi-sync.yml:20`, which writes `../meta/openapi/<repo>.json`.

## Persistence
- MySQL, raw SQL; BIGINT read as string. `src/db/sql.ts:56-57`
- Tables `contracts`, `contract_deliveries`, `transactions`. `src/db/migrate.ts:18`, `:27`, `:35`
- Migrates every boot: tables, widen columns, indexes. `src/db/migrate.ts:97-106`
- Schema shared with the Go image (rollback). `src/db/migrate.ts:2-3`
- 15 pings, 2 s apart. `src/db/setup.ts:16-17`

## Build, test, run
- Install `npm ci --ignore-scripts` only. `CLAUDE.md:16`
- Scripts build/typecheck/test (pretest runs codegen): `package.json:12-13`, `:19-20`; lint `package.json:18`.
- Real MySQL tests: `TEST_MYSQL_HOST=127.0.0.1 npm test`; contract: build, then `node scripts/run-contract.cjs` with `CONTRACT_MYSQL_*`. `CLAUDE.md:19-22`
- Post-deploy prod probe, safe to re-run: `OPERATOR_TOKEN=<fleet:control session> node scripts/cutover-probe.mjs --strict` (`--dry-run` calls nothing). `scripts/cutover-probe.mjs:5-26`
- Env defaults: PORT 80, `CORS_ALLOWED_ORIGIN`, `ST_GATEWAY_URL`, `MYSQL_*`. `src/config.ts:233-242`
- Lockfiles `package-lock.json`, `contract/package-lock.json`. `.github/workflows/container.yml:69`, `:133`

## CI and deploy
- `.github/workflows/container.yml`: triggers pull_request, push main, tags `v*`, dispatch. `:7-13`
- `test` (mysql:9 service): ci, check:deps, audit high, typecheck, lint, build, openapi drift check, `npm test`. `.github/workflows/container.yml:43-102`
- `contract`: docker build, `ci` + typecheck in `contract/`, `scripts/run-contract.cjs`, dumps .out/service.log on failure. `.github/workflows/container.yml:108-161`
- `image`: PR-only arm64 no-push build. `.github/workflows/container.yml:168-184`
- `docker`: needs `test`; push/dispatch on main. `:186-190`; tip-of-main check `:219-241`; GHCR `sha-<long>` tag, `:latest` only if tip `:252-258`.
- Deploy: OIDC role then `aws ssm send-command imageTag=sha-<sha>`, only if tip. `:275-330`; instance hard-coded `.github/workflows/container.yml:293-294`
- `v*` tag builds, never deploys. `.github/workflows/container.yml:238-240`
- Main runs share one deploy concurrency group. `.github/workflows/container.yml:36-38`
- Required checks `test`, `image`, `contract`; names fixed. `CLAUDE.md:27-28`

## Patterns
- New route: tsoa method + `routePolicy` entry + contract case + `npm run openapi`. `CLAUDE.md:250-251`
- New upstream call: `GatewayClient` method + `src/gateway/schema.ts`. `CLAUDE.md:249`
- No body parser, query parser off. `src/server.ts:120`, `:136`
- Path symbols read with `lastSegmentOf` `src/http/muxCompat.ts:86`, re-escaped with `pathEscape` `src/http/muxCompat.ts:80`.
- New dependency: line in `allowed-dependencies.txt` plus `npm run snapshot:deps`. `CLAUDE.md:257`
- Lint: shared `base`, ignores `contract/`. `eslint.config.mjs:1,10`; eslint-config tarball v1.1.0 `package.json:34`; disables need `-- <why>` `CLAUDE.md:18`.

## Traps
- `lint` does not run codegen; CI runs it after typecheck. `.github/workflows/container.yml:81-86`
- Scripts using `require()` are `.cjs`. `CLAUDE.md:18`
- tsoa `@Query`/`@Body` only document; handlers read input themselves. `CLAUDE.md:83-85`
- Dockerfile deps stage fails on compiled files. `./Dockerfile:24-27`
- Keep `mysql:9` equal to prod. `../V-M-Pioneer-Trading_infrastructure/agent-service/main.tf:258-259`
- Deploy target instance is hard-coded. `.github/workflows/container.yml:293-294`

## Reference docs
- `./README.md` "Deploying and rolling back": read when rolling back agent-service or deploying a `sha-` tag.
- `./README.md` "Error responses": read when debugging a 4xx/5xx from agent-service or changing error shapes.
- `./README.md` "Tunable values": read when tuning timeouts, pool size or body limits.
- `contract/README.md` "Parity, as decided": read when touching response shape, headers or doing any parity-sensitive change.
- `contract/README.md` "Routing and HTTP": read when changing routing, CORS, path cleaning or HEAD/OPTIONS.
- `contract/README.md` "Authorization": read when changing auth tiers or the center client.
- `contract/README.md` "What comes back from the gateway": read when changing gateway decoding, error relay or body caps.
- `contract/README.md` "Persistence and queries": read when changing history writes or `/transactions` params.
- `contract/README.md` "Start-up": read when changing config parsing or startup refusals.
- `contract/README.md` "How it is built": read when changing the contract harness.
