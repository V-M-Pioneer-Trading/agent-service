#!/usr/bin/env node
// Production probe for the Go -> TypeScript cutover of agent-service
// (agent-service#38, meta#103, auth-design.md decision 23, "Cutover is probe-gated").
//
// Run it from any machine with Node 18+ (Git Bash or PowerShell on Windows is fine), against the
// public domain, AFTER the PR tip's image has been deployed by sha and BEFORE the PR is merged:
//
//   OPERATOR_TOKEN=<signed-in Clerk session token> node scripts/cutover-probe.mjs
//   node scripts/cutover-probe.mjs --dry-run        # lists the checks and what is configured, calls nothing
//
// Environment (the only inputs; no flag takes a secret):
//   BASE_URL           default https://spacetraders.radomskyi.com
//   OPERATOR_TOKEN     a signed-in operator's session token. Needs the fleet:control scope.
//                      Required (except with --dry-run).
//   NO_SCOPE_TOKEN     optional: a signed-in session token WITHOUT fleet:control. Without it the
//                      "valid bearer without the scope -> 403" case is SKIPPED, loudly.
//   AGENT_DIRECT_URL   optional: agent-service reached directly, bypassing CloudFront (for example
//                      http://127.0.0.1:8080 through an SSM port forward). CloudFront routes only
//                      /api/agent/v1/* and /api/agent/health, so the Swagger page is checked only
//                      when this is set; otherwise the exact on-host command is printed.
//   SINCE              ISO time. The automation checks look only at events at or after it. Set it
//                      to when the deploy finished. Default: 20 minutes ago.
//
// Flags: --dry-run, --strict (a SKIPPED check fails the run), --help.
// Exit status: 0 every check passed (or was skipped without --strict), 1 a check failed, 2 bad usage.
//
// WHAT IS NEVER DONE, and what is never printed:
//   * no bearer, no token, no token fragment and no body is ever printed. Output is status codes,
//     content types, JSON member NAMES, array lengths, event type names and timestamps. Every line
//     passes through redact(), which also removes the configured tokens (and their JWT segments)
//     should one ever reach a message by accident. Nothing is written to a file.
//   * GET /auth/v1/token and POST /auth/v1/m2m-token are never called by this script.
//   * nothing is bought, sold, accepted, fulfilled or recorded. The write path is probed with an
//     EMPTY JSON body on three routes: with a session that holds fleet:control the handler answers
//     400 (validation runs after auth and before any gateway call or SQL), so a 400 proves the
//     token passed introspection and the scope check while nothing could move. A 2xx there would
//     mean validation was skipped, and the check FAILS.
//   * the 503 with auth-service down is covered by the contract suite and is not probed here.
//   * automation-service's state-changing routes (arm, pause, abort, knobs, replan, events) are never
//     called with a valid token. POST /events is hit only with no header and with a garbage bearer,
//     which auth-service rejects before the handler runs.

import { pathToFileURL } from "node:url";

const DEFAULT_BASE = "https://spacetraders.radomskyi.com";
const TIMEOUT_MS = 20_000;
const GARBAGE = "probe-garbage-not-a-token";
// An unsigned, alg=none token shaped like a JWT: a verifier that trusts the header would let it in.
const FORGED = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJwcm9iZSIsInNjb3BlIjoiZmxlZXQ6Y29udHJvbCJ9.";
const PROBE_ID = "PROBE-NOT-A-REAL-ID";
// Event types that mean one healthy pass of the automation cycle ran.
const CYCLE_TYPES = new Set(["agent_credits_snapshot", "planner_assignment", "planner_shadow_assignment", "contract_evaluated", "dispatch_standby"]);
// Event types that mean the cycle broke (the *_error types) or an action failed.
const ERROR_TYPES = new Set(["mining_tick_error", "contract_discovery_error", "observation_write_error"]);
const WARN_TYPES = new Set(["mining_task_failed"]);

class Skip extends Error {}

/** Splits a JWT into its segments if it is shaped like one, else []. */
function segmentsOf(token) {
  return /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token) ? token.split(".").filter((s) => s.length >= 6) : [];
}

/** Claim NAMES of a JWT's payload (never values), plus whether it has expired. null for an opaque token. */
function claimNames(token) {
  if (segmentsOf(token).length === 0) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    return { names: Object.keys(payload).sort(), expired: exp !== null && exp * 1000 < Date.now() };
  } catch {
    return null;
  }
}

export async function run(argv, env, write = (line) => process.stdout.write(line + "\n")) {
  const flags = new Set(argv);
  const unknown = argv.filter((a) => !["--dry-run", "--strict", "--help", "-h"].includes(a));
  const secrets = [env.OPERATOR_TOKEN, env.NO_SCOPE_TOKEN].filter((s) => typeof s === "string" && s !== "").flatMap((t) => [t, ...segmentsOf(t)]);
  const redact = (text) => {
    let out = String(text);
    for (const s of secrets) out = out.split(s).join("[redacted]");
    return out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, "Bearer [redacted]");
  };
  const say = (line = "") => write(redact(line));

  if (unknown.length > 0 || flags.has("--help") || flags.has("-h")) {
    say("usage: [OPERATOR_TOKEN=... NO_SCOPE_TOKEN=... BASE_URL=... AGENT_DIRECT_URL=... SINCE=...] node scripts/cutover-probe.mjs [--dry-run] [--strict]");
    say("see the header of this file for what every variable means and what the probe never does.");
    return unknown.length > 0 ? 2 : 0;
  }

  let base;
  try {
    const url = new URL(env.BASE_URL || DEFAULT_BASE);
    url.username = "";
    url.password = "";
    base = url.origin;
  } catch {
    say("BASE_URL is not a URL");
    return 2;
  }
  const direct = env.AGENT_DIRECT_URL ? env.AGENT_DIRECT_URL.replace(/\/+$/, "") : "";
  const sinceMs = env.SINCE ? Date.parse(env.SINCE) : Date.now() - 20 * 60_000;
  if (Number.isNaN(sinceMs)) {
    say("SINCE is not a time (use ISO 8601, e.g. 2026-10-04T12:30:00Z)");
    return 2;
  }
  const operator = env.OPERATOR_TOKEN || "";
  const noScope = env.NO_SCOPE_TOKEN || "";
  const dry = flags.has("--dry-run");
  if (operator === "" && !dry) {
    say("OPERATOR_TOKEN is not set. Export a signed-in operator's session token, or use --dry-run to list the checks.");
    return 2;
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  /** One request. Returns what the checks need; nothing here is printed except through a check's own line. */
  async function call(method, path, { token, rawAuth, body, origin, root = base } = {}) {
    const headers = { Accept: "application/json" };
    if (rawAuth !== undefined) headers.Authorization = rawAuth;
    else if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (origin) {
      headers.Origin = origin;
      headers["Access-Control-Request-Method"] = "GET";
      headers["Access-Control-Request-Headers"] = "authorization";
    }
    const res = await fetch(root + path, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const text = await res.text();
    let json;
    if (type === "application/json") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, type, text, json, headers: res.headers };
  }

  // ---- checks -----------------------------------------------------------------------------------

  const checks = [];
  const check = (group, name, fn, { needs = [] } = {}) => checks.push({ group, name, fn, needs });
  const fail = (msg) => {
    throw new Error(msg);
  };
  const expectStatus = (res, want, extra = "") => {
    const wants = Array.isArray(want) ? want : [want];
    if (!wants.includes(res.status)) fail(`status ${res.status}, wanted ${wants.join(" or ")}${extra}`);
  };
  /** CloudFront answers 200 text/html (the dashboard) for any path its origins 404: JSON must be JSON. */
  const expectJson = (res) => {
    if (res.type === "text/html") fail("got text/html: CloudFront's dashboard fallback, the route is not routed or does not exist");
    if (res.type !== "application/json" || res.json === undefined) fail(`content-type ${res.type || "(none)"}, wanted parseable application/json`);
  };
  const shape = (json) => (Array.isArray(json) ? `array(${json.length})` : json !== null && typeof json === "object" ? `members: ${Object.keys(json).sort().join(",")}` : typeof json);

  const needsOperator = ["OPERATOR_TOKEN"];

  // Health of every service the cutover must leave alone, through CloudFront.
  for (const svc of ["agent", "fleet", "automation", "navigation", "st-gateway"]) {
    check("health", `GET /api/${svc}/health, anonymous`, async () => {
      const res = await call("GET", `/api/${svc}/health`);
      expectStatus(res, 200);
      expectJson(res);
      return `200 json ${shape(res.json)}`;
    });
  }
  check("health", "OPTIONS /api/agent/v1/agent allows the Authorization header (CORS preflight)", async () => {
    const res = await call("OPTIONS", "/api/agent/v1/agent", { origin: base });
    expectStatus(res, [200, 204]);
    const allowed = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
    if (!allowed.split(/\s*,\s*/).includes("authorization")) fail("Access-Control-Allow-Headers does not list Authorization");
    return `${res.status}, Authorization allowed`;
  });

  // command-interface's reads, anonymous.
  check("public reads, anonymous", "GET /api/agent/v1/transactions?limit=1", async () => {
    const res = await call("GET", "/api/agent/v1/transactions?limit=1");
    expectStatus(res, 200);
    expectJson(res);
    if (!Array.isArray(res.json)) fail(`wanted a JSON array, got ${shape(res.json)}`);
    return `200 json ${shape(res.json)}`;
  });
  check("public reads, anonymous", "GET /api/agent/v1/transactions?type=NOPE is a 400, not an empty list", async () => {
    const res = await call("GET", "/api/agent/v1/transactions?type=NOPE");
    expectStatus(res, 400);
    if (res.type === "text/html") fail("got text/html: CloudFront's dashboard fallback");
    return `400 ${res.type}`;
  });
  check("public reads, anonymous", "GET /api/agent/v1/contracts/{unknown}/deliveries is an empty list", async () => {
    const res = await call("GET", `/api/agent/v1/contracts/${PROBE_ID}/deliveries`);
    expectStatus(res, 200);
    expectJson(res);
    if (!Array.isArray(res.json) || res.json.length !== 0) fail(`wanted [], got ${shape(res.json)}`);
    return "200 json array(0)";
  });
  for (const path of ["current-agent", "agent", "ships", "contracts"]) {
    check("public reads, anonymous", `GET /api/agent/v1/${path} is a 401 without a header`, async () => {
      const res = await call("GET", `/api/agent/v1/${path}`);
      expectStatus(res, 401);
      expectJson(res);
      if (!res.json?.error) fail("401 without the {error:{message}} envelope");
      return "401 json members: error";
    });
  }

  // Signed in: the live reads through st-gateway to SpaceTraders. Read only.
  for (const path of ["current-agent", "agent", "ships", "contracts"]) {
    check(
      "reads, signed in",
      `GET /api/agent/v1/${path} with the operator's session`,
      async () => {
        const res = await call("GET", `/api/agent/v1/${path}`, { token: operator });
        expectStatus(res, 200, res.status === 503 ? " (503: auth-service could not be asked, or the new image cannot reach it)" : res.status === 401 ? " (401: the token is expired or auth-service rejected it)" : "");
        expectJson(res);
        return `200 json ${shape(res.json)}`;
      },
      { needs: needsOperator },
    );
  }
  check(
    "reads, signed in",
    "GET /api/agent/v1/transactions?limit=1 with the operator's session",
    async () => {
      const res = await call("GET", "/api/agent/v1/transactions?limit=1", { token: operator });
      expectStatus(res, 200);
      expectJson(res);
      return `200 json ${shape(res.json)}`;
    },
    { needs: needsOperator },
  );
  check(
    "reads, signed in",
    "the operator token's claim NAMES, and that it has not expired",
    async () => {
      const claims = claimNames(operator);
      if (claims === null) return "opaque (not a JWT): claims not inspected";
      if (claims.expired) fail("the token has expired (exp is in the past); sign in again");
      return `JWT, not expired, claims: ${claims.names.join(",")}`;
    },
    { needs: needsOperator },
  );

  // The introspection paths of agent-service: no header, garbage bearer, valid without the scope, valid with it.
  const writes = [
    ["POST", "/api/agent/v1/ships/purchase"],
    ["POST", `/api/agent/v1/ships/${PROBE_ID}/sell`],
    ["POST", `/api/agent/v1/contracts/${PROBE_ID}/deliveries`],
  ];
  for (const [method, path] of writes) {
    const label = `${method} ${path.replace(PROBE_ID, "{id}")} with an empty body`;
    check("write path authz (nothing can move)", `${label}: no header`, async () => {
      const res = await call(method, path, { body: "{}" });
      expectStatus(res, 401);
      expectJson(res);
      return "401 json";
    });
    check(
      "write path authz (nothing can move)",
      `${label}: operator session (fleet:control) passes auth and stops at validation`,
      async () => {
        const res = await call(method, path, { token: operator, body: "{}" });
        if (res.status === 403) fail("403: OPERATOR_TOKEN lacks fleet:control, or the scope check is broken");
        if (res.status >= 200 && res.status < 300) fail(`${res.status}: an empty body was accepted. Validation did not run. Check the production database for a stray row before anything else`);
        expectStatus(res, 400);
        if (res.type === "text/html") fail("got text/html: CloudFront's dashboard fallback");
        return `400 ${res.type} (validation, before any gateway call)`;
      },
      { needs: needsOperator },
    );
  }
  check("write path authz (nothing can move)", "POST /api/agent/v1/ships/purchase: garbage bearer", async () => {
    const res = await call("POST", "/api/agent/v1/ships/purchase", { token: GARBAGE, body: "{}" });
    expectStatus(res, 401, res.status === 503 ? " (503: introspection is failing for a token auth-service should simply call inactive)" : "");
    expectJson(res);
    return "401 json";
  });
  check("write path authz (nothing can move)", "POST /api/agent/v1/ships/purchase: forged alg=none JWT", async () => {
    const res = await call("POST", "/api/agent/v1/ships/purchase", { token: FORGED, body: "{}" });
    expectStatus(res, 401);
    return "401";
  });
  check("write path authz (nothing can move)", "POST /api/agent/v1/ships/purchase: not a Bearer header", async () => {
    const res = await call("POST", "/api/agent/v1/ships/purchase", { rawAuth: `Basic ${Buffer.from("probe:probe").toString("base64")}`, body: "{}" });
    expectStatus(res, 401);
    return "401";
  });
  check("write path authz (nothing can move)", "GET /api/agent/v1/transactions: a garbage bearer is a 401, never a visitor", async () => {
    const res = await call("GET", "/api/agent/v1/transactions?limit=1", { token: GARBAGE });
    expectStatus(res, 401);
    return "401";
  });
  check(
    "write path authz (nothing can move)",
    "POST /api/agent/v1/ships/purchase: valid session WITHOUT fleet:control is a 403",
    async () => {
      const res = await call("POST", "/api/agent/v1/ships/purchase", { token: noScope, body: "{}" });
      expectStatus(res, 403);
      expectJson(res);
      return "403 json";
    },
    { needs: ["NO_SCOPE_TOKEN"] },
  );
  check(
    "write path authz (nothing can move)",
    "GET /api/agent/v1/agent with the scopeless session is a 200 (reads need no scope)",
    async () => {
      const res = await call("GET", "/api/agent/v1/agent", { token: noScope });
      expectStatus(res, 200);
      return "200";
    },
    { needs: ["NO_SCOPE_TOKEN"] },
  );

  // Neighbours that share auth-service, unaffected by this cutover: they must not have moved.
  check("neighbours", "GET /api/automation/v1/autopilot/status, anonymous", async () => {
    const res = await call("GET", "/api/automation/v1/autopilot/status");
    expectStatus(res, 200);
    expectJson(res);
    return `200 json ${shape(res.json)}`;
  });
  // Its public reads ignore a stale token by design (a token riding along is never a 401 there), so the
  // introspection path is probed on a gated route with an empty body: auth answers first, and the
  // handler (which would only log an ai_ event for a valid body) is never reached.
  check("neighbours", "POST /api/automation/v1/events with an empty body: no header and garbage bearer are 401", async () => {
    const none = await call("POST", "/api/automation/v1/events", { body: "{}" });
    const bad = await call("POST", "/api/automation/v1/events", { token: GARBAGE, body: "{}" });
    expectStatus(none, 401, " (no header)");
    expectStatus(bad, 401, " (garbage bearer)");
    return "401, 401";
  });
  check("neighbours", "GET /api/fleet/v1/ships/{id}/cooldown: no header and garbage bearer are 401", async () => {
    const path = `/api/fleet/v1/ships/${PROBE_ID}/cooldown`;
    const none = await call("GET", path);
    const bad = await call("GET", path, { token: GARBAGE });
    expectStatus(none, 401, " (no header)");
    expectStatus(bad, 401, " (garbage bearer)");
    return "401, 401";
  });
  check(
    "neighbours",
    "GET /api/fleet/v1/ships/{id}/cooldown: the operator's session passes fleet-service's introspection",
    async () => {
      const res = await call("GET", `/api/fleet/v1/ships/${PROBE_ID}/cooldown`, { token: operator });
      if ([401, 403, 503].includes(res.status)) fail(`status ${res.status}: fleet-service refused a valid session`);
      return `${res.status} (any answer but 401/403/503 means the session got through)`;
    },
    { needs: needsOperator },
  );

  // Swagger: our API, not the Petstore demo. CloudFront does not route it, so it needs a direct URL.
  check(
    "swagger (direct to the host)",
    "GET /api/agent/swagger/ is our page and its spec is our API, not the Petstore",
    async () => {
      const page = await call("GET", "/api/agent/swagger/", { root: direct });
      expectStatus(page, 200);
      if (page.type !== "text/html") fail(`page content-type ${page.type}`);
      const init = await call("GET", "/api/agent/swagger/swagger-ui-init.js", { root: direct });
      expectStatus(init, 200);
      const has = (s) => init.text.includes(s);
      if (!has("Agent Info Service API")) fail("the spec behind the page is not named Agent Info Service API");
      if (!has("/api/agent/v1/transactions")) fail("the spec does not describe /api/agent/v1/transactions");
      if (/petstore/i.test(init.text)) fail("the page's script mentions the Petstore demo");
      const demo = await call("GET", "/api/agent/swagger/swagger-initializer.js", { root: direct });
      expectStatus(demo, 404, " (swagger-ui-dist's demo initializer must not be served)");
      return "200 html; spec is Agent Info Service API; demo initializer 404";
    },
    { needs: ["AGENT_DIRECT_URL"] },
  );

  // One healthy automation cycle, read from automation-service's public event log. Names and times only.
  check("automation cycle", "automation-service is armed and its event log shows a healthy cycle since SINCE", async () => {
    const status = await call("GET", "/api/automation/v1/autopilot/status");
    expectStatus(status, 200);
    expectJson(status);
    const lifecycle = typeof status.json.status === "string" ? status.json.status : "(no status member)";
    const mode = typeof status.json.mode === "string" ? status.json.mode : "none";
    if (lifecycle !== "armed") throw new Skip(`autopilot is ${lifecycle}, not armed, so no cycle runs (arming it is the owner's call, with the fleet:control token)`);
    const res = await call("GET", "/api/automation/v1/autopilot/events?limit=200");
    expectStatus(res, 200);
    expectJson(res);
    const events = Array.isArray(res.json?.events) ? res.json.events : fail("no events array in the answer");
    const recent = events.filter((e) => typeof e?.type === "string" && Date.parse(e.occurredAt) >= sinceMs);
    const count = {};
    for (const e of recent) count[e.type] = (count[e.type] ?? 0) + 1;
    const summary = Object.entries(count).sort().map(([t, n]) => `${t}x${n}`).join(" ") || "(none)";
    const errors = recent.filter((e) => ERROR_TYPES.has(e.type));
    if (errors.length > 0) fail(`error events since SINCE: ${summary}`);
    if (!recent.some((e) => CYCLE_TYPES.has(e.type))) fail(`armed (${mode}) but no cycle event since ${new Date(sinceMs).toISOString()}: ${summary}`);
    const warn = recent.filter((e) => WARN_TYPES.has(e.type)).length;
    return `armed (${mode}); events since SINCE: ${summary}${warn > 0 ? `; NOTE ${warn} action failure event(s): read them on the host` : ""}`;
  });
  check("automation cycle", "agent-service history since SINCE (automation's M2M writes land here)", async () => {
    const res = await call("GET", "/api/agent/v1/transactions?limit=20");
    expectStatus(res, 200);
    expectJson(res);
    const rows = Array.isArray(res.json) ? res.json : fail("no array");
    const times = rows.map((r) => Date.parse(r?.occurredAt)).filter((t) => !Number.isNaN(t));
    const since = times.filter((t) => t >= sinceMs).length;
    const newest = times.length > 0 ? new Date(Math.max(...times)).toISOString() : "none";
    // Informational: whether the fleet trades in the window is the planner's decision, not a defect of the deploy.
    return `${rows.length} newest rows, ${since} at or after SINCE, newest ${newest} (INFO: a quiet fleet writes nothing)`;
  });

  // ---- the owner's checklist: what no outside caller can see -------------------------------------

  const checklist = [
    "On the host (SSM session), these are the checks no outside caller can make:",
    "  1. the deployed image is the one under test:  docker inspect agent-service --format '{{.Config.Image}}'   (expect ghcr.io/v-m-pioneer-trading/agent-service:sha-<tip of the cutover PR>)",
    "  2. it is not restarting and the cap holds:   docker ps --filter name=agent-service --format '{{.Status}}'; docker stats --no-stream agent-service   (record RSS: size --memory from it)",
    "  3. its log has no introspection or gateway failure after the deploy:  docker logs --since 30m agent-service 2>&1 | grep -ciE 'error|503|refus'   (read what matches; the log never holds a token)",
    "  4. automation-service's M2M token goes through introspection: its calls to agent-service (reads every cycle, writes when it trades) must not fail:  docker logs --since 30m automation-service 2>&1 | grep -ciE '401|403|503'   (read what matches; the log never holds a token)",
    "  5. fleet-service's POST /contracts/{id}/deliveries with the forwarded bearer: do one delivery (or watch the next), then GET /api/agent/v1/contracts/{id}/deliveries (public) shows the new row, and fleet-service's log shows no 401/403 from agent-service.",
    "  6. st-gateway's token fetch (unaffected): a 200 from GET /api/agent/v1/current-agent above proves it, since without a credential the gateway answers 503.",
    "  7. Swagger, if AGENT_DIRECT_URL was not set:  curl -s http://127.0.0.1:80/api/agent/swagger/swagger-ui-init.js | grep -c 'Agent Info Service API'   (expect 1 or more; and  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:80/api/agent/swagger/swagger-initializer.js  must print 404)",
    "  8. rollback target, if any check is red:  imageTag=sha-65bb4b28b5392a370b6d011cdaa4aa831f739157  (the last Go image; see the PR description for the full command)",
  ];

  // ---- run --------------------------------------------------------------------------------------

  const configured = (names) => names.every((n) => (n === "OPERATOR_TOKEN" ? operator !== "" : n === "NO_SCOPE_TOKEN" ? noScope !== "" : n === "AGENT_DIRECT_URL" ? direct !== "" : true));
  say(`cutover probe: ${base}${direct ? ` and ${direct}` : ""}`);
  say(`OPERATOR_TOKEN: ${operator ? "set" : "unset"}; NO_SCOPE_TOKEN: ${noScope ? "set" : "unset"}; AGENT_DIRECT_URL: ${direct ? "set" : "unset"}; SINCE: ${new Date(sinceMs).toISOString()}`);

  if (dry) {
    say("--dry-run: nothing is called. The checks:");
    let group = "";
    for (const c of checks) {
      if (c.group !== group) {
        group = c.group;
        say(`\n[${group}]`);
      }
      say(`  ${configured(c.needs) ? "run " : "SKIP"}  ${c.name}${configured(c.needs) ? "" : `   (needs ${c.needs.filter((n) => !configured([n])).join(", ")})`}`);
    }
    say("");
    for (const line of checklist) say(line);
    return 0;
  }

  const tally = { pass: 0, fail: 0, skip: 0 };
  let group = "";
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      say(`\n[${group}]`);
    }
    if (!configured(c.needs)) {
      tally.skip++;
      say(`  SKIPPED  ${c.name}   (needs ${c.needs.filter((n) => !configured([n])).join(", ")}, not set)`);
      continue;
    }
    try {
      const detail = await c.fn();
      tally.pass++;
      say(`  PASS     ${c.name} -> ${detail}`);
    } catch (err) {
      if (err instanceof Skip) {
        tally.skip++;
        say(`  SKIPPED  ${c.name} -> ${err.message}`);
      } else {
        tally.fail++;
        const why = err instanceof Error ? (err.cause?.code ? `${err.message} (${err.cause.code})` : err.message) : "unknown error";
        say(`  FAIL     ${c.name} -> ${why}`);
      }
    }
  }
  say("");
  for (const line of checklist) say(line);
  say(`\n${tally.pass} passed, ${tally.fail} failed, ${tally.skip} skipped.`);
  if (tally.skip > 0) say("SKIPPED checks proved nothing: read each one above before calling the cutover green.");
  const failed = tally.fail > 0 || (flags.has("--strict") && tally.skip > 0);
  say(failed ? "RESULT: RED" : "RESULT: GREEN");
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2), process.env).then(
    // exitCode, not process.exit(): exiting with fetch handles still closing crashes Node on Windows.
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`probe crashed: ${err instanceof Error ? err.name : "error"}\n`);
      process.exitCode = 2;
    },
  );
}
