import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

// scripts/cutover-probe.mjs against a stub that plays the public domain. It pins what matters about a
// probe that runs against production with a real token: it passes against a correct service, it fails
// when the write path misbehaves, and no token ever reaches its output.

const script = path.join(__dirname, "..", "..", "scripts", "cutover-probe.mjs");
const part = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const OPERATOR = `${part({ alg: "RS256" })}.${part({ sub: "user_VALUE_MUST_NOT_PRINT", iat: 1, exp: 4102444800 })}.signature-part-EEEEEEEEEEEE`;
const NO_SCOPE = "scopeless-session-token-DDDDDDDDDDDDDDDDDDD";

type Quirk = "validation-skipped" | "html-fallback" | "go-image" | "none" | keyof typeof AUTOPILOT;

// What GET /autopilot/status and the one event in the log say, per autopilot quirk. "none" is armed live with a credits snapshot.
const AUTOPILOT = {
  "live-assignment": { status: "armed", mode: "live", event: "planner_assignment" },
  "live-shadow-evidence": { status: "armed", mode: "live", event: "planner_shadow_assignment" },
  shadow: { status: "armed", mode: "shadow", event: "planner_shadow_assignment" },
  "shadow-live-evidence": { status: "armed", mode: "shadow", event: "agent_credits_snapshot" },
  "shadow-other-event": { status: "armed", mode: "shadow", event: "planner_assignment" },
  disarmed: { status: "disarmed", mode: null, event: "planner_shadow_assignment" },
  paused: { status: "paused", mode: "shadow", event: "planner_shadow_assignment" },
} as const;
const autopilotOf = (q: Quirk) => (q in AUTOPILOT ? AUTOPILOT[q as keyof typeof AUTOPILOT] : { status: "armed", mode: "live", event: "agent_credits_snapshot" });

function stub(quirk: Quirk): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const auth = req.headers.authorization;
    const who = auth === undefined ? "none" : auth === `Bearer ${OPERATOR}` ? "operator" : auth === `Bearer ${NO_SCOPE}` ? "noscope" : "bad";
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const text = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    };
    const refuse = () => { json(401, { error: { message: "a bearer token is required" } }); };
    const p = url.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-headers": "Content-Type, Authorization" });
      return void res.end();
    }
    if (/^\/api\/[a-z-]+\/health$/.test(p)) { json(200, { status: "ok" }); return; }
    if (p === "/api/agent/v1/transactions") {
      if (who === "bad") { refuse(); return; }
      if (quirk === "html-fallback") {
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("<html>dashboard</html>");
      }
      if (url.searchParams.get("type") === "NOPE") text(400, "type must be one of: PURCHASE"); else json(200, []); return;
    }
    if (/^\/api\/agent\/v1\/contracts\/[^/]+\/deliveries$/.test(p) && req.method === "GET") { json(200, []); return; }
    if (/^\/api\/agent\/v1\/(current-agent|agent|ships|contracts)$/.test(p)) { if (who === "none" || who === "bad") refuse(); else json(200, p.endsWith("current-agent") ? { agent: {} } : []); return; }
    if (req.method === "POST" && p.startsWith("/api/agent/v1/")) {
      if (who === "none" || who === "bad") { refuse(); return; }
      if (who === "noscope") { json(403, { error: { message: "missing scope" } }); return; }
      if (quirk === "validation-skipped") json(201, {}); else text(400, "shipType and waypointSymbol are required"); return;
    }
    if (p === "/api/automation/v1/autopilot/status") { json(200, { status: autopilotOf(quirk).status, mode: autopilotOf(quirk).mode }); return; }
    if (p === "/api/automation/v1/autopilot/events") { json(200, { events: [{ type: autopilotOf(quirk).event, occurredAt: new Date().toISOString(), detail: { secret: OPERATOR } }] }); return; }
    if (p === "/api/automation/v1/events") { refuse(); return; }
    if (p.startsWith("/api/fleet/v1/")) { if (who === "none" || who === "bad") refuse(); else json(404, { error: { message: "no such ship" } }); return; }
    if (p === "/api/agent/swagger/") {
      res.writeHead(200, { "content-type": "text/html" });
      return void res.end("<html>swagger-ui</html>");
    }
    if (p === "/api/agent/swagger/swagger-ui-init.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      return void res.end(quirk === "go-image" ? "" : "var spec = {info:{title:\"Agent Info Service API\"},paths:{\"/api/agent/v1/transactions\":{}}}");
    }
    text(404, "404 page not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { resolve(server); }));
}

function probe(env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 99;
      resolve({ code, out: stdout + stderr });
    });
  });
}

const urlOf = (s: http.Server): string => `http://127.0.0.1:${String((s.address() as AddressInfo).port)}`;
const open: http.Server[] = [];
afterAll(() => Promise.all(open.map((s) => new Promise((r) => s.close(r)))));
const serve = async (q: Quirk) => {
  const s = await stub(q);
  open.push(s);
  return urlOf(s);
};

describe("scripts/cutover-probe.mjs", () => {
  it("is green against a correct service and prints neither token", async () => {
    const base = await serve("none");
    const { code, out } = await probe({ BASE_URL: base, OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE });
    expect(out).toContain("RESULT: GREEN");
    expect(code).toBe(0);
    expect(out).not.toMatch(/FAIL\s/);
    for (const secret of [OPERATOR, NO_SCOPE, ...OPERATOR.split(".")]) expect(out).not.toContain(secret);
    expect(out).not.toMatch(/Bearer\s+\S{16,}/);
    expect(out).toContain("claims: exp,iat,sub");
    expect(out).not.toContain("user_VALUE_MUST_NOT_PRINT");
  });

  it("skips, loudly, what it cannot check, and --strict turns that into a failure", async () => {
    const base = await serve("none");
    const lax = await probe({ BASE_URL: base, OPERATOR_TOKEN: OPERATOR });
    expect(lax.code).toBe(0);
    expect(lax.out).toMatch(/SKIPPED .*WITHOUT fleet:control.*NO_SCOPE_TOKEN/);
    expect(lax.out).toContain("SKIPPED checks proved nothing");
    const strict = await probe({ BASE_URL: base, OPERATOR_TOKEN: OPERATOR }, ["--strict"]);
    expect(strict.code).toBe(1);
  });

  it("is green with --strict when every input is given, the Swagger check included", async () => {
    const base = await serve("none");
    const { code, out } = await probe({ BASE_URL: base, AGENT_DIRECT_URL: base, OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE }, ["--strict"]);
    expect(out).toContain("RESULT: GREEN");
    expect(code).toBe(0);
    expect(out).toContain("spec is Agent Info Service API");
  });

  it("--strict fails without AGENT_DIRECT_URL, so a run against Go cannot pass; --allow-skip names what may stay unset", async () => {
    const base = await serve("none");
    const env = { BASE_URL: base, OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE };
    expect((await probe(env, ["--strict"])).code).toBe(1);
    expect((await probe(env, ["--strict", "--allow-skip=AGENT_DIRECT_URL"])).code).toBe(0);
    expect((await probe({ BASE_URL: base, AGENT_DIRECT_URL: base, OPERATOR_TOKEN: OPERATOR }, ["--strict"])).code).toBe(1);
    expect((await probe({ BASE_URL: base, AGENT_DIRECT_URL: base, OPERATOR_TOKEN: OPERATOR }, ["--strict", "--allow-skip=NO_SCOPE_TOKEN"])).code).toBe(0);
  });

  it("fails the identity check on an image that does not serve the TypeScript Swagger page", async () => {
    const base = await serve("go-image");
    const { code, out } = await probe({ BASE_URL: base, AGENT_DIRECT_URL: base, OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE }, ["--strict"]);
    expect(code).toBe(1);
    expect(out).toContain("Agent Info Service API");
  });

  it("takes the cycle evidence the reported mode writes: live agent_credits_snapshot or planner_assignment, shadow planner_shadow_assignment", async () => {
    for (const quirk of ["none", "live-assignment", "shadow"] as const) {
      const { code, out } = await probe({ BASE_URL: await serve(quirk), OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE });
      expect([quirk, out]).toEqual([quirk, expect.stringContaining(`armed (${String(autopilotOf(quirk).mode)}); events since SINCE`)]);
      expect([quirk, code]).toEqual([quirk, 0]);
    }
  });

  it("refuses the other mode's evidence, or any other event, as proof of the cycle", async () => {
    const cases = [
      ["live-shadow-evidence", "armed (live) but no agent_credits_snapshot or planner_assignment event (the planner_shadow_assignment in the window predate"],
      ["shadow-live-evidence", "armed (shadow) but no planner_shadow_assignment event (the agent_credits_snapshot in the window predate"],
      ["shadow-other-event", "armed (shadow) but no planner_shadow_assignment event (the planner_assignment in the window predate"],
    ] as const;
    for (const [quirk, why] of cases) {
      const { code, out } = await probe({ BASE_URL: await serve(quirk), OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE });
      expect([quirk, code]).toEqual([quirk, 1]);
      expect(out).toContain(why);
    }
  });

  it("fails, with how to arm it, when the autopilot is not armed", async () => {
    for (const quirk of ["disarmed", "paused"] as const) {
      const { code, out } = await probe({ BASE_URL: await serve(quirk), OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE });
      expect([quirk, code]).toEqual([quirk, 1]);
      expect(out).toMatch(/FAIL .*autopilot is (disarmed|paused \(shadow\)), not armed/);
      expect(out).toContain('POST /api/automation/v1/autopilot/arm {"mode":"shadow"}');
    }
  });

  it("fails when a write with an empty body is accepted, and says so without printing the token", async () => {
    const base = await serve("validation-skipped");
    const { code, out } = await probe({ BASE_URL: base, OPERATOR_TOKEN: OPERATOR, NO_SCOPE_TOKEN: NO_SCOPE });
    expect(code).toBe(1);
    expect(out).toContain("RESULT: RED");
    expect(out).toContain("Validation did not run");
    expect(out).not.toContain(OPERATOR);
  });

  it("fails on CloudFront's dashboard fallback instead of reading it as a 200", async () => {
    const base = await serve("html-fallback");
    const { code, out } = await probe({ BASE_URL: base, OPERATOR_TOKEN: OPERATOR });
    expect(code).toBe(1);
    expect(out).toContain("text/html");
  });

  it("fails when nothing answers", async () => {
    const { code, out } = await probe({ BASE_URL: "http://127.0.0.1:9", OPERATOR_TOKEN: OPERATOR });
    expect(code).toBe(1);
    expect(out).toContain("FAIL");
  });

  it("--dry-run lists the checks, calls nothing and needs no token", async () => {
    const { code, out } = await probe({ BASE_URL: "http://127.0.0.1:9", OPERATOR_TOKEN: OPERATOR }, ["--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("--dry-run: nothing is called");
    expect(out).toContain("POST /api/agent/v1/ships/purchase");
    expect(out).not.toContain(OPERATOR);
    expect((await probe({ BASE_URL: "http://127.0.0.1:9" }, ["--dry-run"])).code).toBe(0);
  });

  it("refuses to run without OPERATOR_TOKEN", async () => {
    const { code, out } = await probe({ BASE_URL: "http://127.0.0.1:9" });
    expect(code).toBe(2);
    expect(out).toContain("OPERATOR_TOKEN is not set");
  });
});
