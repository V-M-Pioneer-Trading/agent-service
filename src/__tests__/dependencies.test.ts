import fs from "node:fs";
import path from "node:path";

const { check, KNOWN_ALIASES } = require("../../scripts/check-dependencies") as {
  check: (pkg: any, lock: any, allow: string, opts?: { npmrc?: boolean }) => string[];
  KNOWN_ALIASES: Record<string, unknown>;
};

const root = path.join(__dirname, "..", "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const allow = read("allowed-dependencies.txt");
const fresh = () => ({ pkg: JSON.parse(read("package.json")), lock: JSON.parse(read("package-lock.json")) });
const problems = (pkg: any, lock: any, opts?: { npmrc?: boolean }) => check(pkg, lock, allow, opts).join("\n");

describe("the direct-dependency check", () => {
  it("passes on the repository as committed", () => {
    const { pkg, lock } = fresh();
    expect(check(pkg, lock, allow)).toEqual([]);
  });

  it("refuses an npm: alias spec for an allowed name", () => {
    const { pkg, lock } = fresh();
    pkg.devDependencies.supertest = "npm:evil-pkg@1.0.0";
    expect(problems(pkg, lock)).toMatch(/supertest: "npm:evil-pkg@1.0.0" is not a plain semver range/);
  });

  it.each(["github:attacker/jest", "git+https://example.test/jest.git", "file:../jest", "https://example.test/jest.tgz", "latest", "*"])(
    "refuses the spec %s",
    (spec) => {
      const { pkg, lock } = fresh();
      pkg.devDependencies.jest = spec;
      expect(problems(pkg, lock)).toMatch(/jest: ".*" is not a plain semver range/);
    },
  );

  it("refuses a dev dependency moved into dependencies (it would ship in the image)", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies.typescript = pkg.devDependencies.typescript;
    delete pkg.devDependencies.typescript;
    expect(problems(pkg, lock)).toMatch(/typescript is in dependencies but not in the \[dependencies\] section/);
  });

  it("refuses a name that is not on the allowlist, and an allowlisted name that is gone", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies.leftpad = "^1.0.0";
    delete pkg.dependencies.express;
    const out = problems(pkg, lock);
    expect(out).toMatch(/leftpad is in dependencies but not in the/);
    expect(out).toMatch(/express is on the \[dependencies\] allowlist but is not in dependencies/);
  });

  it("refuses a clerk-client from anywhere but its release tarball", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies["@v-m-pioneer-trading/clerk-client"] = "github:V-M-Pioneer-Trading/clerk-client";
    expect(problems(pkg, lock)).toMatch(/must be a clerk-client GitHub release tarball/);
  });

  it("refuses a lockfile entry resolved from anywhere but the registry or the release", () => {
    const { pkg, lock } = fresh();
    lock.packages["node_modules/supertest"].resolved = "https://evil.example.test/supertest-6.3.4.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/supertest resolves from https:\/\/evil\.example\.test/);
  });

  it("refuses express 5", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies.express = "^5.0.0";
    expect(problems(pkg, lock)).toMatch(/express must stay on major version 4/);
  });

  it("refuses overrides and resolutions, which rewrite what a name resolves to", () => {
    for (const key of ["overrides", "resolutions"]) {
      const { pkg, lock } = fresh();
      pkg[key] = { "body-parser": "npm:left-pad@1.3.0" };
      expect(problems(pkg, lock)).toContain(`package.json has ${key}`);
    }
  });

  it("refuses an .npmrc", () => {
    const { pkg, lock } = fresh();
    expect(problems(pkg, lock, { npmrc: true })).toMatch(/\.npmrc exists/);
    expect(check(pkg, lock, allow, { npmrc: false })).toEqual([]);
  });

  it.each([true, ["express"], { express: "^4" }, "express"])("refuses bundleDependencies / bundledDependencies in any truthy form: %j", (form) => {
    for (const key of ["bundleDependencies", "bundledDependencies"]) {
      const { pkg, lock } = fresh();
      pkg[key] = form;
      expect(problems(pkg, lock)).toContain(`package.json has ${key}`);
    }
  });

  it("refuses a lockfile entry installed under another name (what an override writes)", () => {
    const { pkg, lock } = fresh();
    lock.packages["node_modules/body-parser"].name = "left-pad";
    lock.packages["node_modules/body-parser"].resolved = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser is installed as "left-pad" under another name/);
  });

  it("refuses a resolved URL of another package even when the name field is absent", () => {
    const { pkg, lock } = fresh();
    lock.packages["node_modules/body-parser"].resolved = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser is "body-parser" but resolves from .*left-pad/);
  });

  it("pins the five aliases by path, name and version", () => {
    const a = fresh();
    for (const where of Object.keys(KNOWN_ALIASES)) expect(a.lock.packages[where]).toBeDefined();
    a.lock.packages["node_modules/strip-ansi-cjs"].name = "left-pad";
    expect(problems(a.pkg, a.lock)).toMatch(/strip-ansi-cjs is installed as "left-pad"/);

    const b = fresh();
    b.lock.packages["node_modules/evil-alias"] = { ...b.lock.packages["node_modules/strip-ansi-cjs"] };
    expect(problems(b.pkg, b.lock)).toMatch(/node_modules\/evil-alias is installed as "strip-ansi" under another name/);

    const c = fresh();
    c.lock.packages["node_modules/wrap-ansi-cjs"].version = "9.9.9";
    expect(problems(c.pkg, c.lock)).toMatch(/wrap-ansi-cjs is installed as "wrap-ansi" under another name/);
  });

  it.each([undefined, "sha1-abc=", "sha256-abc=", "md5-abc"])("requires a sha512 integrity on every resolved entry: %s", (integrity) => {
    const { pkg, lock } = fresh();
    if (integrity === undefined) delete lock.packages["node_modules/express"].integrity;
    else lock.packages["node_modules/express"].integrity = integrity;
    expect(problems(pkg, lock)).toMatch(/node_modules\/express has no sha512 integrity/);
  });
});
