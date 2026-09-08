# STC-294 runbook — screenshots in the take library

Written on Linux. Unusually for this project, most of it **was** exercised
here: the E2E suite runs under `xvfb-run`, so the grid really was assembled,
filtered, and made to render and cache a decorated thumbnail from a real
`shot.json`. What that cannot tell you is whether it LOOKS like anything, and
whether the acceptance criterion about 500 takes at 60 fps survives contact
with a real 4K library.

## What shipped

* **One index over both kinds.** A directory holding `anchors.json` is a
  recording; one holding `shot.json` is a still; anything else is reported as
  broken, with a reason. One storage root, one scan — the ticket's constraint.
* **The bug this fixes:** stills have gone into the same root since STC-289 and
  the scanner only looked for `anchors.json`, so **every still capture was
  listed as a broken recording** ("no anchors.json — not a recording"). If you
  have taken stills on this Mac, they are sitting in the library's invalid list
  right now, and they should all appear as tiles after this change.
* **A grid**, replacing the row list: a tile per take with a type badge, the
  kind's own summary line, and its own buttons.
* **A kind filter** — All / Recordings / Stills, mixed by default.
* **Decorated thumbnails for stills**, rendered through the same `layoutStill` +
  `renderStill` the panel and the export use, and cached as `thumb.png` inside
  the take directory.
* **Re-open** a still into the post-capture panel with its decoration — mode,
  canvas, and STC-297's redaction boxes — intact, and re-exportable. This is
  what `docs/STC-297-RUNBOOK.md` §"deliberately not here" was waiting on.
* **Duplicate** a still, to try a second decoration without re-capturing.

## What is deliberately not here

* **Poster frames for recordings.** A recording's tile has a placeholder, not a
  picture. Decoding a frame per tile is the WebCodecs path CLAUDE.md documents
  as tab-killing at scale (one in-flight request, ~30 MB per `VideoFrame`), and
  it wants its own bounded queue. The adapter says `thumbnail: {source: "none"}`
  so adding it later changes one function.
* **Re-opening a still into an editor.** There isn't one — STC-300 is
  deliberately gated (`docs/STC-300-FORMAT-AUDIT.md`). Re-open goes to the
  panel, which is the whole still UI in v1.

---

## 0. What is already settled without a Mac

Do not re-litigate these by hand.

| claim | where |
|---|---|
| Both kinds classified from one pass; a still is no longer "broken"; a mixed library interleaves by timestamp rather than clumping by kind | `app/test/library.test.ts` |
| A `shot.json` `parseShot` refuses is reported with the loader's own message; a missing frame is named | same |
| Each kind's summary, badge and action list; labelling works over both | same |
| **No view component branches on kind** — the ticket's fourth acceptance criterion, grepped, with controls proving the patterns both fire and stay quiet | `app/test/library-seam.test.ts` |
| The grid draws mixed / stills-only / empty; the filter narrows and restores; a still's thumbnail is rendered and cached beside its document; duplicate copies the decoration but not the cache | `app/test/library.e2e.test.ts` |
| The phase-2 recording behaviour survived the scanner moving | `app/test/take-list.test.ts`, unchanged but for its imports |

```
npm run app:build     # or npm run app:start, which builds first
npm test
```

## 1. The thing to check first — your existing stills

If you have taken any stills on this Mac, they are in `~/Desktop/stc` already.

1. Open the app.
2. **Every past still should now be a tile with a picture**, not a red line in
   the broken list at the bottom.
3. If any still is still reported as broken, **read the reason** — it will name
   what `parseShot` refused. That is a real finding: a document the helper wrote
   that the loader will not read means the two disagree about `shot-1`, which is
   worth a ticket rather than a shrug.

## 2. Does the grid look like anything?

Written blind, so this is the part with no automated opinion.

1. **Tiles.** Are they a sensible size? The grid is
   `repeat(auto-fill, minmax(210px, 1fr))`, so a wide window gets more columns
   rather than wider tiles.
2. **The picture.** A still's thumbnail is the DECORATED result — so a
   `window-shadow-background` shot should show its background and shadow in the
   grid, not the bare window. That is the ticket's own wording: *"the grid shows
   what the user will get."*
3. **A window capture's alpha.** A `window-only` shot has real transparent
   corners. The empty-tile background is a checkerboard rather than a flat
   colour for exactly this reason — **look at whether a transparent thumbnail
   reads as transparent or as if it has a white background.** If it reads
   white, the tile is compositing it onto something opaque.
4. **The badge.** Still tiles get a blue-ish badge, recordings a grey one. Both
   legible in Light and Dark? The colours are the one place in this feature that
   knows there are two kinds, and they are in `index.html`'s stylesheet.
5. **A recording's placeholder.** It is a plain empty box. Does the grid read as
   half-broken because half the tiles have no picture? That is a real product
   finding and the reason poster frames are a named follow-up rather than a
   never.

## 3. The 60 fps criterion

The acceptance line is *"a library containing 500 mixed takes scrolls at 60 fps
with decorated thumbnails cached."* Nothing here can produce 500 real takes, so
make them:

```
# from a take you already have, in a scratch root
mkdir -p /tmp/stc-500 && cd /tmp/stc-500
for i in $(seq -w 1 500); do
  cp -R ~/Desktop/stc/<a-still-take> "2026-09-08_00-00-$i"
done
STC_RECORDINGS_DIR=/tmp/stc-500 npm run app:start
```

1. **First open is the slow one** — nothing is cached, and each visible tile
   renders its decoration. Tiles paint as they scroll into view, a screenful
   ahead (`IntersectionObserver`, `rootMargin: 200px`), so what to judge is
   whether SCROLLING stays smooth, not whether everything appears at once.
2. **Scroll to the bottom and back.** Second pass reads `thumb.png` and should
   be visibly faster.
3. **Quit and reopen.** Everything is cached now. This is the run the criterion
   is actually about: 500 tiles, all cached, scrolled top to bottom.
4. **What would make this wrong:** tiles that pop in late and shove their
   neighbours around. The tile reserves a fixed `aspect-ratio` box precisely so
   the grid cannot reflow as pictures land; if it reflows anyway, that is the
   thing to fix, not the render cost.

**Also worth measuring rather than eyeballing:** 500 directories is 500
`readdir` + `stat` passes on every refresh, and the scan is not incremental. If
opening the window takes noticeably long before anything draws, the cost is the
SCAN, not the thumbnails, and that is a different fix (a cached index) from a
different ticket.

## 4. Re-open and duplicate

1. Click **Open** on a still that has redaction boxes (make one if you have
   none — `docs/STC-297-RUNBOOK.md`).
2. **The panel should appear with the boxes already on it.** That is the payoff
   of keeping decoration in JSON, and it is the first time in this project that
   an old shot can be reached at all.
3. **Ignore the panel and let it time out.** It should close and **write
   nothing** — no new file in the destination folder. This differs from a fresh
   capture on purpose: ignoring a new capture still saves it, because the panel
   is the only place it exists; ignoring a re-opened one must not silently write
   a second copy of a shot that is already on disk. **Check the destination
   folder before and after.**
4. Re-open again and press **Save**. Now a file SHOULD appear — an explicit
   action still exports.
5. Click **Duplicate** on a still. A second tile appears with the same picture.
   Open the copy, change its Style, Save. **The original must be unchanged** —
   open it and confirm its own decoration survived.

## 5. Delete, and the no-orphans criterion

1. Delete a still that has been shown in the grid (so it has a cached
   `thumb.png`).
2. Confirm the Trash contains the whole directory — `frame.png`, `shot.json`
   AND `thumb.png`.
3. `ls ~/Library/Application\ Support/stc-screen-recorder` — **there should be
   no thumbnail cache anywhere outside the take**. The cache lives in the take
   directory precisely so this criterion is true by construction; if a cache
   directory has appeared elsewhere, something has been added that reintroduces
   the orphan.

## 6. What would make this wrong, and is worth looking for

* **A thumbnail that does not match what Save produces.** They go through the
  same `layoutStill` + `renderStill`, so a difference means a second rendering
  path has appeared — the thing STC-293's Note forbids.
* **A stale thumbnail after re-decorating.** `still:writeShot` deletes
  `thumb.png`, so editing a shot's redaction boxes and going back to the library
  should show the NEW boxes on the tile. Worth checking by eye, because a cache
  that lies is the whole risk of caching at all.
  Note what is NOT persisted in this slice: the panel's **Style** dropdown is
  ephemeral (STC-297 stores only `decoration.redactions`), so changing Style,
  saving and returning to the library legitimately leaves the tile as it was —
  the shot on disk did not change. That is a gap in what the panel writes, not
  a stale cache, and it is `docs/STC-300-FORMAT-AUDIT.md` §8's missing write
  path.
* **A still whose tile is blank.** The picture failing costs the tile its
  picture and nothing else, by design — so a blank tile is silent. If one is
  blank, open the window's devtools console: the render throws there.
