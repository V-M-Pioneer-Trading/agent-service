import { ConfigError, loadConfig, urlProblem, type Env } from "../config";

const base: Env = {
  AUTH_INTROSPECTION_URL: "http://center.internal:3005/auth/v1/introspect",
  AUTH_INTROSPECTION_SECRET: "s3cret",
};
const withEnv = (extra: Env): Env => ({ ...base, ...extra });

describe("the introspection variables are validated exactly as the Go service does", () => {
  // Every case below is one clerk-client's own loader accepts or words differently
  // (it trims the secret, accepts userinfo, an empty "?", a fragment, "http:///x"),
  // and one the contract suite (suites/startup.ts) pins as a refusal.
  const refused: [string, Env][] = [
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
        expect((err as Error).message).not.toContain(secret.trim());
      }
    }
  });

  it("accepts a plain endpoint and hands clerk-client the URL verbatim", () => {
    expect(loadConfig(base).introspection).toEqual({ url: base.AUTH_INTROSPECTION_URL, secret: "s3cret" });
    expect(loadConfig(withEnv({ AUTH_INTROSPECTION_URL: "https://center.internal/x#" })).introspection.url).toBe("https://center.internal/x#");
  });
});

describe("159 URL and secret inputs: Go's verdict, and whether fetch sends the URL as written", () => {
  // [AUTH_INTROSPECTION_URL, AUTH_INTROSPECTION_SECRET, Go's verdict, fetch].
  // Go's verdict was recorded by running strings.TrimSpace, url.Parse and the checks of
  // introspection.LoadConfig (center.go:80-114) on each input with go version go1.25.14 windows/amd64
  // (the patched parser; golang:1.25-alpine builds the image). "fetch" is whether
  // new URL(raw).href equals the input but for the case of scheme and host and a "/" for an empty path.
  // The service accepts an input only if Go accepts it AND fetch sends it as written: stricter than Go on purpose.
  const verdicts: [string, string, "accept" | "refuse", "same" | "rewritten" | "n/a"][] = [
    ["http://center.internal:3005/auth/v1/introspect", "s", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect ", "s", "accept", "rewritten"],
    [" http://center.internal:3005/auth/v1/introspect", "s", "refuse", "n/a"],
    ["http://center.internal\t/x", "s", "refuse", "n/a"],
    ["http://center.internal/a\tb", "s", "refuse", "n/a"],
    ["http://center.internal/a\nb", "s", "refuse", "n/a"],
    ["http://cen\nter/x", "s", "refuse", "n/a"],
    ["http://center.internal/%zz", "s", "refuse", "n/a"],
    ["http://center.internal/%", "s", "refuse", "n/a"],
    ["http://exa%41mple/", "s", "refuse", "n/a"],
    ["http://exa%C3%A9mple/", "s", "accept", "rewritten"],
    ["http://exa%25mple/", "s", "accept", "rewritten"],
    ["http://:80/x", "s", "accept", "rewritten"],
    ["http://:80", "s", "accept", "rewritten"],
    ["http://center:99999/x", "s", "accept", "rewritten"],
    ["http://center:/x", "s", "accept", "rewritten"],
    ["http://center:abc/x", "s", "refuse", "n/a"],
    ["http://center:8a/x", "s", "refuse", "n/a"],
    ["1.2.3.4.5", "s", "refuse", "n/a"],
    ["HTTP://Center/x", "s", "accept", "same"],
    ["http://[::1]:80/x", "s", "accept", "rewritten"],
    ["http://[::1/x", "s", "refuse", "n/a"],
    ["http://[::1]x/x", "s", "refuse", "n/a"],
    ["http://[fe80::1%25en0]/x", "s", "accept", "rewritten"],
    ["http://[fe80::1%en0]/x", "s", "refuse", "n/a"],
    ["http://cen ter/x", "s", "refuse", "n/a"],
    ["http://cen{ter/x", "s", "refuse", "n/a"],
    ["http://cen|ter/x", "s", "refuse", "n/a"],
    ["http://cen\ter/x", "s", "refuse", "n/a"],
    ["http://cen^ter/x", "s", "refuse", "n/a"],
    ["http://cen`ter/x", "s", "refuse", "n/a"],
    ["http://cen<ter>/x", "s", "accept", "rewritten"],
    ["http://cen\"ter/x", "s", "accept", "same"],
    ["http://cen'ter/x", "s", "accept", "same"],
    ["http://cen_ter/x", "s", "accept", "same"],
    ["http://cen~ter/x", "s", "accept", "same"],
    ["http://cen!ter/x", "s", "accept", "same"],
    ["http://cen$ter/x", "s", "accept", "same"],
    ["http://cen&ter/x", "s", "accept", "same"],
    ["http://cen*ter/x", "s", "accept", "same"],
    ["http://cen+ter/x", "s", "accept", "same"],
    ["http://cen,ter/x", "s", "accept", "same"],
    ["http://cen;ter/x", "s", "accept", "same"],
    ["http://cen=ter/x", "s", "accept", "same"],
    ["http://caf\u00e9/x", "s", "accept", "rewritten"],
    ["http:center/x", "s", "refuse", "n/a"],
    ["http:/center/x", "s", "refuse", "n/a"],
    ["http:///x", "s", "refuse", "n/a"],
    ["http://", "s", "refuse", "n/a"],
    ["http:", "s", "refuse", "n/a"],
    ["://x/y", "s", "refuse", "n/a"],
    ["h ttp://x/y", "s", "refuse", "n/a"],
    ["-http://x/y", "s", "refuse", "n/a"],
    ["1http://x/y", "s", "refuse", "n/a"],
    ["h+t.t-p://x", "s", "refuse", "n/a"],
    ["https://x/y", "s", "accept", "same"],
    ["https://x", "s", "accept", "same"],
    ["ftp://x/y", "s", "refuse", "n/a"],
    ["http://x/y#", "s", "accept", "same"],
    ["http://x/y#f", "s", "refuse", "n/a"],
    ["http://x/y?", "s", "refuse", "n/a"],
    ["http://x/y?a", "s", "refuse", "n/a"],
    ["http://x/y#%zz", "s", "refuse", "n/a"],
    ["http://u@x/y", "s", "refuse", "n/a"],
    ["http://@x/y", "s", "refuse", "n/a"],
    ["http://u:p@x/y", "s", "refuse", "n/a"],
    ["http://x@/y", "s", "refuse", "n/a"],
    ["http://x/a@b", "s", "accept", "same"],
    ["http://x/a b", "s", "accept", "rewritten"],
    ["http://x/a%20b", "s", "accept", "same"],
    ["http://x/\u00fc", "s", "accept", "rewritten"],
    ["http://x//", "s", "accept", "same"],
    ["http://x/%41", "s", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\tret", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\nret", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\u007fret", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\u0000ret", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u0085", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\u0085secret", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u00a0", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\u00a0secret", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\ufeffsecret", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\ufeff", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u2028", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u200b", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "secret\u3000", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\u1680s", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "a b", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "sec\u0085ret", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", " ", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\u0085", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\ufeff", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u180e", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u000b", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "s\f", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "\u200bs", "accept", "same"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u2000", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u202f", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u205f", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect", "s\u00e9cret", "accept", "same"],
    ["\ufeffhttp://center.internal:3005/auth/v1/introspect", "s", "refuse", "n/a"],
    ["http://center.internal:3005/auth/v1/introspect\u0085", "s", "accept", "rewritten"],
    ["\u0085", "s", "refuse", "n/a"],
    ["\u00a0", "s", "refuse", "n/a"],
    ["http://x/\u0085", "s", "accept", "rewritten"],
    ["http://x\u0085/", "s", "accept", "rewritten"],
    ["http://x/\ufeff", "s", "accept", "rewritten"],
    ["http://[1.2.3.4]/x", "s", "refuse", "n/a"],
    ["http://[v1.x]/x", "s", "refuse", "n/a"],
    ["http://[]/x", "s", "refuse", "n/a"],
    ["http://a[b/x", "s", "refuse", "n/a"],
    ["http://[::1]]/x", "s", "refuse", "n/a"],
    ["http://[fe80::1%25]/x", "s", "refuse", "n/a"],
    ["http://[::1]/x", "s", "accept", "same"],
    ["http://[::ffff:1.2.3.4]/x", "s", "accept", "rewritten"],
    ["http://[2001:db8::1]:8080/x", "s", "accept", "same"],
    ["http://[::1]:/x", "s", "accept", "rewritten"],
    ["http://x[/y", "s", "refuse", "n/a"],
    ["http://x]/y", "s", "accept", "rewritten"],
    ["http://[::1]a/x", "s", "refuse", "n/a"],
    ["http://[%3A%3A1]/x", "s", "refuse", "n/a"],
    ["http://[fe80::1%25en0]:80/x", "s", "accept", "rewritten"],
    ["http://[fe80::1%25%65n0]/x", "s", "accept", "rewritten"],
    ["http://[:::1]/x", "s", "refuse", "n/a"],
    ["http://[1::2::3]/x", "s", "refuse", "n/a"],
    ["http://center.internal/x ", "s", "accept", "rewritten"],
    ["http://0x7f.1/x", "s", "accept", "rewritten"],
    ["http://127.1/x", "s", "accept", "rewritten"],
    ["http://2130706433/x", "s", "accept", "rewritten"],
    ["http://ce\u00adnter/x", "s", "accept", "rewritten"],
    ["http://x/a/../b", "s", "accept", "rewritten"],
    ["http://x/a/./b", "s", "accept", "rewritten"],
    ["http://x:80/x", "s", "accept", "rewritten"],
    ["https://x:443/x", "s", "accept", "rewritten"],
    ["http://x:8080/x", "s", "accept", "same"],
    ["http://x:0080/x", "s", "accept", "rewritten"],
    ["http://x/a b", "s", "accept", "rewritten"],
    ["http://x/\u00fc", "s", "accept", "rewritten"],
    ["http://x/%7e", "s", "accept", "same"],
    ["http://x/%7E", "s", "accept", "same"],
    ["http://X/x", "s", "accept", "same"],
    ["HTTPS://X.Y:81/x", "s", "accept", "same"],
    ["http://x", "s", "accept", "same"],
    ["http://x#", "s", "accept", "same"],
    ["http://x/#", "s", "accept", "same"],
    ["http://x/y#", "s", "accept", "same"],
    ["http://x\\y", "s", "refuse", "n/a"],
    ["http://x/a\\b", "s", "accept", "rewritten"],
    ["http://x/a|b", "s", "accept", "same"],
    ["http://x/a{b}", "s", "accept", "rewritten"],
    ["http://x/a\"b", "s", "accept", "rewritten"],
    ["http://x/a<b>", "s", "accept", "rewritten"],
    ["http://x/`", "s", "accept", "rewritten"],
    ["http://x.y./z", "s", "accept", "same"],
    ["http://xn--nxasmq6b/z", "s", "accept", "same"],
    ["http://caf\u00e9/x", "s", "accept", "rewritten"],
    ["http://CAF\u00c9/x", "s", "accept", "rewritten"],
    ["http://a_b/x", "s", "accept", "same"],
    ["http://a%2Db/x", "s", "refuse", "n/a"],
  ];
  // The Go layer alone, without the fetch rule that would refuse many of these anyway.
  it.each(verdicts.filter(([, secret]) => secret === "s"))("%j: the Go rules alone say %s", (url, _secret, go) => {
    expect(urlProblem(url) === null).toBe(go === "accept");
  });

  it.each(verdicts)("%j with secret %j: Go %s, fetch %s", (url, secret, go, fetch) => {
    const load = () => loadConfig({ AUTH_INTROSPECTION_URL: url, AUTH_INTROSPECTION_SECRET: secret });
    if (go === "accept" && fetch === "same") expect(load).not.toThrow();
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
