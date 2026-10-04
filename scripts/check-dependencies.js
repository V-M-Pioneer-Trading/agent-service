// Direct-dependency allowlist (meta#103, decision 23 "Accepted costs").
//
// package.json's dependencies and devDependencies must be exactly the names in
// the matching section of allowed-dependencies.txt ([dependencies] and
// [devDependencies]); a name moved between sections fails. Every spec must be a
// plain semver range (no npm: alias, git, file or URL spec) except the one
// clerk-client release tarball. Every `resolved` in the lockfile must be the
// npm registry or that release URL. A new direct dependency is therefore a
// visible diff in allowed-dependencies.txt, never a side effect of `npm install`.
//
// Also refused: `overrides` / `resolutions` (they rewrite what a name resolves to),
// a .npmrc, bundled dependencies in any form, a lockfile entry installed under
// another name than its path (bar five pinned aliases npm writes for jest), a
// resolved URL of another package than the entry, and any entry without sha512 integrity.
// Transitive packages are covered by `npm audit` and `npm ci --ignore-scripts`.
//
//   node scripts/check-dependencies.js
const fs = require("fs");
const path = require("path");

const CLERK = "@v-m-pioneer-trading/clerk-client";
const CLERK_URL = /^https:\/\/github\.com\/V-M-Pioneer-Trading\/clerk-client\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/[A-Za-z0-9._-]+\.tgz$/;
const SEMVER_RANGE = /^[~^]?[0-9]+\.[0-9]+\.[0-9]+$/;
// The aliases npm itself writes for jest's tree (react-is, string-width and friends under another name).
// Pinned by lock path, name and version: a new alias, or a changed one, is a reviewed diff here.
const KNOWN_ALIASES = {
  "node_modules/@jest/react-is-18": { name: "react-is", version: "18.3.1" },
  "node_modules/@jest/react-is-19": { name: "react-is", version: "19.3.0" },
  "node_modules/string-width-cjs": { name: "string-width", version: "4.2.3" },
  "node_modules/strip-ansi-cjs": { name: "strip-ansi", version: "6.0.1" },
  "node_modules/wrap-ansi-cjs": { name: "wrap-ansi", version: "7.0.0" },
};
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

function check(pkg, lock, allowlistText, opts = {}) {
  const allowed = parseAllowlist(allowlistText);
  const problems = [];
  for (const extra of ["optionalDependencies", "peerDependencies"]) {
    const v = pkg[extra];
    if (v !== undefined && Object.keys(v).length > 0) problems.push(`package.json has ${extra}; only dependencies and devDependencies are allowed`);
  }
  // Any truthy form, `true` included: bundled packages are installed from the tarball itself.
  for (const key of ["bundledDependencies", "bundleDependencies"]) {
    if (pkg[key]) problems.push(`package.json has ${key}; bundled dependencies are not allowed`);
  }
  // These rewrite what a name resolves to (overrides: {"body-parser": "npm:left-pad@1"}).
  for (const key of ["overrides", "resolutions"]) {
    if (key in pkg) problems.push(`package.json has ${key}; a name must resolve to itself`);
  }
  if (opts.npmrc) problems.push(".npmrc exists; it can redirect the registry or alias packages. Configure nothing there");
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
    if (where === "") continue;
    const label = where;
    const pathName = where.slice(where.lastIndexOf("node_modules/") + "node_modules/".length);
    const alias = KNOWN_ALIASES[where];
    if (entry.name !== undefined && entry.name !== pathName) {
      if (alias === undefined || alias.name !== entry.name || alias.version !== entry.version) {
        problems.push(`package-lock.json: ${label} is installed as "${entry.name}" under another name; only the pinned aliases are allowed`);
      }
    } else if (alias !== undefined && entry.version !== alias.version) {
      problems.push(`package-lock.json: ${label} is not the pinned alias ${alias.name}@${alias.version}`);
    }
    const resolved = entry.resolved;
    if (resolved === undefined) {
      if (!entry.link) problems.push(`package-lock.json: ${label} has no resolved URL`);
      continue;
    }
    const clerk = CLERK_URL.test(resolved);
    if (!resolved.startsWith("https://registry.npmjs.org/") && !clerk) {
      problems.push(`package-lock.json: ${label} resolves from ${resolved}, which is neither registry.npmjs.org nor the clerk-client release`);
    }
    if (!clerk) {
      const installedAs = entry.name ?? pathName;
      if (!resolved.startsWith(`https://registry.npmjs.org/${installedAs}/-/`)) {
        problems.push(`package-lock.json: ${label} is "${installedAs}" but resolves from ${resolved}`);
      }
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) problems.push(`package-lock.json: ${label} has no sha512 integrity`);
  }
  return problems;
}

module.exports = { check, parseAllowlist, KNOWN_ALIASES };

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const problems = check(pkg, JSON.parse(read("package-lock.json")), read("allowed-dependencies.txt"), { npmrc: fs.existsSync(path.join(root, ".npmrc")) });
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error file=allowed-dependencies.txt::${p}`);
    process.exit(1);
  }
  console.log(`${Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length} direct dependencies, all on the allowlist.`);
}
