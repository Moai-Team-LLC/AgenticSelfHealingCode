/**
 * @sho/rca-git — REAL git-backed RCA tool. Implements loop-a's GitBlameLogTool over a live repo dir
 * with read-only git (execFileSync, no shell). Swap `new FakeGitBlameLog()` for `new GitBlameLog({ repo })`
 * in the injected RcaTools bundle to unblock G3 deploy-diff grounding.
 */

export { GitBlameLog, deployToShaRange } from './git-blame-log'
