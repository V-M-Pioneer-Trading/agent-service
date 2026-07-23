# Agent Info Service
Service for accessing information about the agent - profile, fleet, contracts, etc. Also
owns ship/cargo purchases and cargo sells — since these are the actions that spend or earn
credits — and persists them into a transaction history, calling SpaceTraders directly
(via st-gateway) the same way it already does for accept/fulfill-contract.

## Setup and local development

### Required software

* Golang (https://go.dev/doc/install)
* Latest MySql Docker Image (https://hub.docker.com/_/mysql)

### Running application locally

**TODO** add more detailed instructions for a fresh project setup

To run DB execute the following command in the root directory:
> docker compose up

To run application, switch to "/src" directory and execute:
> go run .

Every endpoint requires an `Authorization: Bearer <token>` header — this service never stores
a token itself, it forwards whatever you send straight to SpaceTraders.

You can test the application by navigating to http://localhost/current-agent (with an
Authorization header set, e.g. via curl or a REST client — a browser address bar can't do that).

Swagger UI (endpoint docs): http://localhost/swagger/index.html
Regenerate docs after changing handler annotations in `src/api/routes.go`:
> cd src && swag init -g app-runner.go --parseInternal --output ./docs

### Endpoints

- `GET  /current-agent` — bundled agent + ships + contracts
- `GET  /agent`
- `GET  /ships`, `GET /ships/{shipSymbol}`
- `GET  /contracts`, `GET /contracts/{contractId}`
- `POST /contracts/{contractId}/accept`
- `POST /contracts/{contractId}/fulfill`
- `GET  /contracts/{contractId}/deliveries`, `POST /contracts/{contractId}/deliveries` (internal —
  called by fleet-service after a successful deliver-contract action)
- `POST /ships/purchase` — purchase a new ship; body `{ shipType, waypointSymbol }`
- `POST /ships/{shipSymbol}/purchase` — purchase cargo into a ship's hold; body `{ symbol, units }`
- `POST /ships/{shipSymbol}/sell` — sell cargo from a ship's hold; body `{ symbol, units }`
- `GET  /transactions` — recorded ship/cargo purchases and cargo sells, newest first; optional
  `shipSymbol`, `type` (`SHIP_PURCHASE`/`PURCHASE`/`SELL`), and `limit` query params

### Environment variables

- `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` — set by
  docker-compose already; only needed if running the Go binary outside the compose network.
- `CORS_ALLOWED_ORIGIN` — frontend origin allowed to call this service (default
  `http://localhost:3000`).

## References

### Basic Golang web docs
https://gowebexamples.com/

#### Spacetraders API reference

https://spacetraders.stoplight.io/docs/spacetraders/11f2735b75b02-space-traders-api

##### GET current agent
https://api.spacetraders.io/v2/my/agent

##### GET my ships
https://api.spacetraders.io/v2/my/ships

##### GET my contracts
https://api.spacetraders.io/v2/my/contracts