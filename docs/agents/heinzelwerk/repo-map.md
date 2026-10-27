# Repo map: agent-service

Agent profile, ships, contracts, and credit-moving actions (purchase, sell) for the fleet; owns the MySQL transaction and delivery history. Holds no game credential: forwards the caller's bearer to st-gateway. Ported from Go (decision 23); `contract/` pins the Go behaviour.

| Path | Holds |
|---|---|
| `src/server.ts` | startup (DB wait, migrate, gateway address), `createApp` |
| `src/auth.ts` | route policy: every route's requirement |
| `src/controllers/*.controller.ts` | tsoa controllers |
| `src/gateway/` | `client.ts` (only door to st-gateway), `location.ts` (redirect handling) |
| `src/db/` | `sql.ts` (only mysql2 importer), `migrate.ts` (DDL), `history.ts`, `time.ts`, `setup.ts` |
| `src/persistence.ts` | best-effort history writes |
| `src/http/`, `src/types/` | body reading (1 MiB cap), shared types |
| `scripts/` | `codegen.cjs` (tsoa), `write-openapi.cjs`, `check-dependencies.cjs`, `run-contract.cjs` |
| `contract/` | black-box suite, own `package.json`, vendored `fixtures/` |
| `openapi.json` | committed spec, CI drift-checked |

- Calls: st-gateway `/proxy`, auth-service `POST /auth/v1/introspect` (1 s, no retry, no cache).
- Called by: command-interface, automation-service, fleet-service.
- Port 80 in the container (`PORT`), published as 8080 in compose; MySQL 9 (`docker compose up -d mysql`).
- CI `container.yml`: `test` (deps, audit, typecheck, lint, build, openapi drift, tests on real MySQL), `contract`, `image` (PR), `docker` (main: ghcr push + SSM redeploy).

## Reference docs

- `README.md` "Configuration", "API", "Error responses": read when changing env config, routes or error answers.
- `README.md` "Deploying and rolling back", "Storage": read when deploying, rolling back, or changing the schema.
- `contract/README.md` "Behaviour notes": read when changing routing, auth, gateway decoding, request bodies or history.
