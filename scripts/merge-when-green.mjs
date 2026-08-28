#!/usr/bin/env node
/**
 * Merge a PR only after CI has actually passed on its head commit.
 *
 * `gh pr merge --auto` does NOT do this here. Auto-merge waits for *required*
 * status checks, and requiring a check needs branch protection — which needs
 * GitHub Pro or a public repo. On a free private repo there are no required
 * checks, so --auto merges immediately and silently. That is how PR #2 landed
 * while its CI run was still in progress.
 *
 * This polls the run for the PR's head SHA and refuses to merge anything that
 * is not green.
 *
 * Usage: node scripts/merge-when-green.mjs <pr-number> [--squash|--merge|--rebase]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * How long to wait for CI, DERIVED from CI's own job timeout rather than
 * written down twice.
 *
 * These two bounds cover the same wait, and when they were both 30 minutes they
 * fired together: run 33108160534's determinism gate hung, GitHub killed the
 * job at its 30 min limit, and this poller gave up at the same moment — so it
 * never saw the conclusion and reported "gave up waiting for CI" when the real
 * answer was "CI was killed for hanging in the determinism gate". Two bounds,
 * one useful message, and it lost the race. That is CLAUDE.md's rule about
 * checking a new bound against every bound already covering the same code, and
 * the fix it prescribes: the clearance is CHECKED, not kept in step by hand.
 *
 * The poller must OUTLIVE the job so it lives to REPORT what happened to it.
 * Slack covers queueing (the job's clock starts when it is picked up, not when
 * the run is created) plus the moment GitHub takes to record the conclusion.
 */
const SLACK_MIN = Number(process.env.STC_MERGE_SLACK_MIN ?? 15);

function ciJobTimeoutMin() {
  const yml = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  // Every timeout-minutes in the file, not just the first: the bound we must
  // clear is the longest thing that can hold the run open.
  const found = [...yml.matchAll(/^\s*timeout-minutes:\s*(\d+)/gm)].map((m) => Number(m[1]));
  if (!found.length) {
    // Loudly, never a hand-written fallback — a default here would silently
    // restore the drift this function exists to prevent.
    console.error("could not read timeout-minutes from .github/workflows/ci.yml");
    console.error("  the poller's bound is derived from it and must not be guessed");
    process.exit(2);
  }
  return Math.max(...found);
}

const pr = process.argv[2];
const method = (process.argv.find((a) => /^--(squash|merge|rebase)$/.test(a)) ?? "--squash");
if (!pr) {
  console.error("usage: node scripts/merge-when-green.mjs <pr-number> [--squash|--merge|--rebase]");
  process.exit(2);
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

const { headRefOid, state, mergeable, title, headRefName } = JSON.parse(
  gh("pr", "view", pr, "--json", "headRefOid,state,mergeable,title,headRefName"));

if (state !== "OPEN") { console.error(`PR #${pr} is ${state}, not OPEN`); process.exit(1); }
console.log(`PR #${pr}: ${title}`);
console.log(`head ${headRefOid.slice(0, 8)}, mergeable: ${mergeable}`);

const CI_MIN = ciJobTimeoutMin();
const WAIT_MIN = CI_MIN + SLACK_MIN;
// Print both bounds and the clearance between them. A bound nobody can see is
// one nobody notices drifting.
console.log(`CI job limit ${CI_MIN} min; giving up at ${WAIT_MIN} min (${SLACK_MIN} min clearance)`);

const DEADLINE = Date.now() + WAIT_MIN * 60_000;
let last = "";
let lastRun = null;
for (;;) {
  if (Date.now() > DEADLINE) {
    console.error(`\ngave up waiting for CI after ${WAIT_MIN} minutes`);
    // Say WHICH bound fired and why. "Gave up waiting" alone is the message
    // that hid a hung determinism gate once already.
    if (!lastRun) {
      console.error(`  no CI run ever appeared for ${headRefOid.slice(0, 8)}`);
    } else {
      console.error(`  run ${lastRun.databaseId} was still ${lastRun.status} — past CI's own`);
      console.error(`  ${CI_MIN} min job limit, so GitHub should already have killed it:`);
      console.error(`  gh run view ${lastRun.databaseId}`);
    }
    process.exit(1);
  }

  // Match the run to the PR's HEAD SHA. Taking "the latest run" would happily
  // read a green result belonging to a different commit.
  //
  // Filtered SERVER-side by commit, not by scanning the 20 most recent runs
  // repo-wide: with several branches active at once that window covered eight
  // of them, so a PR's run could fall out of it and the poller would report
  // "no CI run ever appeared" and give up while a green run sat there. Giving
  // up by failing to look far enough is the same shape as succeeding by finding
  // nothing to do. The client-side headSha check stays as a belt-and-braces
  // guard on the server's filter.
  const runs = JSON.parse(gh("run", "list", "--commit", headRefOid, "--limit", "20",
    "--json", "databaseId,headSha,status,conclusion"));
  const run = runs.find((r) => r.headSha === headRefOid);
  if (run) lastRun = run;

  if (!run) {
    if (last !== "none") { console.log("waiting for a CI run on this commit…"); last = "none"; }
  } else if (run.status !== "completed") {
    if (last !== run.status) { console.log(`CI ${run.status}…`); last = run.status; }
  } else if (run.conclusion === "success") {
    console.log(`CI passed (run ${run.databaseId}) — merging`);
    merge();
  } else {
    console.error(`\nCI ${run.conclusion} (run ${run.databaseId}) — NOT merging`);
    console.error(`  gh run view ${run.databaseId} --log-failed`);
    process.exit(1);
  }
  execFileSync("sleep", ["15"]);
}

/**
 * Merge, then ASK GITHUB whether it merged. gh's exit code is not the
 * authority, and this script's exit code has been wrong in both directions
 * because of that.
 *
 * `--delete-branch` is deliberately NOT passed. It merges server-side and then
 * deletes the LOCAL branch, which means switching off it — and that fails from
 * a git worktree, because master is checked out in the main checkout:
 *
 *   failed to run git: fatal: 'master' is already used by worktree at /repo
 *
 * The merge stood and the script exited 1 anyway (PR #34). Cleanup deletes the
 * remote ref over the API instead, which touches no local branch, and its
 * failure is reported without changing the exit code: a tidy-up that did not
 * happen is not a merge that did not happen.
 */
function merge() {
  let mergeError = null;
  try {
    const out = gh("pr", "merge", pr, method);
    if (out) console.log(out);
  } catch (e) {
    mergeError = e;
  }

  const after = JSON.parse(gh("pr", "view", pr, "--json", "state,mergedAt"));
  if (after.state !== "MERGED") {
    console.error(`\nmerge did not land — PR #${pr} is ${after.state}`);
    if (mergeError) console.error(`  ${String(mergeError.stderr ?? mergeError.message).trim()}`);
    process.exit(1);
  }
  console.log(`merged${after.mergedAt ? ` at ${after.mergedAt}` : ""}`);
  if (mergeError) {
    console.error(`  (gh exited non-zero but the PR is merged: ` +
                  `${String(mergeError.stderr ?? mergeError.message).trim().split("\n")[0]})`);
  }

  // Best-effort, and it may not change the exit code.
  try {
    gh("api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${headRefName}`);
    console.log(`deleted remote branch ${headRefName}`);
  } catch (e) {
    console.error(`  (remote branch ${headRefName} not deleted: ` +
                  `${String(e.stderr ?? e.message).trim().split("\n")[0]}) — the merge stands`);
  }
  process.exit(0);
}
