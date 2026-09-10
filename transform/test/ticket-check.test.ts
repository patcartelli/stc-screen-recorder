import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `npm run ticket` exists to be BELIEVED. Nobody runs it for fun — it is run
 * once, at the moment somebody is deciding whether it is safe to start
 * writing, and the only output that changes their behaviour is the all-clear.
 *
 * So the property under test is not "does it find things" but **it must never
 * exit 0 for a reason other than there being nothing there**. Every test here
 * is a way the old version could answer "nothing found" while something was.
 *
 * These drive the real script with a stub `gh` on PATH — the arrangement
 * `merge-when-green.test.ts` already uses — because the `gh` branch is the one
 * CI can otherwise never reach: CI has no `gh`, so it takes the REST path and
 * a broken `gh` invocation would stay green forever. That was the unchecked
 * box on this script's own PR.
 */
const root = join(__dirname, "..", "..");
const SCRIPT = join(root, "scripts", "ticket-check.mjs");

interface Stub {
  /** `gh auth status` exits non-zero — installed but logged out. Default authed. */
  authed?: boolean;
  prs?: { number: number; title: string; head: string }[];
  commits?: string[];
  /** One entry per page, so a ticket can be put on page 2 where a prefix read misses it. */
  branchPages?: string[][];
  /** Every branch page comes back full, so the walk never terminates on its own. */
  branchesAlwaysFull?: boolean;
  /** Bytes of filler on the commits payload, for the maxBuffer ceiling. */
  padBytes?: number;
}

function stubGh(cfg: Stub) {
  const dir = mkdtempSync(join(tmpdir(), "gh-ticket-stub-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  // Node rather than sh: these payloads are JSON of a controlled SIZE and
  // shape, and generating 100 branch names or a megabyte of filler in shell
  // quoting is how a stub grows bugs of its own.
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));
const argv = process.argv.slice(2);
fs.appendFileSync(__dirname + "/argv.log", argv.join(" ") + "\\n");
if (argv[0] === "auth") process.exit(cfg.authed === false ? 1 : 0);
if (argv[0] !== "api") process.exit(0);
const path = argv[1];
const page = Number((path.match(/[?&]page=(\\d+)/) || [, "1"])[1]);
let out = [];
if (path.includes("/pulls")) {
  out = page === 1 ? (cfg.prs || []).map((p) => ({
    number: p.number, title: p.title, head: { ref: p.head },
    html_url: "https://github.com/x/y/pull/" + p.number,
  })) : [];
} else if (path.includes("/commits")) {
  out = (cfg.commits || []).map((m, i) => ({
    sha: String(i).padStart(40, "0"),
    commit: { message: m + (cfg.padBytes ? "\\n" + "x".repeat(cfg.padBytes) : "") },
  }));
} else if (path.includes("/branches")) {
  if (cfg.branchesAlwaysFull) {
    out = Array.from({ length: 100 }, (_, i) => ({ name: "filler/" + page + "-" + i }));
  } else {
    out = ((cfg.branchPages || [])[page - 1] || []).map((name) => ({ name }));
  }
}
process.stdout.write(JSON.stringify(out));
`);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

/** Every `gh` invocation the script actually made. */
const argvLog = (dir: string) =>
  existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8") : "";

function run(dir: string, ticket: string, env: Record<string, string> = {}) {
  // spawnSync, not execFileSync: execFileSync returns stdout ONLY, and this
  // script writes its failure paths to stderr — asserting on them through
  // execFileSync fails for the wrong reason.
  const r = spawnSync("node", [SCRIPT, ticket], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("ticket-check: the all-clear must mean something", () => {
  test("a clean ticket exits 0 and says to claim it", () => {
    const dir = stubGh({ prs: [], commits: [], branchPages: [[]] });
    const r = run(dir, "STC-99999");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/Nothing on GitHub names STC-99999/);
  });

  test("a hyphen before the ticket is still the ticket", () => {
    // The regression. The leading class used to exclude `-`, so every branch
    // name of the shape this repo actually produces — `claude/start-stc-325-x`,
    // merged twice on 2026-09-09 — read as NO WORK FOUND. A false negative is
    // the expensive direction: it is the answer that says go ahead and write it.
    const dir = stubGh({ branchPages: [["claude/start-stc-325-8pn8g4"]] });
    const r = run(dir, "STC-325");
    expect(r.code, `a hyphenated branch name was not found:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/claude\/start-stc-325-8pn8g4/);
  });

  test("STC-32 still does not match STC-325", () => {
    // The control for the test above, and the reason the trailing boundary
    // stays: widening the leading class must not widen the trailing one.
    const dir = stubGh({ branchPages: [["accounts/stc-325-zoom"]], commits: ["STC-3251: unrelated"] });
    const r = run(dir, "STC-32");
    expect(r.code, `STC-32 matched something it should not:\n${r.out}`).toBe(0);
  });

  test("a branch on page 2 is found", () => {
    // The unpaged version read 100 branches and stopped. This repo carries ~45
    // today and the entries that truncate first are the alphabetically-last
    // `claude/*` session branches — exactly the parallel work being looked for.
    const first = Array.from({ length: 100 }, (_, i) => `filler/${i}`);
    const dir = stubGh({ branchPages: [first, ["claude/stc-325-late"]] });
    const r = run(dir, "STC-325");
    expect(r.code, `a branch past the first page was missed:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/claude\/stc-325-late/);
  });

  test("more pages than the ceiling is exit 3, never exit 0", () => {
    // The one that decides whether this script can be trusted at all: when it
    // cannot read the whole list it must say so, not hand back a prefix. A
    // prefix is indistinguishable from a clean answer.
    const dir = stubGh({ branchesAlwaysFull: true });
    const r = run(dir, "STC-325");
    expect(r.code, `a truncated listing did not report as broken:\n${r.out}`).toBe(3);
    expect(r.out).toMatch(/COULD NOT CHECK/);
    expect(r.out, "exit 3 must not read as an all-clear").not.toMatch(/Nothing on GitHub/);
  });

  test("an installed but logged-out gh falls back instead of dying", () => {
    // `haveGh()` used to test only that the binary existed, so a logged-out
    // `gh` sent every query down a path that throws and the REST fallback in
    // the same file — which needs no token on a public repo — was never tried.
    //
    // The fallback's own network is neutralised here (an unroutable proxy), so
    // this asserts the DECISION: gh was consulted for auth and then not used
    // for any query. The exit is 3 because the substitute route was cut, which
    // is the honest answer for a check that could not reach GitHub.
    const dir = stubGh({ authed: false });
    const r = run(dir, "STC-325", {
      NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1",
    });
    const log = argvLog(dir);
    expect(log, "gh should have been asked whether it is authenticated").toMatch(/auth status/);
    expect(log, "a logged-out gh must not be used for queries").not.toMatch(/^api /m);
    expect(r.code, r.out).toBe(3);
  });

  test("a commits payload over 1 MB does not kill the gh path", () => {
    // execFileSync's default maxBuffer is 1 MB and this repo's real 100-commit
    // payload already measures ~670 KB, so the `gh` path was a few months from
    // permanent ENOBUFS — on exactly the machines it exists for.
    const dir = stubGh({ commits: ["STC-325: something"], padBytes: 2 * 1024 * 1024 });
    const r = run(dir, "STC-325");
    expect(r.code, `a large payload broke the gh path:\n${r.out.slice(0, 400)}`).toBe(1);
    expect(r.out).toMatch(/STC-325: something/);
  });

  test("a PR is matched on its head branch, not only its title", () => {
    // The transports used to disagree about where that lives — `gh pr list
    // --json headRefName` against REST's `head.ref` — which is two spellings
    // of one fact. Both paths read `head.ref` now; this pins it.
    const dir = stubGh({ prs: [{ number: 108, title: "auto-zoom stage 1", head: "accounts/stc-325-zoom" }] });
    const r = run(dir, "STC-325");
    expect(r.code, `a PR naming the ticket only in its branch was missed:\n${r.out}`).toBe(1);
    expect(r.out).toMatch(/#108/);
  });

  test("a bad argument is exit 2, distinct from both other failures", () => {
    const dir = stubGh({});
    const r = run(dir, "nonsense");
    expect(r.code, r.out).toBe(2);
  });
});
