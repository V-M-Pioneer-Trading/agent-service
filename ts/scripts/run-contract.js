// Runs the contract suite (../contract) against the TypeScript service as a
// local process, minus the cases listed in contract-skip.txt, and checks the
// run is exactly the one contract-skip.expected promises.
//
//   node ts/scripts/run-contract.js            (from the repository root, after `npm run build` in ts/)
//
// The suite is not modified. The skip list is `node --test --test-skip-pattern`
// (a filtered-out test is not run and not reported, so the counts below are what
// a too-broad or stale pattern would change).
//
// Environment: CONTRACT_MYSQL_* as the suite's README says. CONTRACT_COMMAND and
// CONTRACT_IMAGE are set here when the caller has not chosen.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ts = path.join(__dirname, "..");
const contract = path.join(ts, "..", "contract");

const readLines = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

const patterns = readLines(path.join(ts, "contract-skip.txt"));
const expected = Object.fromEntries(readLines(path.join(ts, "contract-skip.expected")).map((l) => l.split("=").map((s) => s.trim())));
for (const key of ["suite", "skipped", "tests", "pass", "dynamic-skips"]) {
  if (!/^\d+$/.test(expected[key] ?? "")) throw new Error(`contract-skip.expected: ${key}=<number> is missing`);
}

const args = ["--test", "--test-timeout=60000", "--test-reporter=spec"];
for (const p of patterns) {
  new RegExp(p); // a pattern that does not compile must fail here, not silently skip nothing
  args.push(`--test-skip-pattern=${p}`);
}
args.push("contract.test.ts");

const env = { ...process.env };
if (!env.CONTRACT_IMAGE && !env.CONTRACT_COMMAND) env.CONTRACT_COMMAND = `node ${JSON.stringify(path.join(ts, "dist", "server.js"))}`;

const run = spawnSync(process.execPath, args, { cwd: contract, env, encoding: "utf8", maxBuffer: 256 << 20 });
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");

const output = `${run.stdout ?? ""}
${run.stderr ?? ""}`;
const count = (name) => {
  const m = new RegExp(`^ℹ ${name} ([0-9]+)`, "m").exec(output);
  return m === null ? NaN : Number(m[1]);
};
const got = { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
const suite = Number(expected.suite);
const filtered = suite - got.tests;

const problems = [];
if (run.status !== 0) problems.push(`the suite exited with status ${run.status}`);
if (got.fail !== 0) problems.push(`${got.fail} contract case(s) failed`);
if (got.tests !== Number(expected.tests)) problems.push(`ran ${got.tests} tests, contract-skip.expected says ${expected.tests}`);
if (filtered !== Number(expected.skipped)) problems.push(`the skip list removed ${filtered} of ${suite} tests, contract-skip.expected says ${expected.skipped}`);
if (got.pass !== Number(expected.pass)) problems.push(`${got.pass} passed, contract-skip.expected says ${expected.pass}`);
if (got.skipped !== Number(expected["dynamic-skips"])) problems.push(`${got.skipped} skipped by the suite itself, contract-skip.expected says ${expected["dynamic-skips"]}`);

console.log(`\ncontract against the TypeScript service: ${got.pass} passed, ${got.fail} failed, ${filtered} of ${suite} cases on the skip list (${patterns.length} patterns)`);
if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
