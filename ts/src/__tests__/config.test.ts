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

describe("Go's verdict on 107 URL and secret inputs", () => {
  // [AUTH_INTROSPECTION_URL, AUTH_INTROSPECTION_SECRET, Go's verdict], recorded by running
  // strings.TrimSpace, url.Parse and the checks of introspection.LoadConfig (center.go:80-114)
  // on each input with the Go toolchain.
  const verdicts: Array<[string, string, "accept" | "refuse"]> = [
    ["http://center.internal:3005/auth/v1/introspect", "s", "accept"],
    ["http://center.internal:3005/auth/v1/introspect ", "s", "accept"],
    [" http://center.internal:3005/auth/v1/introspect", "s", "refuse"],
    ["http://center.internal\t/x", "s", "refuse"],
    ["http://center.internal/a\tb", "s", "refuse"],
    ["http://center.internal/a\nb", "s", "refuse"],
    ["http://cen\nter/x", "s", "refuse"],
    ["http://center.internal/%zz", "s", "refuse"],
    ["http://center.internal/%", "s", "refuse"],
    ["http://exa%41mple/", "s", "refuse"],
    ["http://exa%C3%A9mple/", "s", "accept"],
    ["http://exa%25mple/", "s", "accept"],
    ["http://:80/x", "s", "accept"],
    ["http://:80", "s", "accept"],
    ["http://center:99999/x", "s", "accept"],
    ["http://center:/x", "s", "accept"],
    ["http://center:abc/x", "s", "refuse"],
    ["http://center:8a/x", "s", "refuse"],
    ["1.2.3.4.5", "s", "refuse"],
    ["HTTP://Center/x", "s", "accept"],
    ["http://[::1]:80/x", "s", "accept"],
    ["http://[::1/x", "s", "refuse"],
    ["http://[::1]x/x", "s", "refuse"],
    ["http://[fe80::1%25en0]/x", "s", "accept"],
    ["http://[fe80::1%en0]/x", "s", "refuse"],
    ["http://cen ter/x", "s", "refuse"],
    ["http://cen{ter/x", "s", "refuse"],
    ["http://cen|ter/x", "s", "refuse"],
    ["http://cen\ter/x", "s", "refuse"],
    ["http://cen^ter/x", "s", "refuse"],
    ["http://cen`ter/x", "s", "refuse"],
    ["http://cen<ter>/x", "s", "accept"],
    ["http://cen\"ter/x", "s", "accept"],
    ["http://cen'ter/x", "s", "accept"],
    ["http://cen_ter/x", "s", "accept"],
    ["http://cen~ter/x", "s", "accept"],
    ["http://cen!ter/x", "s", "accept"],
    ["http://cen$ter/x", "s", "accept"],
    ["http://cen&ter/x", "s", "accept"],
    ["http://cen*ter/x", "s", "accept"],
    ["http://cen+ter/x", "s", "accept"],
    ["http://cen,ter/x", "s", "accept"],
    ["http://cen;ter/x", "s", "accept"],
    ["http://cen=ter/x", "s", "accept"],
    ["http://caf\u00e9/x", "s", "accept"],
    ["http:center/x", "s", "refuse"],
    ["http:/center/x", "s", "refuse"],
    ["http:///x", "s", "refuse"],
    ["http://", "s", "refuse"],
    ["http:", "s", "refuse"],
    ["://x/y", "s", "refuse"],
    ["h ttp://x/y", "s", "refuse"],
    ["-http://x/y", "s", "refuse"],
    ["1http://x/y", "s", "refuse"],
    ["h+t.t-p://x", "s", "refuse"],
    ["https://x/y", "s", "accept"],
    ["https://x", "s", "accept"],
    ["ftp://x/y", "s", "refuse"],
    ["http://x/y#", "s", "accept"],
    ["http://x/y#f", "s", "refuse"],
    ["http://x/y?", "s", "refuse"],
    ["http://x/y?a", "s", "refuse"],
    ["http://x/y#%zz", "s", "refuse"],
    ["http://u@x/y", "s", "refuse"],
    ["http://@x/y", "s", "refuse"],
    ["http://u:p@x/y", "s", "refuse"],
    ["http://x@/y", "s", "refuse"],
    ["http://x/a@b", "s", "accept"],
    ["http://x/a b", "s", "accept"],
    ["http://x/a%20b", "s", "accept"],
    ["http://x/\u00fc", "s", "accept"],
    ["http://x//", "s", "accept"],
    ["http://x/%41", "s", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\tret", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\nret", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\u007fret", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\u0000ret", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u0085", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\u0085secret", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u00a0", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\u00a0secret", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\ufeffsecret", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\ufeff", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u2028", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u200b", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u3000", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\u1680s", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "a b", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\u0085ret", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", " ", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\u0085", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\ufeff", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u180e", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u000b", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "s\f", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "\u200bs", "accept"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u2000", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u202f", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u205f", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u00e9cret", "accept"],
    ["\ufeffhttp://center.internal:3005/auth/v1/introspect", "s", "refuse"],
    ["http://center.internal:3005/auth/v1/introspect\u0085", "s", "accept"],
    ["\u0085", "s", "refuse"],
    ["\u00a0", "s", "refuse"],
    ["http://x/\u0085", "s", "accept"],
    ["http://x\u0085/", "s", "accept"],
    ["http://x/\ufeff", "s", "accept"],
  ];
  it.each(verdicts)("%j with secret %j: Go %s", (url, secret, verdict) => {
    const load = () => loadConfig({ AUTH_INTROSPECTION_URL: url, AUTH_INTROSPECTION_SECRET: secret });
    if (verdict === "accept") expect(load).not.toThrow();
    else expect(load).toThrow(ConfigError);
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
    expect(loadConfig(withEnv({ PORT: "000080" })).port).toBe(80);
    for (const bad of ["abc", "-1", "65536", "99999", "80.5", "0x50", "8 0"]) {
      expect(() => loadConfig(withEnv({ PORT: bad }))).toThrow(ConfigError);
    }
  });
});
