/**
 * @file Environment configuration, with the same variables, defaults and
 * refusals as the Go service (src/app-runner.go, src/db/db.go,
 * src/spacetraders/client.go, src/introspection/center.go). No new variable.
 *
 * An error thrown from here ends the process with status 1 before a port is
 * bound (server.ts), like `log.Fatal` in Go. No message echoes the secret.
 */

import { loadIntrospectionConfig, type IntrospectionConfig } from "@v-m-pioneer-trading/clerk-client";

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

/**
 * AUTH_INTROSPECTION_URL and _SECRET, validated exactly as Go's
 * introspection.LoadConfig does, and only then handed to clerk-client.
 *
 * clerk-client's own loader is laxer: it trims the secret, and accepts a URL
 * with userinfo, an empty "?", a fragment or no host (`http:///x` parses as
 * host "x" under WHATWG). The contract suite (suites/startup.ts) pins Go's
 * refusals, so they are applied here, before clerk-client sees the values.
 * clerk-client is not modified and its own checks still run afterwards.
 */
export function loadAuthConfig(env: Env): IntrospectionConfig {
  const rawUrl = env[ENV_URL] ?? "";
  if (rawUrl.trim() === "") throw new ConfigError(`${ENV_URL} is required — refusing to start without it`);
  const secret = env[ENV_SECRET] ?? "";
  if (secret.trim() === "") throw new ConfigError(`${ENV_SECRET} is required — refusing to start without it`);
  if (secret !== secret.trim() || [...secret].some((c) => isControl(c.codePointAt(0) ?? 0))) {
    throw new ConfigError(`${ENV_SECRET} must not contain surrounding whitespace or control characters`);
  }

  const bad = `${ENV_URL} must be an absolute URL, for example http://localhost:3005/auth/v1/introspect`;
  // Go's url.Parse: a scheme, then "//" and a non-empty host.
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(rawUrl);
  if (m === null || rawUrl !== rawUrl.trim()) throw new ConfigError(bad);
  const scheme = (m[1] ?? "").toLowerCase();
  const authority = m[2] ?? "";
  if (authority.includes("@")) {
    throw new ConfigError(`${ENV_URL} must not carry credentials; the secret travels in ${ENV_SECRET}`);
  }
  if (authority === "") throw new ConfigError(bad);
  if (scheme !== "http" && scheme !== "https") {
    throw new ConfigError(`${ENV_URL} must use http or https, not "${scheme}"`);
  }
  const afterAuthority = rawUrl.slice(m[0].length);
  // Any "?" is a query (also an empty one, Go's ForceQuery); a non-empty "#x" is a fragment.
  if (afterAuthority.includes("?") || /#./.test(afterAuthority)) {
    throw new ConfigError(`${ENV_URL} must be a plain endpoint URL with no query string or fragment`);
  }
  try {
    return loadIntrospectionConfig({ [ENV_URL]: rawUrl, [ENV_SECRET]: secret });
  } catch (err) {
    // clerk-client's messages never carry the secret either.
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
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
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) {
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
