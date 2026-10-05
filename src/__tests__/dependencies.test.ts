import fs from "node:fs";
import path from "node:path";

import { check, KNOWN_ALIASES } from "../../scripts/check-dependencies.cjs";

interface Entry {
  version?: string;
  resolved?: string;
  integrity?: string;
  name?: string;
  link?: boolean;
}
interface Pkg {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  [key: string]: unknown;
}
interface Lock {
  packages: Record<string, Entry>;
}

const root = path.join(__dirname, "..", "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const allow = read("allowed-dependencies.txt");
const fresh = () => ({ pkg: JSON.parse(read("package.json")) as Pkg, lock: JSON.parse(read("package-lock.json")) as Lock });
const problems = (pkg: Pkg, lock: Lock, opts?: { npmrc?: boolean }) => check(pkg, lock, allow, opts).join("\n");
/** The lockfile entry at a path, which the committed lockfile must have. */
const entry = (lock: Lock, where: string): Entry => {
  const e = lock.packages[where];
  if (e === undefined) throw new Error(`package-lock.json has no ${where}`);
  return e;
};
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

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
    pkg.dependencies.typescript = must(pkg.devDependencies.typescript);
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
    entry(lock, "node_modules/supertest").resolved = "https://evil.example.test/supertest-6.3.4.tgz";
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
    entry(lock, "node_modules/body-parser").name = "left-pad";
    entry(lock, "node_modules/body-parser").resolved = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser is installed as "left-pad" under another name/);
  });

  it("refuses a resolved URL of another package even when the name field is absent", () => {
    const { pkg, lock } = fresh();
    entry(lock, "node_modules/body-parser").resolved = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser is "body-parser" but resolves from .*left-pad/);
  });

  it("refuses a resolved URL that only starts with the right prefix (path traversal to another package)", () => {
    const { pkg, lock } = fresh();
    const e = entry(lock, "node_modules/body-parser");
    e.resolved = "https://registry.npmjs.org/body-parser/-/../../left-pad/-/left-pad-1.3.0.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser resolves from .*which contains/);
  });

  it("refuses a resolved URL of the right package but another version than the entry says", () => {
    const { pkg, lock } = fresh();
    const e = entry(lock, "node_modules/body-parser");
    e.resolved = "https://registry.npmjs.org/body-parser/-/body-parser-0.0.1.tgz";
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser is "body-parser" but resolves from .*body-parser-0\.0\.1\.tgz, not/);
  });

  it.each(["%2e%2e/", "?x=1", "#x", "\\x"])("refuses %s in a resolved URL", (junk) => {
    const { pkg, lock } = fresh();
    const e = entry(lock, "node_modules/body-parser");
    e.resolved = must(e.resolved) + junk;
    expect(problems(pkg, lock)).toMatch(/node_modules\/body-parser resolves from .*which contains/);
  });

  it("accepts a scoped package and a pinned alias at their exact tarball URLs", () => {
    const { pkg, lock } = fresh();
    const scoped = Object.entries(lock.packages).find(([k, e]) => /node_modules\/@[^/]+\/[^/]+$/.test(k) && e.resolved?.startsWith("https://registry"));
    expect(scoped).toBeDefined();
    expect(entry(lock, "node_modules/string-width-cjs").resolved).toBe("https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz");
    expect(check(pkg, lock, allow)).toEqual([]);
  });

  it("refuses workspaces in package.json", () => {
    for (const ws of [["packages/*"], { packages: ["x"] }, []]) {
      const { pkg, lock } = fresh();
      pkg.workspaces = ws;
      expect(problems(pkg, lock)).toContain("package.json has workspaces");
    }
  });

  it("refuses a link entry in the lockfile, with or without a resolved URL", () => {
    const a = fresh();
    a.lock.packages["node_modules/evil"] = { resolved: "packages/evil", link: true };
    expect(problems(a.pkg, a.lock)).toMatch(/node_modules\/evil is a link entry/);
    const b = fresh();
    b.lock.packages["node_modules/evil"] = { link: true };
    expect(problems(b.pkg, b.lock)).toMatch(/node_modules\/evil is a link entry/);
  });

  it("refuses clerk-client's lockfile resolved when it differs from package.json's URL (npm would then skip the integrity check)", () => {
    const { pkg, lock } = fresh();
    entry(lock, "node_modules/@v-m-pioneer-trading/clerk-client").resolved = "https://github.com/V-M-Pioneer-Trading/clerk-client/releases/download/v9.9.9/x.tgz";
    entry(lock, "node_modules/@v-m-pioneer-trading/clerk-client").integrity = "sha512-AAAA";
    expect(problems(pkg, lock)).toMatch(/clerk-client resolves from .*v9\.9\.9.*not from the URL package\.json declares/);
  });

  it("refuses clerk-client's lockfile version when it differs from the version in its release URL", () => {
    const { pkg, lock } = fresh();
    entry(lock, "node_modules/@v-m-pioneer-trading/clerk-client").version = "2.0.0";
    expect(problems(pkg, lock)).toMatch(/clerk-client is version 2\.0\.0 but its release URL is 2\.0\.1/);
  });

  it("refuses any other entry resolved to a clerk-client release asset", () => {
    const { pkg, lock } = fresh();
    entry(lock, "node_modules/express").resolved = must(entry(lock, "node_modules/@v-m-pioneer-trading/clerk-client").resolved);
    expect(problems(pkg, lock)).toMatch(/node_modules\/express resolves from .*not registry\.npmjs\.org/);
  });

  it("keeps the committed lockfile's clerk-client entry in step with package.json", () => {
    const { pkg, lock } = fresh();
    const e = entry(lock, "node_modules/@v-m-pioneer-trading/clerk-client");
    expect(e.resolved).toBe(pkg.dependencies["@v-m-pioneer-trading/clerk-client"]);
    expect(e.resolved).toContain("/v" + must(e.version) + "/");
  });

  describe("the eslint-config release tarball (meta#105)", () => {
    const ESLINT = "@v-m-pioneer-trading/eslint-config";
    const ESLINT_PATH = "node_modules/@v-m-pioneer-trading/eslint-config";
    const CLERK = "@v-m-pioneer-trading/clerk-client";
    const release = (version: string, repo = "eslint-config") =>
      `https://github.com/V-M-Pioneer-Trading/${repo}/releases/download/v${version}/v-m-pioneer-trading-${repo}-${version}.tgz`;

    it("is admitted as committed: a release URL in devDependencies, resolved exactly there", () => {
      const { pkg, lock } = fresh();
      const e = entry(lock, ESLINT_PATH);
      expect(pkg.devDependencies[ESLINT]).toBe(e.resolved);
      expect(e.resolved).toContain("/v" + must(e.version) + "/");
      expect(check(pkg, lock, allow)).toEqual([]);
    });

    it.each([
      ["a semver range", "^1.0.0"],
      ["a git spec", "github:V-M-Pioneer-Trading/eslint-config"],
      ["another repository's release", release("1.0.0", "evil-config")],
      ["another owner's release", "https://github.com/attacker/eslint-config/releases/download/v1.0.0/x.tgz"],
      ["clerk-client's release", release("2.0.1", "clerk-client")],
      ["a file spec", "file:../eslint-config"],
    ])("refuses %s as its spec", (_what, spec) => {
      const { pkg, lock } = fresh();
      pkg.devDependencies[ESLINT] = spec;
      expect(problems(pkg, lock)).toMatch(/eslint-config must be an eslint-config GitHub release tarball URL in devDependencies/);
    });

    it("refuses it in dependencies, where it would ship in the image", () => {
      const { pkg, lock } = fresh();
      pkg.dependencies[ESLINT] = must(pkg.devDependencies[ESLINT]);
      delete pkg.devDependencies["@v-m-pioneer-trading/eslint-config"];
      expect(problems(pkg, lock)).toMatch(/eslint-config must be an eslint-config GitHub release tarball URL in devDependencies/);
    });

    it("refuses clerk-client's slot for an eslint-config URL, and the other way round", () => {
      const a = fresh();
      a.pkg.dependencies[CLERK] = release("1.0.0");
      expect(problems(a.pkg, a.lock)).toMatch(/clerk-client must be a clerk-client GitHub release tarball URL in dependencies/);
      const b = fresh();
      b.pkg.devDependencies[CLERK] = must(b.pkg.dependencies[CLERK]);
      delete b.pkg.dependencies["@v-m-pioneer-trading/clerk-client"];
      expect(problems(b.pkg, b.lock)).toMatch(/clerk-client must be a clerk-client GitHub release tarball URL in dependencies/);
    });

    it("refuses the lockfile's resolved when it differs from package.json's URL (npm would then skip the integrity check)", () => {
      const { pkg, lock } = fresh();
      const e = entry(lock, ESLINT_PATH);
      e.resolved = release("9.9.9");
      e.integrity = "sha512-AAAA";
      expect(problems(pkg, lock)).toMatch(/eslint-config resolves from .*v9\.9\.9.*not from the URL package\.json declares/);
    });

    it("refuses a lockfile resolved from another repository's release, even when package.json says the same", () => {
      const { pkg, lock } = fresh();
      const evil = release("1.0.0", "evil-config");
      pkg.devDependencies[ESLINT] = evil;
      entry(lock, ESLINT_PATH).resolved = evil;
      const out = problems(pkg, lock);
      expect(out).toMatch(/eslint-config must be an eslint-config GitHub release tarball URL in devDependencies/);
      expect(out).toMatch(/eslint-config is version 1\.1\.0 but its release URL is 1\.0\.0/);
    });

    it("refuses the lockfile's version when it differs from the version in its release URL", () => {
      const { pkg, lock } = fresh();
      entry(lock, ESLINT_PATH).version = "1.0.9";
      expect(problems(pkg, lock)).toMatch(/eslint-config is version 1\.0\.9 but its release URL is 1\.1\.0/);
    });

    it("refuses the lockfile's root devDependencies naming it differently from package.json", () => {
      const { pkg, lock } = fresh();
      pkg.devDependencies[ESLINT] = release("1.0.9");
      expect(problems(pkg, lock)).toMatch(/eslint-config resolves from .*v1\.1\.0.*not from the URL package\.json declares/);
    });

    it("refuses any other entry resolved to the eslint-config release asset", () => {
      const { pkg, lock } = fresh();
      entry(lock, "node_modules/express").resolved = must(entry(lock, ESLINT_PATH).resolved);
      expect(problems(pkg, lock)).toMatch(/node_modules\/express resolves from .*not registry\.npmjs\.org/);
    });

    it("refuses a nested copy of it, which is not the one lock path it is admitted at", () => {
      const { pkg, lock } = fresh();
      lock.packages["node_modules/jest/" + ESLINT_PATH] = { ...entry(lock, ESLINT_PATH) };
      expect(problems(pkg, lock)).toMatch(/node_modules\/jest\/node_modules\/@v-m-pioneer-trading\/eslint-config resolves from .*not registry\.npmjs\.org/);
    });

    it("refuses an entry at its lock path that is not a release at all", () => {
      const { pkg, lock } = fresh();
      entry(lock, ESLINT_PATH).resolved = "https://registry.npmjs.org/@v-m-pioneer-trading/eslint-config/-/eslint-config-1.0.0.tgz";
      expect(problems(pkg, lock)).toMatch(/eslint-config resolves from .*registry.*not from the URL package\.json declares/);
    });
  });

  it("pins the five aliases by path, name and version", () => {
    const a = fresh();
    for (const where of Object.keys(KNOWN_ALIASES)) expect(a.lock.packages[where]).toBeDefined();
    entry(a.lock, "node_modules/strip-ansi-cjs").name = "left-pad";
    expect(problems(a.pkg, a.lock)).toMatch(/strip-ansi-cjs is installed as "left-pad"/);

    const b = fresh();
    b.lock.packages["node_modules/evil-alias"] = { ...entry(b.lock, "node_modules/strip-ansi-cjs") };
    expect(problems(b.pkg, b.lock)).toMatch(/node_modules\/evil-alias is installed as "strip-ansi" under another name/);

    const c = fresh();
    entry(c.lock, "node_modules/wrap-ansi-cjs").version = "9.9.9";
    expect(problems(c.pkg, c.lock)).toMatch(/wrap-ansi-cjs is installed as "wrap-ansi" under another name/);
  });

  it.each([undefined, "sha1-abc=", "sha256-abc=", "md5-abc"])("requires a sha512 integrity on every resolved entry: %s", (integrity) => {
    const { pkg, lock } = fresh();
    if (integrity === undefined) delete entry(lock, "node_modules/express").integrity;
    else entry(lock, "node_modules/express").integrity = integrity;
    expect(problems(pkg, lock)).toMatch(/node_modules\/express has no sha512 integrity/);
  });
});
