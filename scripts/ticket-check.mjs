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
 * Running the file directly (`node scripts/ticket-check.mjs STC-325`) skips
 * that, so the script checks for the combination itself rather than leaving
 * the explanation in a comment nobody reads at 403 time.
 *
 * ## The one rule every change here must keep
 *
 * **Every failure mode must land on exit 3, never exit 0.** The only reason to
 * run this is to believe the all-clear, so "I could not tell" and "there is
 * nothing" must never be the same answer. That is why the page walk THROWS
 * when it hits its ceiling instead of returning what it has: a truncated
 * listing is indistinguishable from a clean one, and it truncates the
 * alphabetically-last `claude/*` branches first — exactly where parallel
 * agent work lives.
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

/**
 * `gh` present AND logged in — the second half is not pedantry.
 *
 * Testing only that the binary exists (`gh --version`) means an installed but
 * unauthenticated `gh` sends every query down a path that throws, so the check
 * exits 3 forever while the REST fallback sitting in this same file — which
 * needs no token, the repo being public — is never tried. That is this
 * script's own headline bug one layer out: it was written because a check
 * that could not run looked like a check that had found something.
 *
 * `gh auth status` covers both cases at once: a missing binary throws ENOENT,
 * a logged-out one exits non-zero. Memoised because it is asked three times
 * and each ask is a process.
 */
let ghState;
function haveGh() {
  if (ghState === undefined) {
    try {
      execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
      ghState = true;
    } catch { ghState = false; }
  }
  return ghState;
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
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${path}${res.status === 403 ? FORBIDDEN_HINT : ""}`);
  return res.json();
}

/**
 * A 403 here has two known causes and NEITHER is "you cannot see this repo",
 * which is what it reads as. Both have cost a session already, so the message
 * names them rather than leaving it to the comment above.
 */
const FORBIDDEN_HINT =
  "\n  A 403 here is usually not a permission problem. Two known causes:\n" +
  "    - a proxied session with NODE_USE_ENV_PROXY unset (use `npm run ticket --`,\n" +
  "      which sets it; running this file directly does not)\n" +
  "    - a missing User-Agent header (this script sends one)";

// maxBuffer defaults to 1 MB and the 100-commit payload for this repo already
// measures ~670 KB. Left alone, ordinary growth turns the `gh` path into a
// permanent ENOBUFS — on exactly the machines the `gh` path exists for.
const gh = (...args) =>
  JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

const PER_PAGE = 100;
/** 1000 refs. A repo past this has a different problem, and we say so rather than guess. */
const MAX_PAGES = 10;

/**
 * One page of a repo endpoint, over whichever transport is available.
 *
 * `gh api` answers with the same JSON as the REST route, so both paths share
 * one shape and one field mapping. The earlier version used `gh pr list
 * --json headRefName` against REST's `head.ref`, which is two spellings of one
 * fact and the drift this repo keeps paying for.
 */
async function page(path, n) {
  const q = `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${n}`;
  return haveGh() ? gh("api", `repos/${REPO}${q}`) : await json(q);
}

/**
 * Every page, or an error — never a silent prefix.
 *
 * The unpaged version read 100 and stopped, which for branches is a false
 * ALL-CLEAR: this repo already carries ~45 remote branches and the ones that
 * truncate first are the alphabetically-last `claude/*` session branches, i.e.
 * the parallel work this whole script exists to find.
 */
async function listAll(path) {
  const out = [];
  for (let n = 1; n <= MAX_PAGES; n++) {
    const batch = await page(path, n);
    out.push(...batch);
    if (batch.length < PER_PAGE) return out;
  }
  throw new Error(
    `${path} has more than ${MAX_PAGES * PER_PAGE} entries; this check would be reading a ` +
    `prefix of them and a prefix cannot tell you nothing is there`);
}

/**
 * The ticket named as a WHOLE token.
 *
 * `STC-32` must not match `STC-325`, which a plain `includes` would do — and
 * would do silently, reporting a collision that is not one.
 *
 * That case is settled by the TRAILING `([^0-9]|$)` alone, and the leading
 * class must not also exclude `-`. It used to, and the cost was false
 * NEGATIVES on the branch names this repo actually produces:
 * `claude/start-stc-325-abc` and "pre-STC-325 refactor" both read as no work
 * found. A false negative here is the expensive direction — it is the answer
 * that tells you to go ahead and write it again.
 */
function mentions(text) {
  return new RegExp(`(^|[^A-Za-z0-9])${ticket}([^0-9]|$)`, "i").test(text ?? "");
}

async function openPRs() {
  const list = await listAll("/pulls?state=open");
  return list
    .filter((p) => mentions(p.title) || mentions(p.head?.ref))
    .map((p) => ({ number: p.number, title: p.title, url: p.html_url }));
}

async function mergedCommits() {
  // 100 is roughly a fortnight here and is a deliberate horizon rather than
  // "all of history": a ticket mentioned in a commit from months ago is
  // context, not a collision, and reporting it would train people to ignore
  // this output.
  // Deliberately ONE page, unlike the others: the horizon is the feature.
  const list = await page("/commits", 1);
  return list
    .filter((c) => mentions(c.commit?.message?.split("\n")[0]))
    .map((c) => ({ sha: c.sha.slice(0, 7), title: c.commit.message.split("\n")[0] }));
}

async function branches() {
  const list = await listAll("/branches");
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

// The header promises this rather than only describing the hazard: on the REST
// path a proxied environment whose Node was not told to use the proxy answers
// 403, which reads as "you cannot see this repository". Saying so BEFORE the
// request costs nothing; saying it afterwards is what already cost a session.
if (!haveGh()) {
  const proxied = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (proxied && !process.env.NODE_USE_ENV_PROXY) {
    console.error(
      `NOTE: a proxy is set but NODE_USE_ENV_PROXY is not, so Node's fetch will ignore\n` +
      `      it and GitHub will answer 403. Run \`npm run ticket -- ${ticket}\`, which sets it.`);
  }
}

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
