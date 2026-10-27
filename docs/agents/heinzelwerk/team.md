# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo; the workspace is described in V-M-Pioneer-Trading/meta `docs/agents/heinzelwerk/workspace.md`.

- **Autonomy**: full. Agents merge and apply on their own; breakages are learnings. Secrets are never published (name the variable, never the value), and the gate never merges its own policy.
- **Role**: backend
- **Backend paths**: whole repo (`src/`, `contract/` is never edited)
- **Worktree setup**: `npm ci --ignore-scripts`
- **Checks** (validator runs every one, in order; copied from CI, quiet flags only):
  - `npm run check:deps`
  - `npm audit --audit-level=high` (red on main: V-M-Pioneer-Trading/meta#119)
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - `npm run openapi && test -z "$(git status --porcelain -- openapi.json)"`
  - `TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=3306 npm test` (needs mysql:9 on 3306, root/example, db vnm-agent-db, as the CI service) (unverified locally: docker daemon not running)
  - contract job, in order: `docker build -t agent-service:contract .`; `(cd contract && npm ci --ignore-scripts && npm run typecheck)`; `CONTRACT_IMAGE=agent-service:contract CONTRACT_MYSQL_HOST=host.docker.internal CONTRACT_MYSQL_PORT=3306 CONTRACT_MYSQL_USER=root CONTRACT_MYSQL_PASSWORD=example CONTRACT_MYSQL_DATABASE=vnm-agent-db node scripts/run-contract.cjs` (unverified locally: docker daemon not running)
  - image job: `docker build -q .` (CI builds linux/arm64) (unverified locally: docker daemon not running)
- **Checks verified on main**: 0502eba 2026-10-27
- **Coding standards**: `CLAUDE.md` and the shared `@v-m-pioneer-trading/eslint-config`
- **Risk areas** (validator reviews diffs touching these on Opus):
  - `src/controllers/ships.controller.ts`, `src/controllers/contracts.controller.ts`, `src/gateway/client.ts`: ship purchase, cargo buy/sell, contract accept/fulfill move game credits
  - `src/auth.ts` (`routePolicy`): every route's credential requirement; GET deliveries and transactions are anonymous by design
  - `src/db/migrate.ts`: runs on every boot; the schema must stay readable by the previous image (rollback)
  - `contract/`, `contract-skip*.txt`: the parity oracle; a change there hides a regression
  - `.github/workflows/**`: a merge to `main` deploys or releases
- **Contracts** (see team-modes **Contract changes**; validator checks every diff touching these):
  - API: `openapi.json` (committed, CI checks drift; mirrored to meta `openapi/agent-service.json`) · provider agent-service
