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

type Quirk = "validation-skipped" | "html-fallback" | "none";

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
    const refuse = () => json(401, { error: { message: "a bearer token is required" } });
    const p = url.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-headers": "Content-Type, Authorization" });
      return void res.end();
    }
    if (/^\/api\/[a-z-]+\/health$/.test(p)) return json(200, { status: "ok" });
    if (p === "/api/agent/v1/transactions") {
      if (who === "bad") return refuse();
      if (quirk === "html-fallback") {
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("<html>dashboard</html>");
      }
      return url.searchParams.get("type") === "NOPE" ? text(400, "type must be one of: PURCHASE") : json(200, []);
    }
    if (/^\/api\/agent\/v1\/contracts\/[^/]+\/deliveries$/.test(p) && req.method === "GET") return json(200, []);
    if (/^\/api\/agent\/v1\/(current-agent|agent|ships|contracts)$/.test(p)) return who === "none" || who === "bad" ? refuse() : json(200, p.endsWith("current-agent") ? { agent: {} } : []);
    if (req.method === "POST" && p.startsWith("/api/agent/v1/")) {
      if (who === "none" || who === "bad") return refuse();
      if (who === "noscope") return json(403, { error: { message: "missing scope" } });
      return quirk === "validation-skipped" ? json(201, {}) : text(400, "shipType and waypointSymbol are required");
    }
    if (p === "/api/automation/v1/autopilot/status") return json(200, { status: "armed", mode: "live" });
    if (p === "/api/automation/v1/autopilot/events") return json(200, { events: [{ type: "agent_credits_snapshot", occurredAt: new Date().toISOString(), detail: { secret: OPERATOR } }] });
    if (p === "/api/automation/v1/events") return refuse();
    if (p.startsWith("/api/fleet/v1/")) return who === "none" || who === "bad" ? refuse() : json(404, { error: { message: "no such ship" } });
    text(404, "404 page not found");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function probe(env: Record<string, string>, args: string[] = []): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 99;
      resolve({ code, out: stdout + stderr });
    });
  });
}

const urlOf = (s: http.Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
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
