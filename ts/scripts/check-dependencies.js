// Direct-dependency allowlist (meta#103, decision 23 "Accepted costs").
//
// package.json's dependencies and devDependencies must be exactly the names in
// allowed-dependencies.txt, and the lockfile must resolve each of them: a new
// direct dependency is a visible diff in this file, reviewed, never a side
// effect of `npm install`. Transitive packages are covered by `npm audit` and
// `npm ci --ignore-scripts` (agent-service has no transitive snapshot; that is
// auth-service's stricter mitigation).
//
//   node scripts/check-dependencies.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

const allowed = new Set(
  fs
    .readFileSync(path.join(root, "allowed-dependencies.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean),
);
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const lockRoot = lock.packages?.[""] ?? {};
const locked = new Set([...Object.keys(lockRoot.dependencies ?? {}), ...Object.keys(lockRoot.devDependencies ?? {})]);

const problems = [];
for (const name of declared) if (!allowed.has(name)) problems.push(`${name} is a direct dependency but is not in allowed-dependencies.txt`);
for (const name of allowed) if (!declared.has(name)) problems.push(`${name} is in allowed-dependencies.txt but is not a direct dependency (remove it)`);
for (const name of declared) if (!locked.has(name)) problems.push(`${name} is in package.json but not in package-lock.json's root: run npm install`);
for (const name of locked) if (!declared.has(name)) problems.push(`${name} is in package-lock.json's root but not in package.json`);
// The shared auth package must stay the release tarball, never a registry name or a git URL.
if (!/^https:\/\/github\.com\/V-M-Pioneer-Trading\/clerk-client\/releases\/download\/v[0-9.]+\/.*\.tgz$/.test(pkg.dependencies?.["@v-m-pioneer-trading/clerk-client"] ?? "")) {
  problems.push("@v-m-pioneer-trading/clerk-client must be a clerk-client GitHub release tarball URL");
}
// Express 4 only: clerk-client's adapter targets it.
if (!/^[~^]?4\./.test(pkg.dependencies?.express ?? "")) problems.push("express must stay on major version 4 (clerk-client's adapter targets Express 4)");

if (problems.length > 0) {
  for (const p of problems) console.error(`::error file=ts/allowed-dependencies.txt::${p}`);
  process.exit(1);
}
console.log(`${declared.size} direct dependencies, all on the allowlist.`);
