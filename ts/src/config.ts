/**
 * @file Environment configuration, with the same variables, defaults and
 * refusals as the Go service (src/app-runner.go, src/db/db.go,
 * src/spacetraders/client.go, src/introspection/center.go). No new variable.
 *
 * An error thrown from here ends the process with status 1 before a port is
 * bound (server.ts), like `log.Fatal` in Go. No message echoes the secret.
 *
 * AUTH_INTROSPECTION_URL is accepted when Go's url.Parse and LoadConfig accept
 * it (the patched Go 1.25.x parser: golang:1.25-alpine builds the image) AND it
 * is fetch-identical. The second rule is intentionally STRICTER than Go:
 * clerk-client calls fetch(url), and WHATWG URL rewrites or rejects many URLs Go
 * sends as written (a trailing space is stripped, `0x7f.1` becomes 127.0.0.1, a
 * soft hyphen vanishes, dot segments are resolved, `http://:80/x` and port 99999
 * throw, and clerk-client swallows the throw into a 503 on every request). A URL
 * whose `new URL(raw).href` is not the URL itself (bar the case of the scheme and
 * host, and a "/" for an empty path) is refused at start, exit 1, instead.
 */
import { isIPv6 } from "node:net";

import type { IntrospectionConfig } from "@v-m-pioneer-trading/clerk-client";

export const ENV_URL = "AUTH_INTROSPECTION_URL";
export const ENV_SECRET = "AUTH_INTROSPECTION_SECRET";

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Go's getEnv: unset and empty both mean "use the fallback". */
const getEnv = (env: Env, key: string, fallback: string): string => {
  const value = env[key];
  return value === undefined || value === "" ? fallback : value;
};

const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

/** Go's unicode.IsSpace. JS' trim() differs: it strips U+FEFF and keeps U+0085. */
const isGoSpace = (code: number): boolean =>
  (code >= 0x09 && code <= 0x0d) ||
  code === 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;

/** Go's strings.TrimSpace. */
export function goTrimSpace(s: string): string {
  const cps = [...s];
  let start = 0;
  let end = cps.length;
  while (start < end && isGoSpace(cps[start]!.codePointAt(0)!)) start++;
  while (end > start && isGoSpace(cps[end - 1]!.codePointAt(0)!)) end--;
  return cps.slice(start, end).join("");
}

const isAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c);
const hex2 = /^[0-9A-Fa-f]{2}$/;
/** Go's shouldEscape for a host (and a zone): what an ASCII byte may be without an escape. */
const hostSafe = (c: string): boolean => /^[A-Za-z0-9_.~!$&'()*+,;=:[\]<>"-]$/.test(c);

/** Go's unescape(s, encodeHost) / encodePath, as a yes-or-no. */
function validEscapes(s: string, mode: "host" | "zone" | "path"): boolean {
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "%") {
      const h = chars.slice(i + 1, i + 3).join("");
      if (!hex2.test(h)) return false;
      // In a host an escape may only stand for a non-ASCII byte (or be %25).
      if (mode === "host" && parseInt(h, 16) < 0x80 && h !== "25") return false;
      i += 2;
    } else if (mode !== "path" && c.charCodeAt(0) < 0x80 && !hostSafe(c)) {
      return false;
    }
  }
  return true;
}

/** Go's validOptionalPort: "" or ":" followed by digits. Not range-checked. */
const validOptionalPort = (p: string): boolean => p === "" || /^:[0-9]*$/.test(p);

/**
 * Go's parseHost, as patched for CVE-2025-47912 (Go 1.25.2 and later, what the
 * image builds with): a "[" anywhere but the first byte is an error, and what
 * is inside the brackets, once unescaped, must be an IPv6 address (with an
 * optional, non-empty zone), not an IPv4 address, an IPvFuture or nothing.
 */
function validHost(host: string): boolean {
  if (host.indexOf("[", 1) !== -1) return false;
  if (host.startsWith("[")) {
    const close = host.lastIndexOf("]");
    if (close < 0 || !validOptionalPort(host.slice(close + 1))) return false;
    const inside = host.slice(1, close);
    const zoneAt = inside.indexOf("%25");
    const address = zoneAt >= 0 ? inside.slice(0, zoneAt) : inside;
    if (!validEscapes(address, "host") || !isIPv6(address)) return false;
    if (zoneAt >= 0) {
      const zone = inside.slice(zoneAt + 3);
      if (zone === "" || !validEscapes(zone, "zone")) return false;
    }
    return validEscapes(host.slice(close), "host");
  }
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && !validOptionalPort(host.slice(colon))) return false;
  return validEscapes(host, "host");
}

/**
 * Whether fetch would send this URL as written. `rewritten` is a reason, null means identical.
 * Only the case of the scheme and host, and a "/" for an empty path, may differ.
 */
function fetchProblem(raw: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(raw);
  let href: string;
  try {
    href = new URL(raw).href;
  } catch {
    href = "";
  }
  if (m !== null && href !== "") {
    const rest = m[3] ?? "";
    const path = rest === "" || rest.startsWith("#") ? `/${rest}` : rest;
    if (href === `${(m[1] ?? "").toLowerCase()}://${(m[2] ?? "").toLowerCase()}${path}`) return null;
  }
  return `${ENV_URL} would be rewritten (or refused) by fetch; write it in its normalised form, with no trailing space, default port, dot segment or escape that WHATWG URL would change`;
}

/**
 * Go's url.Parse followed by the checks of introspection.LoadConfig, as a
 * verdict: null when Go accepts the URL, else why not. Not WHATWG: it keeps a
 * tab-stripping, host-normalising parser out of a security-relevant decision.
 */
function urlProblem(raw: string): string | null {
  const absolute = `${ENV_URL} must be an absolute URL, for example http://localhost:3005/auth/v1/introspect`;
  for (const c of raw) if (isControl(c.codePointAt(0)!)) return `${ENV_URL} must not contain control characters`;
  // getScheme
  let scheme = "";
  let rest = raw;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (isAlpha(c)) continue;
    if (/[0-9+.-]/.test(c) && i > 0) continue;
    if (c === ":" && i > 0) {
      scheme = raw.slice(0, i).toLowerCase();
      rest = raw.slice(i + 1);
    }
    break;
  }
  if (scheme === "") return absolute;
  const hash = rest.indexOf("#");
  const fragment = hash === -1 ? "" : rest.slice(hash + 1);
  if (hash !== -1) rest = rest.slice(0, hash);
  if (!rest.startsWith("//")) return absolute; // opaque, or a path with no host
  if (scheme !== "http" && scheme !== "https") return `${ENV_URL} must use http or https, not "${scheme}"`;
  if (rest.includes("?") || fragment !== "") return `${ENV_URL} must be a plain endpoint URL with no query string or fragment`;
  const slash = rest.indexOf("/", 2);
  const authority = rest.slice(2, slash === -1 ? undefined : slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  if (authority.includes("@")) return `${ENV_URL} must not carry credentials; the secret travels in ${ENV_SECRET}`;
  if (authority === "" || !validHost(authority) || !validEscapes(path, "path")) return absolute;
  return null;
}

/**
 * AUTH_INTROSPECTION_URL and _SECRET, validated exactly as Go's
 * introspection.LoadConfig does (Go's TrimSpace, Go's url.Parse), then also requires
 * the URL to be fetch-identical (see the file header; stricter than Go on purpose). clerk-client's own
 * loader is not used: it trims the secret and goes through WHATWG URL, so it
 * accepts what Go refuses (userinfo, an empty "?", a fragment, "http:///x",
 * a tab inside the URL) and refuses what Go accepts ("http://:80/x").
 * clerk-client is not modified; the validated pair is just the
 * IntrospectionConfig it takes.
 */
export function loadAuthConfig(env: Env): IntrospectionConfig {
  const rawUrl = env[ENV_URL] ?? "";
  if (goTrimSpace(rawUrl) === "") throw new ConfigError(`${ENV_URL} is required — refusing to start without it`);
  const secret = env[ENV_SECRET] ?? "";
  if (goTrimSpace(secret) === "") throw new ConfigError(`${ENV_SECRET} is required — refusing to start without it`);
  if (secret !== goTrimSpace(secret) || [...secret].some((c) => isControl(c.codePointAt(0)!))) {
    throw new ConfigError(`${ENV_SECRET} must not contain surrounding whitespace or control characters`);
  }
  const problem = urlProblem(rawUrl) ?? fetchProblem(rawUrl);
  if (problem !== null) throw new ConfigError(problem);
  return { url: rawUrl, secret };
}

export interface MySqlConfig {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface Config {
  readonly port: number;
  /** ST_GATEWAY_URL with every trailing slash trimmed and "/proxy" appended. */
  readonly gatewayProxyUrl: string;
  readonly corsAllowedOrigin: string;
  readonly introspection: IntrospectionConfig;
  /** Read here so the variables and defaults are pinned; connected to from the persistence PR. */
  readonly mysql: MySqlConfig;
}

export const DEFAULT_PORT = "80";
export const DEFAULT_GATEWAY_URL = "http://localhost:3002";
export const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

/** Go's `":" + port` fails to listen on anything that is not a TCP port; Node would treat a word as a pipe name. */
const parsePort = (raw: string): number => {
  if (!/^[0-9]+$/.test(raw) || Number(raw) > 65535) {
    throw new ConfigError(`PORT must be a TCP port number, got "${raw}"`);
  }
  return Number(raw);
};

export function loadConfig(env: Env = process.env): Config {
  // Introspection first, like Go: it is instant and must fail within the
  // bootstrap script's liveness window.
  const introspection = loadAuthConfig(env);
  return {
    port: parsePort(getEnv(env, "PORT", DEFAULT_PORT)),
    gatewayProxyUrl: getEnv(env, "ST_GATEWAY_URL", DEFAULT_GATEWAY_URL).replace(/\/+$/, "") + "/proxy",
    corsAllowedOrigin: getEnv(env, "CORS_ALLOWED_ORIGIN", DEFAULT_CORS_ORIGIN),
    introspection,
    mysql: {
      host: getEnv(env, "MYSQL_HOST", "mysql"),
      port: getEnv(env, "MYSQL_PORT", "3306"),
      user: getEnv(env, "MYSQL_USER", "root"),
      password: getEnv(env, "MYSQL_PASSWORD", "example"),
      database: getEnv(env, "MYSQL_DATABASE", "vnm-agent-db"),
    },
  };
}
