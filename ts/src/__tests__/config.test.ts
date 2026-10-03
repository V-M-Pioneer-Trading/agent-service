import { ConfigError, loadConfig, type Env } from "../config";

const base: Env = {
  AUTH_INTROSPECTION_URL: "http://center.internal:3005/auth/v1/introspect",
  AUTH_INTROSPECTION_SECRET: "s3cret",
};
const withEnv = (extra: Env): Env => ({ ...base, ...extra });

describe("the introspection variables are validated exactly as the Go service does", () => {
  // Every case below is one clerk-client's own loader accepts or words differently
  // (it trims the secret, accepts userinfo, an empty "?", a fragment, "http:///x"),
  // and one the contract suite (suites/startup.ts) pins as a refusal.
  const refused: Array<[string, Env]> = [
    ["no URL", { AUTH_INTROSPECTION_URL: undefined }],
    ["an empty URL", { AUTH_INTROSPECTION_URL: "" }],
    ["a blank URL", { AUTH_INTROSPECTION_URL: "   " }],
    ["no secret", { AUTH_INTROSPECTION_SECRET: undefined }],
    ["an empty secret", { AUTH_INTROSPECTION_SECRET: "" }],
    ["a blank secret", { AUTH_INTROSPECTION_SECRET: "   " }],
    ["a secret with a leading space", { AUTH_INTROSPECTION_SECRET: " secret" }],
    ["a secret with a trailing space", { AUTH_INTROSPECTION_SECRET: "secret " }],
    ["a secret with a control character", { AUTH_INTROSPECTION_SECRET: "sec\tret" }],
    ["a secret with DEL", { AUTH_INTROSPECTION_SECRET: "sec\x7fret" }],
    ["a URL that is not a URL", { AUTH_INTROSPECTION_URL: "not a url" }],
    ["a URL without a scheme", { AUTH_INTROSPECTION_URL: "localhost:3005/auth/v1/introspect" }],
    ["a relative URL", { AUTH_INTROSPECTION_URL: "/auth/v1/introspect" }],
    ["another scheme", { AUTH_INTROSPECTION_URL: "ftp://center.internal/auth/v1/introspect" }],
    ["no host", { AUTH_INTROSPECTION_URL: "http:///auth/v1/introspect" }],
    ["credentials", { AUTH_INTROSPECTION_URL: "http://user:pw@center.internal/auth/v1/introspect" }],
    ["a user name only", { AUTH_INTROSPECTION_URL: "http://user@center.internal/auth/v1/introspect" }],
    ["a query", { AUTH_INTROSPECTION_URL: "http://center.internal/auth/v1/introspect?x=1" }],
    ["an empty query", { AUTH_INTROSPECTION_URL: "http://center.internal/auth/v1/introspect?" }],
    ["a fragment", { AUTH_INTROSPECTION_URL: "http://center.internal/auth/v1/introspect#x" }],
    ["leading whitespace in the URL", { AUTH_INTROSPECTION_URL: " http://center.internal/auth/v1/introspect" }],
  ];
  it.each(refused)("refuses %s", (_name, extra) => {
    expect(() => loadConfig(withEnv(extra))).toThrow(ConfigError);
  });

  it("never echoes the secret", () => {
    for (const secret of [" padded-secret-value ", "tab\tvalue-secret"]) {
      try {
        loadConfig(withEnv({ AUTH_INTROSPECTION_SECRET: secret }));
        throw new Error("should have refused");
      } catch (err) {
        expect(String((err as Error).message)).not.toContain(secret.trim());
      }
    }
  });

  it("accepts a plain endpoint and hands clerk-client the URL verbatim", () => {
    expect(loadConfig(base).introspection).toEqual({ url: base.AUTH_INTROSPECTION_URL, secret: "s3cret" });
    expect(loadConfig(withEnv({ AUTH_INTROSPECTION_URL: "https://center.internal/x#" })).introspection.url).toBe("https://center.internal/x#");
  });
});

describe("the other variables keep Go's defaults", () => {
  it("defaults", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(80);
    expect(c.corsAllowedOrigin).toBe("http://localhost:3000");
    expect(c.gatewayProxyUrl).toBe("http://localhost:3002/proxy");
    expect(c.mysql).toEqual({ host: "mysql", port: "3306", user: "root", password: "example", database: "vnm-agent-db" });
  });

  it("empty means unset", () => {
    const c = loadConfig(withEnv({ PORT: "", CORS_ALLOWED_ORIGIN: "", ST_GATEWAY_URL: "", MYSQL_HOST: "" }));
    expect([c.port, c.corsAllowedOrigin, c.gatewayProxyUrl, c.mysql.host]).toEqual([80, "http://localhost:3000", "http://localhost:3002/proxy", "mysql"]);
  });

  it("ST_GATEWAY_URL: every trailing slash trimmed, /proxy appended, a path kept as a prefix", () => {
    expect(loadConfig(withEnv({ ST_GATEWAY_URL: "http://gw:3002/" })).gatewayProxyUrl).toBe("http://gw:3002/proxy");
    expect(loadConfig(withEnv({ ST_GATEWAY_URL: "http://gw:3002////" })).gatewayProxyUrl).toBe("http://gw:3002/proxy");
    expect(loadConfig(withEnv({ ST_GATEWAY_URL: "http://gw:3002/prefix/" })).gatewayProxyUrl).toBe("http://gw:3002/prefix/proxy");
  });

  it("CORS_ALLOWED_ORIGIN is used verbatim", () => {
    expect(loadConfig(withEnv({ CORS_ALLOWED_ORIGIN: "*" })).corsAllowedOrigin).toBe("*");
  });

  it("PORT must be a TCP port: Node would otherwise listen on a pipe called 'abc'", () => {
    expect(loadConfig(withEnv({ PORT: "8080" })).port).toBe(8080);
    for (const bad of ["abc", "-1", "65536", "80.5", "0x50", "8 0"]) {
      expect(() => loadConfig(withEnv({ PORT: bad }))).toThrow(ConfigError);
    }
  });
});
