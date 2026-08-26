# Handoff: rebasing PR #3 (STC-241, in-app trim)

Written 2026-08-26 for whoever picks up the rebase. You do not need the session
that produced this.

**PR:** https://github.com/patcartelli/stc-screen-recorder/pull/3
**Branch:** `accounts/stc-241-trimedit-ui`, worktree `../stc-screen-recorder-stc-241`
**Head:** `d48c02d`

## What changed underneath you

The PR branched at `68b5666` and is now eight commits behind. Master moved a
lot on 2026-08-26:

| commit | what |
|---|---|
| `955dbca` | STC-254 part 2 — `WriterGate` serialises appends against writer teardown |
| `e4fa42d` | STC-254 part 3 — SIGTRAP crash handler |
| `a34aba1` | **STC-232 — camera PiP increments 1–2. This is the one that matters to you.** |
| `fa82a21` | STC-258 — the whole `start` path is now bounded; Swift harness runs are bounded |

Master is green. `npm test` is 159 tests / 25 files.

## 1. The textual conflict (small)

A trial merge (`git merge-tree --write-tree origin/master refs/remotes/pr3`)
reports exactly one conflict:

```
CONFLICT (content): Merge conflict in transform/src/types.ts
```

Both sides edit the `Project` interface. Yours adds `trim?: Trim`; master's
STC-232 work changed `version` to `1 | 2` and added `pip?: Pip`. Mechanical.

`transform/test/schema.test.ts` auto-merges but both sides appended tests —
read the result rather than trusting it.

## 2. The semantic problem (the actual work)

**This is why a plain rebase is not enough.**

Your PR adds `trim` to `schema/project-1.schema.json`, extending v1 in place.
STC-232 minted `schema/project-2.schema.json` — copied from project-1 *before*
your trim existed — and added `pip` to it, with `version: { "const": 2 }`.

Rebase without thinking and you get:

| schema | trim | pip |
|---|---|---|
| `project-1` | yes | no |
| `project-2` | **no** | yes |

**A v2 project document cannot express a trim.** Enable PiP, lose trimming. The
edit document forks in two, which is exactly what "the project IS the edit
document" exists to prevent.

### Recommended resolution

Move your `trim` block from `project-1.schema.json` into
`project-2.schema.json`, beside `pip`. Leave `project-1` untouched — it is the
back-compatibility fixture and `fixtures/basic` deliberately stays at version 1
so that v1-still-loads is a *tested* property. Do not "tidy" that fixture.

Then `transform/src/types.ts` has one coherent `Project`:

```ts
export interface Project {
  version: 1 | 2;
  output: { fps: 60; width: number; height: number };
  cursor: { style: "default"; scale: number };
  pip?: Pip;      // from STC-232
  trim?: Trim;    // yours
}
```

`transform/src/session.ts` already accepts anchors v1 **and** v2 and treats the
v2 additions as optional, so nothing there should need changing.

### The version gate that will bite you on that path

Moving `trim` into project-2 is the right call, but the PR's own parser and
writer are hardcoded to v1, and neither the textual merge nor `npm test` will
tell you:

| where | what it does |
|---|---|
| `transform/src/trim.ts:75` | `if (doc.version !== 1) return fallback;` — every v2 document is discarded and replaced with a default |
| `trim.ts:59`, `trim.ts:92` | `defaultProject` and `projectForWrite` both emit `version: 1` |

So after a naive move you get a write path still emitting **v1** documents
carrying a `trim` the v1 schema no longer declares, and any real **v2**
document — the ones STC-232 mints for PiP — silently losing both `pip` and
`trim` on load. The comment above that gate frames the fallback as
corruption-tolerance, so it will not look like a bug when it fires.

Widen the version gate and the write path in the same change as the schema
move. `test:slow` will **not** catch this: it compares the UI export against
the CLI one, and both would lose the trim identically.

Version gates are inconsistent across the repo generally, which is what makes
this easy to miss: `transform/src/session.ts:44` takes anchors v1 **or** v2,
while `app/src/takes.ts:110` still rejects anything but v1. That one is
pre-existing and not yours to fix, but it is the same shape of bug.

### A convention worth settling while you are here

Your PR extends a versioned schema in place; STC-232 mints a new version for
the same kind of change. Both are defensible, the repo should pick one, and
right now it does both. Worth a line in `CLAUDE.md` once decided.

## 3. The trim invariant is already enforced — do not add a second check

An earlier version of this handoff claimed the `endNs > startNs` invariant was
documented but unchecked, and that a reversed trim would silently produce a
negative-length export. That was wrong. It is corrected here rather than
quietly deleted, because the old text is still in this branch's history.

`clampTrim` enforces it:

```ts
// transform/src/trim.ts:26
const end = Math.max(start + min, Math.min(Math.round(endNs), dur));
```

`min` is one 60 fps frame, so `end` always lands at least a frame past `start`.
Every path that touches a trim goes through it — `parseProject` on load
(`trim.ts:85`), `exportWindow` on export (`trim.ts:46`), the renderer on edit
(`renderer.ts:170`) — and `export.ts:67` is the only export consumer, reaching
it through `exportWindow`. That function also floors `endFrame` at `fromFrame`
independently, so `maxFrames >= 1` even if the clamp were somehow bypassed. A
reversed trim is corrected to a one-frame window, never a negative one.

What is worth a minute: `schema/project-1.schema.json` says

> endNs must be greater than startNs

which reads as an obligation on whoever consumes the document. JSON Schema
cannot express the comparison and the transform already discharges it, so point
that description at `clampTrim` instead — otherwise the next reader takes it
for an open TODO, as this handoff did.

## 4. How to verify the rebase

```
npm test              # must be green — 159 tests before your change
npm run test:slow     # UI vs CLI export identity — see below
npm run gate:export   # two independent exports, byte-identical pre-encode
```

**`test:slow` is the gate that matters for this PR and it does NOT run in CI.**
It is the only thing that would catch a semantic divergence between the UI
export path and the CLI one, and your PR touches `transform/src/export.ts`.
Baseline: it passed 2/2 in 49 s on master at `fa82a21` on 2026-08-26, so a
failure after your rebase is yours, not pre-existing.

`gate:export` needs a real take; `~/Desktop/stc` has two.

## 5. Traps that will cost you time

These are in `CLAUDE.md` and each cost someone a real debugging session:

- **`master` is protected.** Everything goes through a PR, and you merge with
  `npm run merge -- <pr>`, never `gh pr merge --auto`.
- **`gh pr checks --watch` exits 0 when no checks exist yet.** Run it in the
  seconds after opening a PR and it reports success having watched nothing.
  Confirm a run exists for your head SHA first, then watch it by id.
- **`codesign` can block forever on a hidden GUI keychain dialog.** If a build
  hangs past ~90 s, look for the dialog. Do not wrap codesign in `timeout` —
  that kills the dialog before a human can find it.
- **A failed `swiftc` leaves the previous binary in place**, so a green test can
  be testing stale code. Check build exit codes.
- **Do not read a green PR run as proof for an intermittent fault.** The
  regression test is the evidence; the tick is corroboration.

## 6. Open tickets touching your area

- **STC-259** (Medium, watch item) — a CI job once hung for 30 minutes in the
  writer-gate harness. Investigated: the deadlock theory was refuted, two
  harness defects were fixed, the hang itself was never reproduced. Not
  expected to affect you; if you see a harness hang, that ticket wants to know.
- **STC-232 increments 3–5** — camera capture, sinks, app toggle. Increment 3
  adds a second video track and touches `transform/src/export.ts`, the file you
  also touch. Landing your rebase before that work starts avoids a second,
  harder collision.
