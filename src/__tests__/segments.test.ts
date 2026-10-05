import type express from "express";
import request from "supertest";
import { routePolicy } from "../auth";
import { lastSegmentOf, segmentFromEnd } from "../http/muxCompat";
import { createTestApp } from "../testSupport/createTestApp";

// A probe route reports the decoded path's segments, counted from the end, as bytes in hex.
function probe() {
  return createTestApp({
    policy: { ...routePolicy, "GET /api/agent/v1/probe/:a/:b": "none" },
    registerRoutes: (r) => { (r.get as (p: string, h: unknown) => void)("/api/agent/v1/probe/:a/:b", (req: express.Request, res: express.Response) => {
        res.json({
          last: lastSegmentOf(req).toString("hex"),
          fromEnd: [0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => segmentFromEnd(req, n).toString("hex")),
        });
      }); },
  }).app;
}
const hex = (s: string): string => Buffer.from(s, "latin1").toString("hex");

describe("segmentFromEnd: mux.Vars of a variable that a literal follows", () => {
  it("counts the decoded path's segments from the end", async () => {
    const res = await request(probe()).get("/api/agent/v1/probe/one/two");
    const body = res.body as { last: string; fromEnd: string[] };
    expect(body.last).toBe(hex("two"));
    expect(body.fromEnd).toEqual([hex("two"), hex("one"), hex("probe"), hex("v1"), hex("agent"), hex("api"), "", "", "", ""]);
  });

  it("past the first segment there is nothing, however far it asks", async () => {
    const res = await request(probe()).get("/api/agent/v1/probe/a/b");
    expect((res.body as { fromEnd: string[] }).fromEnd.slice(6)).toEqual(["", "", "", ""]);
  });

  it("a segment is the decoded bytes: %20 is a space, %FF is the byte, %2F is a slash and so splits it", async () => {
    const a = await request(probe()).get("/api/agent/v1/probe/a%20b/%FF");
    expect((a.body as { fromEnd: string[] }).fromEnd.slice(0, 2)).toEqual([hex("\xff"), hex("a b")]);
    const b = await request(probe()).get("/api/agent/v1/probe/a%2Fb/c");
    expect(b.status).toBe(404);
  });
});
