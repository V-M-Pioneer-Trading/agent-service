import { base } from "@v-m-pioneer-trading/eslint-config";

// tsoa writes routes.ts and swagger.json to src/generated/, which the shared config already ignores.
//
// contract/ is not linted. It is the black-box parity record of the Go to TypeScript port: CLAUDE.md says it runs
// unchanged and is never edited, and it is a project of its own (own package.json and lockfile, installed only by
// the `contract` CI job). Linting it would mean rewriting the oracle the service is judged against.
// .claude/worktrees/ holds heinzelwerk task worktrees, each a full checkout of this repo (V-M-Pioneer-Trading/meta#120).
export default base({ tsconfigRootDir: import.meta.dirname, ignores: [".claude/worktrees/", "contract/"] });
