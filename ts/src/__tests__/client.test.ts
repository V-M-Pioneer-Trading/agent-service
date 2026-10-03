import http from "node:http";
import type { AddressInfo } from "node:net";
import { CallerGone, GatewayClient } from "../gateway/client";
import { fromHeaderValue, hostnameOf, isDomainOrSubdomain, resolveReference } from "../gateway/location";

interface Seen {
  method: string;
  url: string;
  auth: boolean;
}

/** A gateway client whose fetch answers from a script: hop i answers [status, Location]; the end is a 200. */
function scripted(hops: Array<[number, string]>, base = "http://gw:3002/proxy") {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit) => {
    seen.push({ method: init.method ?? "", url: String(url), auth: (init.headers as Record<string, string>)["Authorization"] !== undefined });
    const hop = hops[seen.length - 1];
    return new Response("{}", { status: hop?.[0] ?? 200, headers: hop === undefined ? {} : { Location: hop[1] } });
  }) as unknown as typeof fetch;
  return { seen, client: new GatewayClient(base, fetchImpl) };
}
const run = async (hops: Array<[number, string]>, base?: string) => {
  const { seen, client } = scripted(hops, base);
  const outcome = await client.getMyAgent({ authorization: "Bearer x" }).then(
    () => "ok",
    (e: Error) => e.message,
  );
  return { outcome, seen: seen.map((s) => `${s.method} ${s.url}${s.auth ? " +auth" : ""}`) };
};

describe("Authorization on redirects (Go 1.24, CVE-2024-45336)", () => {
  it("travels to the same host, another port, and a subdomain", async () => {
    expect((await run([[302, "http://gw:9999/x"]])).seen[1]).toBe("GET http://gw:9999/x +auth");
    expect((await run([[302, "http://sub.gw.example:3002/x"]], "http://gw.example:3002/proxy")).seen[1]).toBe("GET http://sub.gw.example:3002/x +auth");
  });

  it("is dropped by a hop that leaves the domain, and stays dropped when a later hop comes back", async () => {
    const back = await run([
      [302, "http://evil:3002/x"],
      [302, "http://gw:3002/y"],
    ]);
    expect(back.seen).toEqual(["GET http://gw:3002/proxy/my/agent +auth", "GET http://evil:3002/x", "GET http://gw:3002/y"]);
    const sub = await run([
      [302, "http://evil/x"],
      [302, "http://sub.gw/x"],
    ]);
    expect(sub.seen[2]).toBe("GET http://sub.gw/x");
  });

  it("is dropped for a host that merely ends with the gateway's name", async () => {
    expect((await run([[302, "http://evilgw/x"]])).seen[1]).toBe("GET http://evilgw/x");
    expect((await run([[302, "http://evilgw.example/x"]], "http://gw.example/proxy")).seen[1]).toBe("GET http://evilgw.example/x");
    expect((await run([[302, "http://www.gw.example/x"]], "http://gw.example/proxy")).seen[1]).toBe("GET http://www.gw.example/x +auth");
  });

  it("compares hosts as written, case included", async () => {
    expect((await run([[302, "http://GW:3002/x"]])).seen[1]).toBe("GET http://gw:3002/x");
    expect((await run([[302, "http://gw:3002/x"]], "http://GW:3002/proxy")).seen[1]).toBe("GET http://gw:3002/x");
    expect((await run([[302, "http://GW:3002/x"]], "http://GW:3002/proxy")).seen[1]).toBe("GET http://gw:3002/x +auth");
  });

  it("isDomainOrSubdomain and hostnameOf are Go's", () => {
    expect(isDomainOrSubdomain("a.gw", "gw")).toBe(true);
    expect(isDomainOrSubdomain("agw", "gw")).toBe(false);
    expect(isDomainOrSubdomain("gw", "a.gw")).toBe(false);
    expect([hostnameOf("gw:3002"), hostnameOf("[::1]:80"), hostnameOf("gw")]).toEqual(["gw", "::1", "gw"]);
  });
});

describe("Authorization where the subdomain rule would be wrong, or the scheme gets weaker (stricter than Go)", () => {
  it("a single-label gateway host gets no subdomains", async () => {
    const base = "http://st-gateway:3002/proxy";
    expect((await run([[302, "http://st-gateway:9999/x"]], base)).seen[1]).toBe("GET http://st-gateway:9999/x +auth");
    expect((await run([[302, "http://x.st-gateway:3002/x"]], base)).seen[1]).toBe("GET http://x.st-gateway:3002/x");
    expect((await run([[302, "http://x.st-gateway/x"]], "http://st-gateway/proxy")).seen[1]).toBe("GET http://x.st-gateway/x");
  });

  it("an IP gateway host gets no subdomains either, and is still itself", async () => {
    const base = "http://10.0.0.5:3002/proxy";
    expect((await run([[302, "http://10.0.0.5:9/x"]], base)).seen[1]).toBe("GET http://10.0.0.5:9/x +auth");
    expect((await run([[302, "http://[::1]:9/x"]], "http://[::1]:3002/proxy")).seen[1]).toBe("GET http://[::1]:9/x +auth");
  });

  it("a name with dots keeps the subdomain rule", async () => {
    expect((await run([[302, "http://www.gw.example/x"]], "http://gw.example/proxy")).seen[1]).toBe("GET http://www.gw.example/x +auth");
  });

  it("an https to http downgrade on the same host drops Authorization for good", async () => {
    const hops = await run([[302, "http://gw:3002/a"]], "https://gw:3002/proxy");
    expect(hops.seen).toEqual(["GET https://gw:3002/proxy/my/agent +auth", "GET http://gw:3002/a"]);
    const back = await run(
      [
        [302, "http://gw:3002/a"],
        [302, "https://gw:3002/b"],
      ],
      "https://gw:3002/proxy",
    );
    expect(back.seen[2]).toBe("GET https://gw:3002/b");
    expect((await run([[302, "https://gw:3002/a"]], "http://gw:3002/proxy")).seen[1]).toBe("GET https://gw:3002/a +auth");
  });
});

describe("Location is read like Go's url.Parse", () => {
  const base = { url: new URL("http://gw:3002/proxy/my/agent"), host: "gw:3002" };
  const at = (loc: string) => resolveReference(base, loc)?.url.href ?? null;

  it.each([
    ["/%zz"], ["/a%"], ["/x#%zz"], ["/a\u0001b"], ["/a\tb"], ["/a\u007fb"], ["http://gw:abc/x"], ["http://g\tw/x"], ["http://g w/x"], ["http://gw\\x/y"], ["a b:c"], [":x"], ["mailto:x@y"], [" http://evil/x"],
    // A scheme needs a host of its own: Go cannot send these, WHATWG would read a host into them.
    ["http:/evil/x"], ["https:/evil/x"], ["HTTPS:/evil/x"], ["HtTp:/evil/x"], ["http:///x"], ["https:///evil/x"], ["http:\\\\evil\\x"], ["ftp://gw/x"], ["javascript://gw/x"],
    // Credentials are never forwarded to a redirect target (Go would send them as Basic auth).
    ["http://u:p@evil/x"], ["//u@evil/x"], ["http://evil.com\\x@gw/x"], ["http://gw@evil/x"], ["http://gw:3002@evil/x"],
    // A percent escape in a host that stands for an ASCII character is refused by Go.
    ["http://%41w/x"], ["http://g%zzw/x"], ["http://[fe80::1%25en0]/x"],
  ])("refuses %j", (loc) => {
    expect(at(loc)).toBeNull();
  });

  it("keeps a path that starts with slashes a path on the gateway, whatever WHATWG would make of it", () => {
    for (const loc of ["///evil/x", "////evil/x", "/////evil/x"]) {
      const t = resolveReference(base, loc);
      expect([t?.url.hostname, t?.url.port, t?.host]).toEqual(["gw", "3002", "gw:3002"]);
      expect(t?.url.pathname).toBe(loc);
    }
  });

  it("keeps a backslash a path character", () => {
    expect(at("\\\\evil\\x")).toBe("http://gw:3002/proxy/my/%5C%5Cevil%5Cx");
    expect(at("/a\\b/c")).toBe("http://gw:3002/a%5Cb/c");
    expect(at("/ok?q=a\\b")).toBe("http://gw:3002/ok?q=a\\b");
  });

  it("resolves like Go: an empty authority is no authority, dot segments go, the fragment goes", () => {
    expect(at("//?q")).toBe("http://gw:3002/proxy/my/agent?q");
    expect(at("//#f")).toBe("http://gw:3002/proxy/my/agent");
    expect(at("/..//a")).toBe("http://gw:3002/a");
    expect(at("../z")).toBe("http://gw:3002/proxy/z");
    expect(at("/x?%zz")).toBe("http://gw:3002/x?%zz");
    expect(at("//evil/x")).toBe("http://evil/x");
    expect(at("/x#frag")).toBe("http://gw:3002/x");
    expect(at("?only=query")).toBe("http://gw:3002/proxy/my/agent?only=query");
  });

  it("takes a scheme and a host as they come, and lets the host's percent escapes stand for UTF-8", () => {
    expect(resolveReference(base, "HTTPS://Evil.Example:8443/p")?.host).toBe("Evil.Example:8443");
    expect(resolveReference(base, "HTTPS://Evil.Example:8443/p")?.url.href).toBe("https://evil.example:8443/p");
    const accent = resolveReference(base, "http://g%C3%A9w.example/x");
    expect([accent?.host, accent?.url.hostname]).toEqual(["géw.example", "xn--gw-bja.example"]);
  });

  it("reads header bytes, not characters: a byte above 0x7f is an escape", () => {
    expect(fromHeaderValue(Buffer.from("/café", "utf8").toString("latin1"))).toBe("/caf%C3%A9");
    expect(at(fromHeaderValue(Buffer.from("/café", "utf8").toString("latin1")))).toBe("http://gw:3002/caf%C3%A9");
    expect(resolveReference(base, fromHeaderValue(Buffer.from("http://gé.example/", "utf8").toString("latin1")))?.host).toBe("gé.example");
  });

  it("a Location Go refuses is 'st-gateway did not answer'", async () => {
    expect((await run([[302, "/%zz"]])).outcome).toBe("st-gateway did not answer");
    expect((await run([[302, "http://gw:abc/"]])).outcome).toBe("st-gateway did not answer");
    expect((await run([[302, "https:/evil/x"]])).outcome).toBe("st-gateway did not answer");
  });

  it("repeated Location headers: the first one counts, as in Go", async () => {
    expect((await run([[302, "http://gw:3002/first, http://evil/second"]])).seen[1]).toBe("GET http://gw:3002/first +auth");
  });

  it("non-ASCII bytes in a Location are escaped once, not twice", async () => {
    const latin1 = Buffer.from("/café", "utf8").toString("latin1");
    expect((await run([[302, latin1]])).seen[1]).toBe("GET http://gw:3002/caf%C3%A9 +auth");
  });
});

describe("the caller's Authorization never reaches another listener (real fetch, two servers)", () => {
  const servers: http.Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });
  const listen = async (handler: http.RequestListener): Promise<number> => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };

  it("holds for every Location that WHATWG and Go read differently", async () => {
    const evilSaw: Array<string | undefined> = [];
    const evilPort = await listen((req, res) => {
      evilSaw.push(req.headers.authorization);
      res.end("{}");
    });
    let location = "";
    const gwSaw: string[] = [];
    const gwPort = await listen((req, res) => {
      if (req.url?.startsWith("/proxy/")) {
        res.writeHead(302, { Location: location });
      } else {
        gwSaw.push(`${req.url}`);
        res.setHeader("content-type", "application/json");
      }
      res.end("{}");
    });
    const client = new GatewayClient(`http://127.0.0.1:${gwPort}/proxy`);
    const evil = `localhost:${evilPort}`;
    const locations = [
      `///${evil}/x`, `////${evil}/x`, `https:/${evil}/x`, `HTTPS:/${evil}/x`, `http:/${evil}/x`, `http:///${evil}/x`, `//${evil}/x`, `http://${evil}/x`,
      `http://${evil}\\x@127.0.0.1:${gwPort}/x`, `http://127.0.0.1:${gwPort}\\@${evil}/x`, `http://x\\@${evil}/x`, `http://u:p@${evil}/x`, `\\\\${evil}\\x`, `/\\${evil}/x`, `//${evil}\\x`,
      `http://127.0.0.1.${evil}/x`, `http://x${evil}/x`, `//?@${evil}`, `//#@${evil}`,
    ];
    for (const l of locations) {
      location = l;
      await client.getMyAgent({ authorization: "Bearer SECRET" }).catch(() => undefined);
    }
    expect(evilSaw.filter((a) => a !== undefined)).toEqual([]);
    expect(gwSaw.length).toBeGreaterThan(0);
  });

  it("and stays off at the gateway after a hop to another host and back", async () => {
    const seen: Array<string | undefined> = [];
    let gwPort = 0;
    const evilPort = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${gwPort}/back` });
      res.end();
    });
    gwPort = await listen((req, res) => {
      if (req.url?.startsWith("/proxy/")) res.writeHead(302, { Location: `http://localhost:${evilPort}/x` });
      else seen.push(req.headers.authorization);
      res.end("{}");
    });
    await new GatewayClient(`http://127.0.0.1:${gwPort}/proxy`).getMyAgent({ authorization: "Bearer SECRET" });
    expect(seen).toEqual([undefined]);
  });
});

describe("a caller who hangs up", () => {
  const abortable = ((_url: URL, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error("aborted"));
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;

  it("cancels the call, and it is not the gateway's fault", async () => {
    const gone = new AbortController();
    setTimeout(() => gone.abort(), 5);
    await expect(new GatewayClient("http://gw/proxy", abortable).getMyAgent({ authorization: "", signal: gone.signal })).rejects.toBeInstanceOf(CallerGone);
  });

  it("one that has already gone is just as gone", async () => {
    const gone = new AbortController();
    gone.abort();
    await expect(new GatewayClient("http://gw/proxy", abortable).getMyShips({ authorization: "", signal: gone.signal })).rejects.toBeInstanceOf(CallerGone);
  });
});

describe("a finished call leaves no timer behind", () => {
  afterEach(() => jest.useRealTimers());

  it("clears the 30 s deadline when the answer is in, and when the call fails", async () => {
    jest.useFakeTimers();
    const ok = new GatewayClient("http://gw/proxy", (async () => new Response("{}")) as unknown as typeof fetch);
    await ok.getMyAgent({ authorization: "" });
    expect(jest.getTimerCount()).toBe(0);
    const failing = new GatewayClient("http://gw/proxy", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch);
    await expect(failing.getMyAgent({ authorization: "" })).rejects.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });
});
