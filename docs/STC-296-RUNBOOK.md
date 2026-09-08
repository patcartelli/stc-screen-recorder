# STC-296 runbook — post-capture floating thumbnail

Written on Linux, so the wiring is proven by `app/test/thumbnail.test.ts` (the
panel's own state machine, with no window) and `app/test/thumbnail.e2e.test.ts`
(a real `BrowserWindow`, driven against the stand-in helper) — but the panel's
LOOK, its animation, and whether corner placement and capture-exclusion hold up
against a real window server have never been seen. That is what this file is
for.

## What shipped in this slice

* A borderless, always-on-top panel, its own `BrowserWindow`, appearing after
  **every** still capture — the window's own button, a global hotkey, or the
  menu bar — at a configurable corner of whichever display the pointer is on.
* Auto-settles after a timeout (default 6 s, never below 3 s, both
  configurable in the window's **Still capture** section).
* Click expands it in place into the whole still UI in v1: a decoration-mode
  preset picker, **Redact** (a stub when this was written; live as of STC-297,
  which has its own runbook), **Copy**, **Save**, and a **✕** close.
* Ignoring the panel (the timeout) or pressing **✕** both settle it — export
  per the **then** preference (Save or Copy), defaulting to Save. A **Skip
  it** preference bypasses the panel entirely and always copies.
* A capture that arrives while a panel is still showing REPLACES it rather
  than stacking — and the outgoing panel is SETTLED first, not discarded, so a
  fast second capture cannot cost the first one its save.
* The panel is meant to exclude itself from a subsequent capture
  (`excludeWindowIds`, the same mechanism STC-290 built for the selection
  overlay) — **whether this actually holds on a real screen is unverified**;
  see §4.

## What is deliberately not here

Matching the scope the ticket itself allows splitting: see CLAUDE.md's STC-296
row for the reasoning. None of these exist yet:

* True OS drag-out (`NSFilePromiseProvider`). Dropping the panel on Finder,
  Slack, Figma or Mail does nothing in this slice.
* A right-click menu (copy / save as / reveal in Finder / delete / redact).
* Multiple captures stacking rather than replacing.
* "Swipe the panel off-screen to discard" — there is no discard path at all in
  this slice; every way out of the panel saves or copies something.

---

## 0. What is already settled without a Mac

| claim | where |
|---|---|
| The state machine (showing → expanded → settled), the timeout floor, corner math | `app/test/thumbnail.test.ts` |
| The panel appears, expands on click, Save/Copy/Close each behave correctly, ignoring it saves, a second capture replaces (and settles) the first, the skip preference copies with no panel and no file | `app/test/thumbnail.e2e.test.ts` |
| The preferences round-trip and validate (corner enum, timeout floor, settle action, skip) | `app/test/settings.test.ts` |

Re-run `npm test` before doing any of the below by hand — a regression there
means the Mac steps will not tell you anything new.

```
npm run app:build   # or npm run app:start, which builds first
```

## 1. Look at it

Take a still (button, or a hotkey if STC-292's are bound). Within moments, a
small panel should appear in the bottom-right corner of the display the
pointer was on.

* **It should look like a small, deliberate object** — rounded corners, a soft
  shadow, sitting ABOVE everything else, including a full-screen app. It must
  NOT look like a stray rectangular window: `transparent: true` + `hasShadow:
  false` on the `BrowserWindow` means the rounding and the shadow are drawn
  entirely by `thumbnail.html`'s own CSS, and if either got lost in a change
  the panel will read as a plain grey box.
* **The appear animation** — a short fade/scale-in — should be smooth, not a
  flash or a jump. `card.classList.add("in")` fires only after the frame has
  actually painted once, specifically so there is nothing to flash.
* Change **Panel corner** in **Still capture** to each of the four values, and
  confirm a fresh capture actually appears in that corner, clear of the menu
  bar and the Dock (it targets the display's WORK AREA, not its full bounds).

**A wrong result worth naming:** a panel that appears solid grey/white instead
of translucent means the window's own `transparent: true` was lost, or the
page's `body`/`html` background is opaque.

## 2. The timeout and "nothing is lost by doing nothing"

1. Take a still. Do not touch the panel. Watch it for the full **Closes
   after** duration (default 6 s) plus a moment.
2. **The panel should fade or otherwise dismiss itself — never just vanish
   mid-frame** — and a file should appear in the destination folder (or on
   the clipboard, if **then** is set to Copy). This is confirmed by the E2E
   suite already; what a person needs to judge is whether the DISMISSAL looks
   intentional rather than like the app crashed.
3. Set **Closes after** to 3 (the floor) and confirm it still gives you time
   to register the panel exists before it goes — 3 s is a deliberate minimum,
   not a suggestion, and if it reads as "gone before I noticed it appeared"
   that is a product finding worth raising, not a bug to route around by
   lowering the floor further.

## 3. Click to expand

1. Take a still, then click the panel before it times out.
2. **It should expand IN PLACE** — same corner, same general position, larger
   — into the mode picker, Redact (greyed out), Copy, Save, ✕.
3. Change the **Style** dropdown (only present for a window capture with
   alpha — a display crop offers only "Selected area"). The preview should
   redraw for each mode, matching what STC-291's runbook already describes for
   each preset.
4. **Redact** was a greyed-out stub when this runbook was written and is live
   as of STC-297 — it now grows the panel into a drag surface. Check it there:
   `docs/STC-297-RUNBOOK.md`.
5. Click **Copy**. The panel should show a brief confirmation and STAY OPEN —
   paste into Preview or Mail and confirm the decorated image (not the raw
   capture) arrived.
6. Click **Save**. The panel should close shortly after, and the decorated
   file should be in the destination folder (**Still capture** → **Saving
   to**).
7. On a fresh capture, click **✕** without touching Copy or Save. The panel
   should close and a file should still appear — closing is a settle action,
   not a discard.

## 4. Capture-exclusion — the one this repo cannot prove blind

The acceptance list: *"Panel never appears in a subsequent capture's pixels,
including a full-display capture on the same display."* The mechanism
(`beforeCapture` in `thumbnail-window.ts`, reusing `overlay-session.ts`'s
`windowIdOf`/`HIDE_SETTLE_MS`) is wired in; whether `getMediaSourceId()`
actually resolves a usable id for a JUST-HIDDEN, possibly still-loading panel
window is untested outside a real window server — the E2E suite's own
assertion on this is deliberately conditional (`app/test/thumbnail.e2e.test.ts`,
"when an id resolves") for exactly that reason.

1. Take a still so the panel is showing. **Before** it times out, take a
   **full-display** capture of the SAME display (hotkey, or the button after
   Escaping any overlay).
2. Open the new capture's `frame.png`. **The panel must not be visible in
   it** — no rounded card, no shadow, nothing at the corner it was sitting in.
3. Repeat with a **region** capture whose selection overlaps the panel's
   corner.

**If the panel DOES appear in the pixels:** check whether
`app/src/thumbnail-window.ts`'s `hide()` returned a window id at all (add a
temporary `console.log` around `windowIdOf(this.win.getMediaSourceId())`) —
this is precisely the "empty when the platform would not name them" case
`overlay-session.ts` already warns about, and if it is genuinely empty here
the fix is a longer wait after `hide()`, mirroring `HIDE_SETTLE_MS`'s own
"belt and braces" reasoning: the hide is what actually removes it from the
window server, and the exclusion list is the second belt, not the only one.

## 5. Multiple captures in quick succession

The ticket's acceptance line: *"Five captures in five seconds produce five
recoverable shots."* This slice does not STACK — a new capture replaces the
showing panel — but the replaced one must still be recoverable, which the E2E
suite proves through the settle path. What is worth an eye on real hardware:

1. Fire a capture, then fire four more in quick succession (hotkey is
   easiest) before any timeout could fire.
2. Each capture's own take directory should contain its `shot.json` and
   `frame.png` regardless of how many panels came and went — that part never
   depended on the panel.
3. **What to actually judge:** does the rapid replacement look jarring (a
   panel popping in, vanishing, popping in again four times in five seconds)?
   That is expected in v1 and is exactly the gap STC-296's own "stacking" scope
   item exists to close later — worth confirming it reads as "acceptable for
   now" rather than "broken," since that judgement is what decides how urgent
   the stacking follow-up is.
