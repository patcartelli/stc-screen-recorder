import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `npm run merge` decides whether a PR landed, so its exit code is load-bearing
 * — anything chaining off it reads that number as the answer.
 *
 * It has now been wrong in BOTH directions. It once appeared to exit 0 after
 * giving up (that was an invocation piping it through `tail`, not the script).
 * Then it genuinely exited 1 after a SUCCESSFUL merge: `gh pr merge
 * --delete-branch` merges server-side and then deletes the local branch, which
 * needs to switch off it, which fails from a git worktree because master is
 * checked out in the main checkout. The merge stood; the script called it a
 * failure.
 *
 * These drive the real script with a stub `gh` on PATH, so each exit code is
 * observed rather than reasoned about.
 */
const root = join(__dirname, "..", "..");
const SCRIPT = join(root, "scripts", "merge-when-green.mjs");

/** A stub `gh` whose behaviour per subcommand is baked in by the test. */
function stubGh(opts: {
  mergeExit: number; mergeStderr?: string; stateAfterMerge: string; deleteExit?: number;
  /** Head SHA returned from the SECOND `pr view` on, simulating a push mid-wait. */
  headMovesTo?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "gh-stub-"));
  const flag = join(dir, "merged");
  const seen = join(dir, "views");
  const argvLog = join(dir, "merge-argv");
  const HEAD = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  // The head moves only after the first view, so the script gets one clean read
  // (as it would in life) and then finds the ground shifted under it.
  const headExpr = opts.headMovesTo
    ? `if [ -f ${seen} ]; then H=${opts.headMovesTo}; else touch ${seen}; H=${HEAD}; fi`
    : `H=${HEAD}`;
  writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$1 $2" in
  "pr view")
    ${headExpr}
    if [ -f ${flag} ]; then S=${opts.stateAfterMerge}; else S=OPEN; fi
    echo "{\\"headRefOid\\":\\"$H\\",\\"state\\":\\"$S\\",\\"mergeable\\":\\"MERGEABLE\\",\\"title\\":\\"t\\",\\"headRefName\\":\\"feature\\",\\"mergedAt\\":\\"2026-01-01T00:00:00Z\\"}" ;;
  "run list")
    echo '[{"databaseId":1,"headSha":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef","status":"completed","conclusion":"success"}]' ;;
  "pr merge")
    touch ${flag}
    echo "$@" > ${argvLog}
    echo "${opts.mergeStderr ?? ""}" >&2
    exit ${opts.mergeExit} ;;
  "api "*|"api")
    exit ${opts.deleteExit ?? 0} ;;
esac
exit 0
`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

/** What the script actually asked `gh pr merge` to do. */
const mergeArgv = (stubDir: string) =>
  existsSync(join(stubDir, "merge-argv"))
    ? readFileSync(join(stubDir, "merge-argv"), "utf8").trim() : "";

function run(stubDir: string) {
  // spawnSync, not execFileSync: execFileSync returns stdout ONLY, so a message
  // written to stderr looks absent and a test asserting on it fails for the
  // wrong reason. Both streams are the observable surface here.
  const r = spawnSync("node", [SCRIPT, "1"], {
    encoding: "utf8", env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("merge-when-green exit code", () => {
  test("a merge that lands but fails to delete the branch exits 0", () => {
    // The regression: `gh pr merge --delete-branch` exits non-zero because it
    // cannot switch off the merged branch from a worktree. The PR is merged.
    const dir = stubGh({
      mergeExit: 1,
      mergeStderr: "failed to run git: fatal: 'master' is already used by worktree at /repo",
      stateAfterMerge: "MERGED",
    });
    const r = run(dir);
    expect(r.code, `exited ${r.code} after a successful merge:\n${r.out}`).toBe(0);
    // Exiting 0 is not enough: the merge must be ANNOUNCED, or a silent 0 is
    // indistinguishable from the give-up path also exiting 0.
    expect(r.out).toMatch(/merged/);
  });

  test("a branch that cannot be deleted is reported, not swallowed", () => {
    // Cleanup may not change the exit code — but it may not vanish either, or
    // stale remote branches pile up with nothing ever saying so.
    const dir = stubGh({ mergeExit: 0, stateAfterMerge: "MERGED", deleteExit: 1 });
    const r = run(dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out, "a failed branch delete must still be reported").toMatch(/not deleted/);
  });

  test("a merge that does NOT land still exits 1", () => {
    // The bound in the other direction: verification must not rubber-stamp a
    // failure just because it stopped trusting gh's exit code.
    const dir = stubGh({ mergeExit: 1, mergeStderr: "merge conflict", stateAfterMerge: "OPEN" });
    const r = run(dir);
    expect(r.code, `exited ${r.code} when the PR never merged:\n${r.out}`).toBe(1);
  });

  test("a clean merge exits 0", () => {
    const r = run(stubGh({ mergeExit: 0, stateAfterMerge: "MERGED" }));
    expect(r.code, r.out).toBe(0);
  });

  /**
   * The hazard that reached production on 2026-08-30. headRefOid was read ONCE
   * before the poll loop, so a push during the wait left the poller matching
   * runs against a commit that was no longer the head — it found that commit's
   * green run and merged. GitHub's branch protection refused it that time, but
   * this script's whole reason to exist is repos with no required check, which
   * is exactly where nothing else would have caught it.
   */
  test("a head that moves mid-wait is refused, and NOTHING is merged", () => {
    const stub = stubGh({
      mergeExit: 0, stateAfterMerge: "MERGED",
      headMovesTo: "1111111111111111111111111111111111111111",
    });
    const r = run(stub);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/head moved while waiting/);
    expect(r.out).toMatch(/deadbeef -> 11111111/);
    // The load-bearing assertion: it must not have merged. A message about the
    // head moving, followed by a merge, would be worse than saying nothing.
    expect(mergeArgv(stub), "gh pr merge must never have been called").toBe("");
  });

  /**
   * The poll-loop check closes the window to one iteration; this closes the gap
   * between that check and the merge call itself, server-side. Asserted on the
   * real argv because "we pass the flag" is exactly the kind of claim that rots.
   */
  test("the merge is pinned to the SHA whose CI was seen green", () => {
    const stub = stubGh({ mergeExit: 0, stateAfterMerge: "MERGED" });
    const r = run(stub);
    expect(r.code, r.out).toBe(0);
    expect(mergeArgv(stub)).toMatch(
      /--match-head-commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/);
  });
});
