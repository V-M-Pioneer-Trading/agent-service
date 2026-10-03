const { judge } = require("../../scripts/run-contract") as {
  judge: (
    results: Array<{ path: string[]; outcome: "pass" | "fail" | "skip" }>,
    patterns: string[],
    vacuous: Set<string>,
    expected: Record<string, number>,
  ) => { problems: string[]; counts: Record<string, number> };
};

const r = (outcome: "pass" | "fail" | "skip", ...path: string[]) => ({ path, outcome });
const expected = { suite: 4, skipped: 2, pass: 2, "dynamic-skips": 0 };
const base = [r("pass", "health", "ok"), r("pass", "routing", "404"), r("fail", "ships", "GET a"), r("fail", "ships", "GET b")];
const patterns = ["^ships$"];

describe("the contract skip-list judge", () => {
  it("accepts: unlisted cases pass, listed cases fail, the numbers match", () => {
    expect(judge(base, patterns, new Set(), expected).problems).toEqual([]);
  });

  it("a failure outside the list is a defect", () => {
    const out = judge([...base.slice(0, 1), r("fail", "routing", "404"), ...base.slice(2)], patterns, new Set(), expected);
    expect(out.problems.join("\n")).toMatch(/FAILED and not on the skip list: routing 404/);
  });

  it("a listed case that passes is a stale or too broad pattern, unless it is named as vacuous", () => {
    const passing = [...base.slice(0, 3), r("pass", "ships", "GET b")];
    expect(judge(passing, patterns, new Set(), expected).problems.join("\n")).toMatch(/on the skip list but passing.*ships GET b/);
    expect(judge(passing, patterns, new Set(["ships GET b"]), expected).problems).toEqual([]);
  });

  it("a pattern that is too broad swallows a passing case and changes the counts", () => {
    const out = judge(base, ["^(ships|routing)$"], new Set(), expected);
    expect(out.problems.join("\n")).toMatch(/on the skip list but passing.*routing 404/);
    expect(out.problems.join("\n")).toMatch(/measured listed=3/);
  });

  it("a pattern that matches nothing, and a vacuous name that does not pass, are reported", () => {
    const out = judge(base, [...patterns, "^nothing$"], new Set(["ghost"]), expected);
    expect(out.problems.join("\n")).toMatch(/skip pattern matches no case: \^nothing\$/);
    expect(out.problems.join("\n")).toMatch(/names a case that does not pass on the list: ghost/);
  });

  it("matches a pattern against a suite name as node:test does, and a '/' in a pattern is fine", () => {
    const out = judge([r("fail", "POST /ships/{id}", "bad")], ["^POST /ships/\\{id\\}$"], new Set(), { suite: 1, skipped: 1, pass: 0, "dynamic-skips": 0 });
    expect(out.problems).toEqual([]);
  });

  it("the totals are checked against the committed numbers", () => {
    const out = judge([...base, r("pass", "extra", "one")], patterns, new Set(), expected);
    expect(out.problems.join("\n")).toMatch(/measured suite=5/);
  });
});
