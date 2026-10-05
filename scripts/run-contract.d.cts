// Types for scripts/run-contract.cjs, which is plain CommonJS so that `node` runs it with no build.
export type Event =
  | { kind: "test"; path: string[]; outcome: "pass" | "fail" | "skip" }
  | { kind: "suite"; path: string[]; failureType: string }
  | { kind: "diagnostic"; message: string };

export declare function judge(
  events: Event[],
  patterns: string[],
  vacuous: Set<string>,
  expected: Record<string, number>,
  status?: number,
): { problems: string[]; counts: Record<string, number> };
export declare function runSuite(contractDir: string, env?: NodeJS.ProcessEnv): { status: number; output: string; events: Event[] };
export declare function readLines(file: string): string[];
