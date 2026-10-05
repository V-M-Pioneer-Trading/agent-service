// Direct-dependency allowlist (meta#103, decision 23 "Accepted costs").
//
// package.json's dependencies and devDependencies must be exactly the names in
// the matching section of allowed-dependencies.txt ([dependencies] and
// [devDependencies]); a name moved between sections fails. Every spec must be a
// plain semver range (no npm: alias, git, file or URL spec) except two release
// tarballs: clerk-client in dependencies and the shared eslint-config in
// devDependencies (RELEASES below). Every `resolved` in the lockfile must be the
// npm registry or, for those two entries alone, the URL package.json declares. A new direct dependency is therefore a
// visible diff in allowed-dependencies.txt, never a side effect of `npm install`.
//
// Also refused: `overrides` / `resolutions` (they rewrite what a name resolves to),
// a .npmrc, `workspaces` and lockfile `link` entries, bundled dependencies in any form, a lockfile entry installed under
// another name than its path (bar five pinned aliases npm writes for jest), a
// resolved URL of another package than the entry, and any entry without sha512 integrity.
// Transitive packages are covered by `npm audit` and `npm ci --ignore-scripts`.
//
// The lockfile's `dev` flag is checked against the dependency graph itself (issue #58): every entry reachable only from
// devDependencies must carry `dev: true`, and every entry reachable from dependencies must not. `npm ci --omit=dev`
// trusts the flag, so a lockfile-only edit that deletes it from a dev-only entry would ship that package in the image.
//
//   node scripts/check-dependencies.cjs
const fs = require("fs");
const path = require("path");

// The packages installed from a GitHub release tarball instead of the registry (clerk-client: meta#103; the shared
// eslint-config: meta#105). Each is admitted in one section only, at one lock path only, from its own repository's releases.
const CLERK = "@v-m-pioneer-trading/clerk-client";
const ESLINT_CONFIG = "@v-m-pioneer-trading/eslint-config";
const RELEASES = {
  [CLERK]: {
    section: "dependencies",
    lockPath: "node_modules/@v-m-pioneer-trading/clerk-client",
    url: /^https:\/\/github\.com\/V-M-Pioneer-Trading\/clerk-client\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/[A-Za-z0-9._-]+\.tgz$/,
    describe: "a clerk-client GitHub release tarball URL in dependencies",
    notARelease: "not a clerk-client release",
  },
  [ESLINT_CONFIG]: {
    section: "devDependencies",
    lockPath: "node_modules/@v-m-pioneer-trading/eslint-config",
    url: /^https:\/\/github\.com\/V-M-Pioneer-Trading\/eslint-config\/releases\/download\/v[0-9]+\.[0-9]+\.[0-9]+\/[A-Za-z0-9._-]+\.tgz$/,
    describe: "an eslint-config GitHub release tarball URL in devDependencies",
    notARelease: "not an eslint-config release",
  },
};
const RELEASE_BY_LOCK_PATH = new Map(Object.entries(RELEASES).map(([name, r]) => [r.lockPath, { name, ...r }]));
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

/** The lockfile path a dependency `name` of the package at `from` resolves to (node's lookup: nested first, then each parent), or undefined. */
function resolveDep(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (base === "") return undefined;
    const i = base.lastIndexOf("node_modules/");
    base = i <= 0 ? "" : base.slice(0, i - 1);
  }
}

/**
 * Lock paths reachable from the given root dependency names. Every edge npm installs is followed: dependencies,
 * optionalDependencies (installed unless --omit=optional, and then still part of the runtime graph) and peerDependencies
 * (npm 7+ installs them). An edge that resolves to nothing (an optional peer that is not installed) is skipped.
 */
function reachable(packages, rootNames) {
  const seen = new Set();
  const queue = [];
  const visit = (from, name) => {
    const to = resolveDep(packages, from, name);
    if (to !== undefined && !seen.has(to)) {
      seen.add(to);
      queue.push(to);
    }
  };
  for (const name of rootNames) visit("", name);
  while (queue.length > 0) {
    const where = queue.pop();
    const entry = packages[where];
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(entry[key] ?? {})) visit(where, name);
    }
  }
  return seen;
}

/** Problems with the lockfile's `dev` flags: dev-only entries must have `dev: true`, runtime-reachable ones must not. */
function devFlagProblems(pkg, lock) {
  const packages = lock.packages ?? {};
  const runtime = reachable(packages, [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  const dev = reachable(packages, Object.keys(pkg.devDependencies ?? {}));
  const problems = [];
  for (const [where, entry] of Object.entries(packages)) {
    if (where === "" || entry.link) continue;
    if (runtime.has(where)) {
      if (entry.dev === true) problems.push(`package-lock.json: ${where} is reachable from dependencies but is flagged "dev": true`);
    } else if (dev.has(where)) {
      if (entry.dev !== true) problems.push(`package-lock.json: ${where} is reachable only from devDependencies but has no "dev": true, so npm ci --omit=dev would install it into the production tree`);
    } else {
      problems.push(`package-lock.json: ${where} is not reachable from package.json's dependencies or devDependencies`);
    }
  }
  return problems;
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
  // A workspace is installed from a local directory, outside everything this check pins.
  if ("workspaces" in pkg) problems.push("package.json has workspaces; a workspace is installed from a local directory, not the registry");
  if (opts.npmrc) problems.push(".npmrc exists; it can redirect the registry or alias packages. Configure nothing there");
  const lockRoot = lock.packages?.[""] ?? {};
  for (const section of SECTIONS) {
    const declared = pkg[section] ?? {};
    for (const [name, spec] of Object.entries(declared)) {
      if (!allowed[section].has(name)) problems.push(`${name} is in ${section} but not in the [${section}] section of allowed-dependencies.txt`);
      const release = Object.hasOwn(RELEASES, name) ? RELEASES[name] : undefined;
      if (release !== undefined) {
        if (section !== release.section || !release.url.test(spec)) problems.push(`${name} must be ${release.describe}`);
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
    // A link entry points at a directory outside node_modules (a workspace or `file:` link): nothing is downloaded or verified.
    if (entry.link) {
      problems.push(`package-lock.json: ${label} is a link entry; links and workspaces are not allowed`);
      continue;
    }
    const resolved = entry.resolved;
    if (resolved === undefined) {
      problems.push(`package-lock.json: ${label} has no resolved URL`);
      continue;
    }
    const release = RELEASE_BY_LOCK_PATH.get(where);
    if (release !== undefined) {
      // The only entries that may leave the registry, each at its own lock path and only for the exact URL package.json declares
      // in the one section it is admitted in: npm downloads from package.json's URL and skips the integrity check when the
      // lock's resolved differs, so the pin would protect nothing.
      const declared = pkg[release.section]?.[release.name];
      if (resolved !== declared) problems.push(`package-lock.json: ${label} resolves from ${resolved}, not from the URL package.json declares (${declared})`);
      const urlVersion = /\/download\/v([0-9]+\.[0-9]+\.[0-9]+)\//.exec(resolved)?.[1];
      if (!release.url.test(resolved) || entry.version !== urlVersion) {
        problems.push(`package-lock.json: ${label} is version ${entry.version} but its release URL is ${urlVersion ?? release.notARelease}`);
      }
    } else {
      const installedAs = entry.name ?? pathName;
      // The exact tarball URL, not a prefix: `registry.npmjs.org/debug/-/../../left-pad/-/left-pad-1.3.0.tgz` starts with
      // debug's prefix yet installs left-pad as debug, and a prefix also lets another version than `version` install.
      const expected = `https://registry.npmjs.org/${installedAs}/-/${installedAs.slice(installedAs.lastIndexOf("/") + 1)}-${entry.version}.tgz`;
      if (/\.\.|[%?#\\]/.test(resolved)) {
        problems.push(`package-lock.json: ${label} resolves from ${resolved}, which contains "..", "%", "?", "#" or a backslash`);
      } else if (!resolved.startsWith("https://registry.npmjs.org/")) {
        problems.push(`package-lock.json: ${label} resolves from ${resolved}, which is not registry.npmjs.org (only the clerk-client and eslint-config entries may leave it)`);
      } else if (resolved !== expected) {
        problems.push(`package-lock.json: ${label} is "${installedAs}" but resolves from ${resolved}, not ${expected}`);
      }
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) problems.push(`package-lock.json: ${label} has no sha512 integrity`);
  }
  problems.push(...devFlagProblems(pkg, lock));
  return problems;
}

module.exports = { check, devFlagProblems, parseAllowlist, KNOWN_ALIASES };

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
