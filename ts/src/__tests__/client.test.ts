import { CallerGone, GatewayClient } from "../gateway/client";
import { hostnameOf, isDomainOrSubdomain, resolveReference } from "../gateway/location";

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
    expect((await run([[302, "http://sub.gw:3002/x"]])).seen[1]).toBe("GET http://sub.gw:3002/x +auth");
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

describe("Location is read like Go's url.Parse", () => {
  const at = (loc: string) => resolveReference({ url: new URL("http://gw:3002/proxy/my/agent"), host: "gw:3002" }, loc)?.url.href ?? null;

  it.each([["/%zz"], ["/a%"], ["/x#%zz"], ["/a\u0001b"], ["/a\tb"], ["/a\u007fb"], ["http://gw:abc/x"], ["http://g\tw/x"], ["http://g w/x"], ["http://gw\\x/y"], ["a b:c"], [":x"], ["mailto:x@y"], [" http://evil/x"]])(
    "refuses %j",
    (loc) => {
      expect(at(loc)).toBeNull();
    },
  );

  it("keeps a backslash a path character", () => {
    expect(at("\\\\evil\\x")).toBe("http://gw:3002/proxy/my/%5C%5Cevil%5Cx");
    expect(at("/a\\b/c")).toBe("http://gw:3002/a%5Cb/c");
    expect(at("/ok?q=a\\b")).toBe("http://gw:3002/ok?q=a\\b");
  });

  it("accepts a bad escape in the query, resolves like a URL, drops the fragment", () => {
    expect(at("/x?%zz")).toBe("http://gw:3002/x?%zz");
    expect(at("//evil/x")).toBe("http://evil/x");
    expect(at("../z")).toBe("http://gw:3002/proxy/z");
    expect(at("/x#frag")).toBe("http://gw:3002/x");
  });

  it("a Location Go refuses is 'st-gateway did not answer'", async () => {
    expect((await run([[302, "/%zz"]])).outcome).toBe("st-gateway did not answer");
    expect((await run([[302, "http://gw:abc/"]])).outcome).toBe("st-gateway did not answer");
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
