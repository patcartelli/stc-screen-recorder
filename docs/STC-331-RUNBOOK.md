# STC-331 — manual override, phase 2 (author a new zoom window), on a Mac

Written on Linux, so **every judgement about look and feel is unmade**, and
the same `gate:identity` gap STC-330's own runbook already records applies
here too — the gates need real Chrome, which this sandbox does not have.
Everything the pure and E2E tests can check is checked: pure tests in
`transform/test/zoom-override.test.ts` / `zoom-override-project.test.ts`
(manual windows resolving their own crop/easing with no overrides-table
lookup, coexisting with a derived window, `inWindow`/`nearestWindow` under
overlap) plus 9 real-pointer E2E tests
(`app/test/zoom-override-manual.e2e.test.ts`) driving the actual editor
window under `xvfb-run` — clicking empty lane space to create one, dragging
its edge handles, the rect tool, the preset picker, and deleting it.

```
npm run app:start          # NOT via Playwright — see the TCC trap in CLAUDE.md
npm run gate:identity       # the one thing this session could not run at all
```

Open any take (a manual window needs no click or drag in the recording
itself — that is the whole point of this ticket).

---

## §0 — is this the build you think it is?

* The Zoom lane now responds to a click on EMPTY space (nothing under the
  pointer) by opening a dashed block there, immediately in edit mode — the
  rect tool and override bar appear the same way they do for STC-330's
  existing blocks.
* That dashed block has two small handles at its own left and right edges.

If clicking empty lane space does nothing, `editor.js` is stale — rebuild.

---

## §1 — creating one, and what "empty" means

* Click somewhere in the Zoom lane where there is no derived window's block
  (STC-330's solid shapes) and no other manual window already. A new dashed
  block should appear straight away, sized to the locked stage-1 shape
  (300ms lead + 2500ms hold, ~2.8s) — NOT to whatever you clicked-and-held,
  since the ticket's own words are "as a STARTING size". Does 2.8s read as
  a sensible default width at the zoom levels you actually work at, or does
  it dominate a short take / vanish on a long one?
* Click ON an existing block (derived or manual) instead — it should open
  THAT block for editing, never create a new one underneath it.
* Does the dashed border read as "not derived from anything" at a glance,
  next to STC-330's solid derived blocks? That is the one visual distinction
  this phase adds — if it does not read, the dial to turn is
  `.zoomblock.manual`'s CSS in `app/renderer/editor.html`.

## §2 — resizing by the edges

* Drag the LEFT handle. The window's start should track the pointer,
  clamped so it can never cross the right edge (a floor of 300ms — the
  lead time itself, `MIN_MANUAL_WINDOW_NS` in `editor.ts` — under the
  right edge). Does the clamp feel like resistance, or like the handle
  gets "stuck" with no feedback about why (there is no rubber band here,
  unlike the trim lane's handles — a deliberate simplification, worth
  knowing if it reads as a downgrade next to that lane)?
* Drag the RIGHT handle symmetrically.
* Drag a handle PAST the far edge of the visible lane (off the end of the
  current pan/zoom). Does it keep tracking correctly, or does panning
  interact badly with an active resize?
* This is also where the STC-330 bug this ticket found and fixed would
  show up if it were still broken: pan or zoom the ruler away from the
  default full view, THEN try to select or create a block. Before the fix,
  `#override-blocks` never received the ruler's pan/zoom transform its own
  sibling lanes did, so a block's click target and the curve under it would
  have drifted apart the moment the view was not the default. If blocks and
  the zoom curve visibly disagree about where a window is once you have
  panned or zoomed, that regression is back.

## §3 — the rect tool and preset picker

Same tool STC-330 built — see that runbook's §3/§4 for what to look at.
The one difference worth checking here: a manual window's easing has no
"Project default" fallback the way a derived window's does (the schema
REQUIRES it), so leaving the picker on "Project default" and committing
should still produce a real preset — currently the project's own current
one, resolved at commit time. Is silently resolving to the project's
preset the right behaviour, or should the picker simply not offer that
option at all for a manual window (it currently does, for one shared
control rather than a second)?

## §4 — Remove becomes Delete

For a manual window, the override bar's button reads **Delete window**
instead of **Remove override** (`selectManualWindow`'s own note explains
why: there is no "no override" state for a manual window to fall back to —
its rect and timing ARE the window). Does that label swap read clearly, or
does it need a moment to notice mid-workflow?

## §5 — a stray click, and whether "closing always commits" is right here

Click empty lane space, then immediately press Escape or Done with NO
drag at all — no rect drawn, no timing changed. The current behaviour
COMMITS the window anyway, at its default rect and span (the same "closing
IS committing" rule STC-330 already established for looking at an existing
block with no changes). For a brand-new window this means a single stray
click on the lane permanently authors one, recoverable only via **Delete
window**. Is that the right default, or should a genuinely untouched new
draft be discarded instead of committed — the one open product question
this phase did not resolve on its own, because it needs a hand on a real
trackpad to judge whether a stray click is common enough to matter.

## §6 — does the whole thing survive an export?

Same as STC-330's own §6, with a manual window in the mix:

* Author one over a stretch of the take auto-zoom never opened a window
  for. Export, and watch the file in a real player. Does the picture zoom
  into the tuned rectangle during exactly that span, with no zoom either
  side of it?
* If the take ALSO has a derived window (STC-330) or a manual one that
  overlaps this one's span, watch what happens where they meet — the
  ticket deliberately leaves this unsolved (`zoom.ts`'s `inWindow` and
  `zoom-override.ts`'s `nearestWindow` are both correctness-preserving
  under overlap now, tie-breaking to whichever window starts later, but
  nothing here claims that reads as *right* on a real take). Does the
  transition look like a glitch, or does it read as "the later window
  won", which is at least explicable?

## What is deliberately NOT here

* STC-329 (remove/retime a DERIVED window) — phase 3 of STC-328, its own
  ticket.
* Any special UI for two manual windows overlapping each other, or a
  manual window overlapping a derived one — see §6 above; this phase's own
  text scopes that out ("windows already merge on their own signal ... not
  something this phase needs to solve").
* Undo/redo beyond dragging again, or a confirmation dialog on Delete —
  the same "drag again is the undo" posture STC-330 already took.
