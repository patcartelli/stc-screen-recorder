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

const pr = process.argv[2];
const method = (process.argv.find((a) => /^--(squash|merge|rebase)$/.test(a)) ?? "--squash");
if (!pr) {
  console.error("usage: node scripts/merge-when-green.mjs <pr-number> [--squash|--merge|--rebase]");
  process.exit(2);
}
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

const { headRefOid, state, mergeable, title } = JSON.parse(
  gh("pr", "view", pr, "--json", "headRefOid,state,mergeable,title"));

if (state !== "OPEN") { console.error(`PR #${pr} is ${state}, not OPEN`); process.exit(1); }
console.log(`PR #${pr}: ${title}`);
console.log(`head ${headRefOid.slice(0, 8)}, mergeable: ${mergeable}`);

const DEADLINE = Date.now() + 30 * 60_000;
let last = "";
for (;;) {
  if (Date.now() > DEADLINE) { console.error("\ngave up waiting for CI after 30 minutes"); process.exit(1); }

  // Match the run to the PR's HEAD SHA. Taking "the latest run" would happily
  // read a green result belonging to a different commit.
  const runs = JSON.parse(gh("run", "list", "--limit", "20", "--json",
    "databaseId,headSha,status,conclusion"));
  const run = runs.find((r) => r.headSha === headRefOid);

  if (!run) {
    if (last !== "none") { console.log("waiting for a CI run on this commit…"); last = "none"; }
  } else if (run.status !== "completed") {
    if (last !== run.status) { console.log(`CI ${run.status}…`); last = run.status; }
  } else if (run.conclusion === "success") {
    console.log(`CI passed (run ${run.databaseId}) — merging`);
    console.log(gh("pr", "merge", pr, method, "--delete-branch"));
    process.exit(0);
  } else {
    console.error(`\nCI ${run.conclusion} (run ${run.databaseId}) — NOT merging`);
    console.error(`  gh run view ${run.databaseId} --log-failed`);
    process.exit(1);
  }
  execFileSync("sleep", ["15"]);
}
