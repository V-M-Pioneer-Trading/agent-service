import fs from "node:fs";
import path from "node:path";

const { check } = require("../../scripts/check-dependencies") as {
  check: (pkg: any, lock: any, allow: string) => string[];
};

const root = path.join(__dirname, "..", "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const allow = read("allowed-dependencies.txt");
const fresh = () => ({ pkg: JSON.parse(read("package.json")), lock: JSON.parse(read("package-lock.json")) });

describe("the direct-dependency check", () => {
  it("passes on the repository as committed", () => {
    const { pkg, lock } = fresh();
    expect(check(pkg, lock, allow)).toEqual([]);
  });

  it("refuses an npm: alias spec for an allowed name", () => {
    const { pkg, lock } = fresh();
    pkg.devDependencies.supertest = "npm:evil-pkg@1.0.0";
    expect(check(pkg, lock, allow).join("\n")).toMatch(/supertest: "npm:evil-pkg@1.0.0" is not a plain semver range/);
  });

  it.each(["github:attacker/jest", "git+https://example.test/jest.git", "file:../jest", "https://example.test/jest.tgz", "latest", "*"])(
    "refuses the spec %s",
    (spec) => {
      const { pkg, lock } = fresh();
      pkg.devDependencies.jest = spec;
      expect(check(pkg, lock, allow).join("\n")).toMatch(/jest: ".*" is not a plain semver range/);
    },
  );

  it("refuses a dev dependency moved into dependencies (it would ship in the image)", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies.typescript = pkg.devDependencies.typescript;
    delete pkg.devDependencies.typescript;
    expect(check(pkg, lock, allow).join("\n")).toMatch(/typescript is in dependencies but not in the \[dependencies\] section/);
  });

  it("refuses a name that is not on the allowlist, and an allowlisted name that is gone", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies.leftpad = "^1.0.0";
    delete pkg.dependencies.express;
    const out = check(pkg, lock, allow).join("\n");
    expect(out).toMatch(/leftpad is in dependencies but not in the/);
    expect(out).toMatch(/express is on the \[dependencies\] allowlist but is not in dependencies/);
  });

  it("refuses a clerk-client from anywhere but its release tarball", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies["@v-m-pioneer-trading/clerk-client"] = "github:V-M-Pioneer-Trading/clerk-client";
    expect(check(pkg, lock, allow).join("\n")).toMatch(/must be a clerk-client GitHub release tarball/);
  });

  it("refuses a lockfile entry resolved from anywhere but the registry or the release", () => {
    const { pkg, lock } = fresh();
    lock.packages["node_modules/supertest"].resolved = "https://evil.example.test/supertest-6.3.4.tgz";
    expect(check(pkg, lock, allow).join("\n")).toMatch(/node_modules\/supertest resolves from https:\/\/evil\.example\.test/);
  });

  it("refuses express 5", () => {
    const { pkg, lock } = fresh();
    pkg.dependencies.express = "^5.0.0";
    expect(check(pkg, lock, allow).join("\n")).toMatch(/express must stay on major version 4/);
  });
});
