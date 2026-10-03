import fs from "node:fs";
import path from "node:path";
import { routePolicy } from "../auth";

// The policy table and the OpenAPI spec describe the same routes. tsoa's spec
// is generated from the controllers, so a controller route with no policy entry
// shows here as well as at startup, and a stale policy entry shows as a route
// the spec no longer has.
describe("routePolicy and openapi.json", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "openapi.json"), "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const specRoutes = Object.entries(spec.paths)
    .flatMap(([p, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${p.replace(/\{(\w+)\}/g, ":$1")}`))
    .sort();

  it("name exactly the same routes", () => {
    expect(Object.keys(routePolicy).sort()).toEqual(specRoutes);
  });
});
