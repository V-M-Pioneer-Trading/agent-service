# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value); the gate never merges its own policy.
- **Backend paths**: whole repo except `contract/` (`src/`, `scripts/`, `Dockerfile`, `openapi.json`, `.github/`)
- **Worktree setup** (run once in every new task worktree): `npm ci --ignore-scripts`
- **Checks** (validator runs every one, in order; copied from CI, quiet flags only):
  - `npm run check:deps`
  - `npm audit --audit-level=high (red on main: V-M-Pioneer-Trading/meta#136)`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run openapi && test -z "$(git status --porcelain -- openapi.json)"`
  - `TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=3306 npm test (unverified locally: needs mysql:9 on 3306, docker daemon not running; plain npm test green, real-MySQL tests skip)`
  - `docker build -t agent-service:contract . && (cd contract && npm ci --ignore-scripts && npm run typecheck) && CONTRACT_IMAGE=agent-service:contract CONTRACT_MYSQL_HOST=host.docker.internal CONTRACT_MYSQL_PORT=3306 CONTRACT_MYSQL_USER=root CONTRACT_MYSQL_PASSWORD=example CONTRACT_MYSQL_DATABASE=vnm-agent-db node scripts/run-contract.cjs (unverified locally: docker daemon not running; also needs mysql:9)`
  - `docker buildx build --platform linux/arm64 . (unverified locally: docker daemon not running)`
- **Verified against**: 0502eba 2026-10-29 (checks and every ref in this file; retro bumps it)
- **Coding standards**: `eslint.config.mjs:1` (shared `base` from `@v-m-pioneer-trading/eslint-config`, `package.json:34`), `eslint . --max-warnings 0` (`package.json:18`); lint disables carry `-- <why>` (`CLAUDE.md:18`); `CLAUDE.md` "## Invariants" (:149) and "### Dependency rules" (:138)
- **Risk areas** (validator reviews diffs touching these on Opus):
  - `src/auth.ts:22-44` `routePolicy`: every route's access tier; `none`/`ignore` on a mutating method must stay a startup error (`src/auth.ts:65-70`)
  - `GET /api/agent/v1/contracts/:contractId/deliveries` and `GET /api/agent/v1/transactions` (`src/auth.ts:42-43`): `none`, served from MySQL to anyone
  - `src/gateway/client.ts:103-131`: accept/fulfill/purchase-ship/purchase-cargo/sell-cargo move game credits via st-gateway; no SpaceTraders credential may enter this repo (`CLAUDE.md:153`)
  - `src/persistence.ts:53-60`, `src/controllers/ships.controller.ts:42`, `src/controllers/contracts.controller.ts:59`: history writes after the game acted must never fail the request (`CLAUDE.md:164`)
  - `src/db/migrate.ts:97-106`: runs every boot on prod MySQL; schema shared with the Go image for rollback (`src/db/migrate.ts:2-3`); statements must be idempotent
  - `contract/**`: pinned parity suite; never edit to make code pass
  - `scripts/run-contract.cjs` and its inputs `contract-skip*` (`contract-skip.txt`, `contract-skip-passing.txt`, `contract-skip.expected`): the judge of the contract suite; it reads those three files (`scripts/run-contract.cjs:126-128`), so editing a skip list or an expected count decides what the suite may skip
  - `contract/fixtures/gateway-errors.json`: sha256-pinned vendored copy (`contract/fixtures/SOURCE.txt:5`, `contract/suites/pins.ts:22-24`)
  - `.github/workflows/container.yml:186-330`: a merge to `main` deploys to production (arm64 image, GHCR, SSM redeploy of instance `i-011b6b82a9072a385`, `:293-294`)
  - `.github/workflows/container.yml` job names `test` (:43), `contract` (:108), `image` (:168): required checks, never rename (`CLAUDE.md:27-28`)
  - `src/server.ts:191-194`, `src/config.ts:184-188`: startup refusal order; missing `AUTH_INTROSPECTION_*` must crash before DB wait
  - `Dockerfile:24-27`: deps stage fails the build on compiled files in `node_modules`
  - `package.json:24`, `allowed-dependencies.txt`, `dependency-snapshot.txt`: dependency gate; lockfile change needs `npm run snapshot:deps`
- **Contracts** (see team-modes **Contract changes**; validator checks every diff touching these):
  - API: `openapi.json` (committed, `npm run openapi`; synced to meta `../meta/openapi/agent-service.json` by `.github/workflows/container.yml:336-338`) = single source of truth backend ↔ frontend · provider backend
  - Provided: `/api/agent/v1/*` per `src/auth.ts:22-44`, `GET /health`, `GET /api/agent/health` · consumers command-interface (`../command-interface/src/api/agentService.ts:21`), automation-service (`../automation-service/src/gameClients.ts:351,358-383,410,422`), fleet-service (`../fleet-service/src/controllers/contracts.controller.ts:50`)
  - Consumed: st-gateway `ST_GATEWAY_URL` + `/proxy` (`src/config.ts:234`, calls `src/gateway/client.ts:103-131`) · provider st-gateway; auth-service `POST /auth/v1/introspect` via clerk-client v2.0.1 (`package.json:24`, env `src/config.ts:184-188`) · provider auth-service
  - Vendored: `contract/fixtures/gateway-errors.json`, copy of meta `../meta/fixtures/gateway-errors.json` (line 2 differs), pinned in `contract/fixtures/SOURCE.txt:5` · provider meta; re-vendor steps `contract/fixtures/SOURCE.txt:14-20`
