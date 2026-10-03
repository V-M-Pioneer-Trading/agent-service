// A node:test reporter that writes one JSON line per finished test (not suite):
//   {"path": [describe names..., test name], "outcome": "pass" | "fail" | "skip"}
// --test-skip-pattern matches the space-joined path of a test or of any of its
// ancestors, so run-contract.js can say which cases a skip pattern would have removed
// without removing them from the run.
module.exports = async function* (source) {
  const stack = [];
  for await (const event of source) {
    const d = event.data;
    if (event.type === "test:start") {
      stack.length = d.nesting;
      stack[d.nesting] = d.name;
    } else if (event.type === "test:pass" || event.type === "test:fail") {
      if (d.details?.type === "suite") continue;
      const outcome = event.type === "test:fail" ? "fail" : d.skip !== undefined || d.todo !== undefined ? "skip" : "pass";
      yield JSON.stringify({ path: [...stack.slice(0, d.nesting), d.name], outcome }) + "\n";
    }
  }
};
