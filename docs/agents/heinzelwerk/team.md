# Team rules

How heinzelwerk agents work in this repo. Mode rules (single repo vs workspace) live in the `heinzelwerk:team-modes` skill. This file holds only what is specific to this repo.

- **Role**: backend (Node 24 / TS / Express / tsoa / MySQL 9)
- **Backend paths**: `src/`, `scripts/`, `Dockerfile`, `docker-compose.yml`
- **Shared paths** (only the owner named in the task edits them): `contract/`, `openapi.json`, `allowed-dependencies.txt`, `dependency-snapshot.txt`
- **Worktree setup**: `npm ci --ignore-scripts` (install scripts are refused by this repo's dependency policy)
- **Checks** (validator runs every one, in order; MySQL up first: `docker compose up -d mysql`):
  1. `npm run check:deps --silent`
  2. `npm audit --audit-level=high`
  3. `npm run typecheck --silent`
  4. `npm run lint --silent`
  5. `npm run build --silent`
  6. `npm run openapi --silent && git diff --exit-code openapi.json`
  7. `TEST_MYSQL_HOST=127.0.0.1 npm test --silent -- --silent`
  8. `node scripts/run-contract.cjs` (needs a fresh MySQL database, `CONTRACT_MYSQL_*` as in `contract/README.md`)
- **Security**: gitleaks pre-commit hook (`gitleaks git --pre-commit --staged` in `.git/hooks/pre-commit`, so every worktree runs it) · dependency audit in checks
- **Coding standards**: `CLAUDE.md` in this repo; lint rules come from `@v-m-pioneer-trading/eslint-config` and change only by a release of that package
- **Risk areas** (validator reviews diffs touching these on Opus):
  - `src/auth.ts` route policy, any new route: authorization; a route without a policy entry is a hole
  - `src/gateway/client.ts`, `src/gateway/location.ts`: Authorization forwarding and redirects can leak the caller's bearer
  - purchase / sell paths and `src/db/` history writes: credits move; money is BIGINT
  - `src/db/migrate.ts`: DDL stays `IF NOT EXISTS` and readable by the previous (Go) image, for rollback
  - `.github/workflows/`: push to main deploys production
- **Contracts**:
  - `openapi.json`: provider this repo; CI regenerates and diffs it; meta's copy is synced by the `vmpt-openapi-sync` bot. Consumers: command-interface, automation-service, fleet-service
  - `contract/`: black-box suite pinning the Go behaviour; code changes to pass it, the suite does not. `contract-skip.txt` stays empty
  - `meta/fixtures/gateway-errors.json`, vendored in `contract/fixtures/`: provider meta; change meta first, then re-vendor
  - `@v-m-pioneer-trading/eslint-config`, `@v-m-pioneer-trading/clerk-client`: provider = that repo; consumed by release-tarball URL, so a change is a version bump here
