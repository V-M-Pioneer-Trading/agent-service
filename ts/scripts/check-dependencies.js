// Direct-dependency allowlist (meta#103, decision 23 "Accepted costs").
//
// package.json's dependencies and devDependencies must be exactly the names in
// the matching section of allowed-dependencies.txt ([dependencies] and
// [devDependencies]); a name moved between sections fails. Every spec must be a
// plain semver range (no npm: alias, git, file or URL spec) except the one
// clerk-client release tarball. Every `resolved` in the lockfile must be the
// npm registry or that release URL. A new direct dependency is therefore a
// visible diff in allowed-dependencies.txt, never a side effect of `npm install`.
// Transitive packages are covered by `npm audit` and `npm ci --ignore-scripts`.
//
//   node scripts/check-dependencies.js
const fs = require("fs");
const path = require("path");

const CLERK = "@v-m-pioneer-trading/clerk-client";
const CLERK_URL = /^https:\/\/github\.com\/V-M-Pioneer-Trading\/clerk-client\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/[A-Za-z0-9._-]+\.tgz$/;
const SEMVER_RANGE = /^[~^]?[0-9]+\.[0-9]+\.[0-9]+$/;
const SECTIONS = ["dependencies", "devDependencies"];

function parseAllowlist(text) {
  const out = { dependencies: new Set(), devDependencies: new Set() };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (line === "") continue;
    const m = /^\[(\w+)\]$/.exec(line);
    if (m) {
      if (!SECTIONS.includes(m[1])) throw new Error(`allowed-dependencies.txt: unknown section [${m[1]}]`);
      section = m[1];
    } else if (section === null) {
      throw new Error(`allowed-dependencies.txt: "${line}" is outside a [dependencies] / [devDependencies] section`);
    } else {
      out[section].add(line);
    }
  }
  return out;
}

function check(pkg, lock, allowlistText) {
  const allowed = parseAllowlist(allowlistText);
  const problems = [];
  for (const extra of ["optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    const v = pkg[extra];
    if (v !== undefined && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
      problems.push(`package.json has ${extra}; only dependencies and devDependencies are allowed`);
    }
  }
  const lockRoot = lock.packages?.[""] ?? {};
  for (const section of SECTIONS) {
    const declared = pkg[section] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (!allowed[section].has(name)) problems.push(`${name} is in ${section} but not in the [${section}] section of allowed-dependencies.txt`);
      if (name === CLERK) {
        if (section !== "dependencies" || !CLERK_URL.test(spec)) problems.push(`${CLERK} must be a clerk-client GitHub release tarball URL in dependencies`);
      } else if (!SEMVER_RANGE.test(spec)) {
        problems.push(`${name}: "${spec}" is not a plain semver range (no npm: alias, git, file or URL spec)`);
      }
      if (name === "express" && !/^[~^]?4\./.test(spec)) problems.push("express must stay on major version 4 (clerk-client's adapter targets Express 4)");
      if (!(name in (lockRoot[section] ?? {}))) problems.push(`${name} is in ${section} but not in package-lock.json's root ${section}: run npm install`);
    }
    for (const name of allowed[section]) if (!(name in declared)) problems.push(`${name} is on the [${section}] allowlist but is not in ${section} (remove it)`);
    for (const name of Object.keys(lockRoot[section] ?? {})) if (!(name in declared)) problems.push(`${name} is in package-lock.json's root ${section} but not in package.json`);
  }
  for (const [where, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = entry.resolved;
    if (resolved === undefined) continue;
    if (!resolved.startsWith("https://registry.npmjs.org/") && !CLERK_URL.test(resolved)) {
      problems.push(`package-lock.json: ${where || "(root)"} resolves from ${resolved}, which is neither registry.npmjs.org nor the clerk-client release`);
    }
  }
  return problems;
}

module.exports = { check, parseAllowlist };

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const problems = check(pkg, JSON.parse(read("package-lock.json")), read("allowed-dependencies.txt"));
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error file=ts/allowed-dependencies.txt::${p}`);
    process.exit(1);
  }
  console.log(`${Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length} direct dependencies, all on the allowlist.`);
}
