// Runs the contract suite (../contract) against the TypeScript service, whole and
// unfiltered, and judges the result against contract-skip.txt.
//
//   node ts/scripts/run-contract.js     (from the repository root, after `npm run build` in ts/)
//
// The suite is not modified and no case is removed from the run. Every leaf test's
// full name (describe names and test name, joined by single spaces, which is what
// `node --test --test-skip-pattern` matches) is compared with the skip patterns:
//
//   * a case NOT on the list must pass: any failure is a defect;
//   * a case on the list may fail (its route is not ported), but must not pass,
//     except the ones named in contract-skip-passing.txt, which pass vacuously;
//     so a pattern that is too broad, or stale after a route was ported, fails;
//   * the measured numbers must equal contract-skip.expected: the suite's size,
//     how many cases the list covers, how many pass, how many the suite itself
//     skips. The list can only change together with that file.
//
// Environment: CONTRACT_MYSQL_* as the suite's README says. CONTRACT_COMMAND is
// set here (a local process) when neither it nor CONTRACT_IMAGE is.
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ts = path.join(__dirname, "..");
const contract = path.join(ts, "..", "contract");

const readLines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

/** Pure: the verdict on a run. `results` is [{path: [names], outcome}], `expected` the parsed .expected file. */
function judge(results, patterns, vacuous, expected) {
  const regexes = patterns.map((p) => new RegExp(p));
  const problems = [];
  const counts = { suite: results.length, listed: 0, pass: 0, dynamicSkips: 0 };
  const vacuousSeen = new Set();
  const used = new Set();
  for (const r of results) {
    const name = r.path.join(" ");
    // node:test skips a test whose own name matches, or any ancestor suite's.
    const prefixes = r.path.map((_, i) => r.path.slice(0, i + 1).join(" "));
    const listed = regexes.some((re, i) => {
      const hit = prefixes.some((p) => re.test(p));
      if (hit) used.add(i);
      return hit;
    });
    if (r.outcome === "skip") {
      counts.dynamicSkips++;
      continue;
    }
    if (listed) {
      counts.listed++;
      if (r.outcome === "pass") {
        if (vacuous.has(name)) vacuousSeen.add(name);
        else problems.push(`on the skip list but passing (a stale or too broad pattern?): ${name}`);
      }
    } else if (r.outcome === "pass") {
      counts.pass++;
    } else {
      problems.push(`FAILED and not on the skip list: ${name}`);
    }
  }
  patterns.forEach((p, i) => { if (!used.has(i)) problems.push(`skip pattern matches no case: ${p}`); });
  for (const v of vacuous) if (!vacuousSeen.has(v)) problems.push(`contract-skip-passing.txt names a case that does not pass on the list: ${v}`);
  const want = { suite: expected.suite, listed: expected.skipped, pass: expected.pass, dynamicSkips: expected["dynamic-skips"] };
  for (const key of Object.keys(want)) {
    if (counts[key] !== want[key]) problems.push(`measured ${key}=${counts[key]}, contract-skip.expected says ${want[key]}`);
  }
  return { problems, counts };
}

module.exports = { judge };

if (require.main === module) {
  const patterns = readLines(path.join(ts, "contract-skip.txt"));
  const vacuous = new Set(readLines(path.join(ts, "contract-skip-passing.txt")));
  const expected = Object.fromEntries(readLines(path.join(ts, "contract-skip.expected")).map((l) => l.split("=").map((s) => s.trim())));
  for (const key of ["suite", "skipped", "pass", "dynamic-skips"]) {
    if (!/^[0-9]+$/.test(expected[key] ?? "")) throw new Error(`contract-skip.expected: ${key}=<number> is missing`);
    expected[key] = Number(expected[key]);
  }
  for (const p of patterns) new RegExp(p); // a pattern that does not compile fails here

  const resultsFile = path.join(os.tmpdir(), `contract-results-${process.pid}.jsonl`);
  const args = [
    "--test",
    "--test-timeout=60000",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${require("url").pathToFileURL(path.join(__dirname, "contract-reporter.js")).href}`,
    `--test-reporter-destination=${resultsFile}`,
    "contract.test.ts",
  ];
  const env = { ...process.env };
  if (!env.CONTRACT_IMAGE && !env.CONTRACT_COMMAND) env.CONTRACT_COMMAND = `node ${JSON.stringify(path.join(ts, "dist", "server.js"))}`;

  const run = spawnSync(process.execPath, args, { cwd: contract, env, encoding: "utf8", maxBuffer: 512 << 20 });
  // The whole spec output is long and mostly the listed failures; keep the tail.
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  process.stdout.write(out.split("\n").slice(-60).join("\n") + "\n");

  const results = fs.existsSync(resultsFile)
    ? fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const { problems, counts } = judge(results, patterns, vacuous, expected);
  console.log(`\ncontract against the TypeScript service: ${counts.pass} pass outside the list, ${counts.listed} of ${counts.suite} cases on the skip list (${patterns.length} patterns), ${counts.dynamicSkips} skipped by the suite`);
  if (results.length === 0) problems.push("no test results were recorded (did the suite start?)");
  if (problems.length > 0) {
    for (const p of problems.slice(0, 40)) console.error(`::error::${p}`);
    if (problems.length > 40) console.error(`::error::... and ${problems.length - 40} more`);
    process.exit(1);
  }
}
