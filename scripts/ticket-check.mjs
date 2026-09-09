#!/usr/bin/env node
/**
 * Before you start a ticket: has somebody already done it?
 *
 * ## Why this exists
 *
 * On 2026-09-09 two agents built STC-325 in parallel. One merged as #108 at
 * 14:49:58 UTC; the other's first commit was at 14:42:48 — so when the second
 * started, #108 was an OPEN PR sitting in plain sight. A whole session's work
 * was duplicated and thrown away, and the better of the two implementations
 * won by luck rather than by anyone comparing them.
 *
 * **Linear would not have caught it.** The ticket read `Backlog`,
 * `startedAt: null` — the first agent had not claimed it either. That is the
 * point worth keeping: a claim convention only works once everybody follows
 * it, so it cannot be the thing you rely on. This check protects you
 * unilaterally, which is why it is the half that runs.
 *
 * ## What it looks at
 *
 * Open PRs, merged commits and remote branches naming the ticket. Any hit and
 * it exits non-zero with what it found — it does not decide whether the work
 * is really duplicated, because "#108 is stage 1 and mine is stage 2" is a
 * judgement, and a script that guessed would be ignored the first time it was
 * wrong.
 *
 * ## Usage
 *
 *   npm run ticket -- STC-325
 *
 * Uses `gh` when it is on PATH and the public REST API when it is not, so it
 * works from a Mac with the CLI and from a remote session without it. The repo
 * is public (STC-302), so the unauthenticated path needs no token; it is rate
 * limited, which for a command run once per ticket is not a constraint.
 *
 * NB the npm script sets `NODE_USE_ENV_PROXY=1`. Node's `fetch` ignores
 * `HTTPS_PROXY` unless told not to, so in a sandboxed session it goes direct,
 * the gateway rejects the CONNECT, and GitHub appears to answer 403 — which
 * reads as "you cannot see this repository" and is nothing of the kind. It is
 * a no-op on a machine with no proxy set, which is every Mac this runs on.
 */
import { execFileSync } from "node:child_process";

const REPO = "patcartelli/stc-screen-recorder";
const API = `https://api.github.com/repos/${REPO}`;

/** `STC-325`, case-insensitively, and nothing that merely contains it. */
const TICKET = /^STC-\d+$/i;

const raw = process.argv[2];
if (!raw || !TICKET.test(raw)) {
  console.error("usage: npm run ticket -- STC-325");
  console.error("  refuses anything that is not exactly STC-<number>: a loose");
  console.error("  pattern would match STC-3 inside STC-325 and report the wrong ticket.");
  process.exit(2);
}
const ticket = raw.toUpperCase();

function haveGh() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

async function json(path) {
  // The User-Agent is REQUIRED, not decorative: GitHub answers an API request
  // without one with a bare 403, which reads exactly like "you are not allowed
  // to see this repository" and sent the first run of this script chasing
  // permissions.
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `${REPO} ticket-check`,
    },
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${path}`);
  return res.json();
}

const gh = (...args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));

/**
 * The ticket named as a WHOLE token.
 *
 * `STC-32` must not match `STC-325`, which a plain `includes` would do — and
 * would do silently, reporting a collision that is not one. A boundary either
 * side is the whole rule.
 */
function mentions(text) {
  return new RegExp(`(^|[^A-Za-z0-9-])${ticket}([^0-9]|$)`, "i").test(text ?? "");
}

async function openPRs() {
  const list = haveGh()
    ? gh("pr", "list", "--repo", REPO, "--state", "open", "--limit", "100",
         "--json", "number,title,headRefName,url")
    : (await json("/pulls?state=open&per_page=100")).map((p) => ({
        number: p.number, title: p.title, headRefName: p.head?.ref, url: p.html_url,
      }));
  return list.filter((p) => mentions(p.title) || mentions(p.headRefName));
}

async function mergedCommits() {
  // 100 is roughly a fortnight here and is a deliberate horizon rather than
  // "all of history": a ticket mentioned in a commit from months ago is
  // context, not a collision, and reporting it would train people to ignore
  // this output.
  const list = haveGh()
    ? gh("api", `repos/${REPO}/commits?per_page=100`)
    : await json("/commits?per_page=100");
  return list
    .filter((c) => mentions(c.commit?.message?.split("\n")[0]))
    .map((c) => ({ sha: c.sha.slice(0, 7), title: c.commit.message.split("\n")[0] }));
}

async function branches() {
  const list = haveGh()
    ? gh("api", `repos/${REPO}/branches?per_page=100`)
    : await json("/branches?per_page=100");
  return list.filter((b) => mentions(b.name)).map((b) => b.name);
}

/**
 * Exit codes are three, and the third is the one that matters.
 *
 * 0 nothing found, 1 a collision, **3 the check itself could not run**. The
 * first draft let an exception fall through Node's default exit of 1, which is
 * the same code as "found a collision" — so a script that could not reach
 * GitHub at all looked exactly like one that had found your work already done.
 * A broken check reading as a finding is the same family as a pass that means
 * nothing, and this repo has paid for that shape four times.
 */
const BROKE = 3;

let prs, commits, refs;
try {
  [prs, commits, refs] = await Promise.all([openPRs(), mergedCommits(), branches()]);
} catch (e) {
  console.error(`\nCOULD NOT CHECK: ${e?.message ?? e}`);
  console.error("This is NOT an all-clear. Look at the ticket on GitHub by hand before starting.");
  process.exit(BROKE);
}

let found = false;
if (prs.length) {
  found = true;
  console.log(`\nOPEN PULL REQUESTS naming ${ticket}:`);
  for (const p of prs) console.log(`  #${p.number}  ${p.title}\n           ${p.url}`);
}
if (commits.length) {
  found = true;
  console.log(`\nMERGED COMMITS naming ${ticket} (last 100 on the default branch):`);
  for (const c of commits) console.log(`  ${c.sha}  ${c.title}`);
}
if (refs.length) {
  found = true;
  console.log(`\nREMOTE BRANCHES naming ${ticket}:`);
  for (const b of refs) console.log(`  ${b}`);
}

if (!found) {
  console.log(`\nNothing on GitHub names ${ticket}. Claim it in Linear before you start:`);
  console.log("  set the status to In Progress, and comment with the branch you will use.");
  process.exit(0);
}

console.log(`\n${ticket} already has work against it. Read it BEFORE writing any:`);
console.log("  it may be a different stage, a stale branch, or the whole ticket already done.");
console.log("  This script does not decide which — that is a judgement, and a script that");
console.log("  guessed would be ignored the first time it guessed wrong.");
process.exit(1);
