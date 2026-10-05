// Types for scripts/check-dependencies.cjs, which is plain CommonJS so that `node` runs it with no build.
export declare function check(pkg: unknown, lock: unknown, allowlistText: string, snapshotText: string, opts?: { npmrc?: boolean }): string[];
export declare function devFlagProblems(pkg: unknown, lock: unknown): string[];
export declare function parseAllowlist(text: string): { dependencies: Set<string>; devDependencies: Set<string> };
export declare function computeSnapshot(lock: unknown): Map<string, string>;
export declare function renderSnapshot(snapshot: Map<string, string>): string;
export declare function parseSnapshot(text: string): Map<string, string>;
export declare function snapshotProblems(lock: unknown, snapshotText: string): string[];
export declare function snapshotConflicts(lock: unknown): string[];
export declare const KNOWN_ALIASES: Record<string, { name: string; version: string }>;
