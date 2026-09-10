# STC-342 — selection overlay handles, on a Mac

Written on Linux, so every judgement about feel below is unmade. This study
did not build the overlay (STC-290 already did, with 44 passing unit tests) —
it wrote down the rules already decided (`app/src/selection.ts`'s header,
rules 1-14) and found one real defect reviewing the geometry: a resize could
shrink an existing marquee below `MIN_SELECTION_POINTS` and, on release,
discard the WHOLE selection rather than holding it at a floor. That is fixed
(rule 4) and mutation-tested. Everything STC-290's own runbook already asks
for — the dim/hole rendering, a drag crossing a bezel, per-handle Shift/Alt,
arrow nudging, the Space toggle, Escape — still applies; see
`docs/STC-290-RUNBOOK.md`. This file is only the two things THIS study
changed or newly exposed.

```
npm run app:start
```

Click the capture button (or the region hotkey) to open the overlay.

---

## §1 — the resize floor (rule 4). The main thing to judge

Draw a marquee, grab any corner handle, and drag it inward past the point
where the marquee would vanish.

* It should stop shrinking at a small but visible size — a few points on a
  side — and hold there, however much further the pointer travels.
* Release there: the marquee must still be on screen, at that floor size, not
  gone.
* The opposite corner (the one you are not dragging) must not visibly jump
  when the floor engages — `selection.test.ts` proves this exactly for a
  handful of deltas; only an eye can tell whether it holds at trackpad speed.

**The judgement:** does the hard stop read as a floor, or does it feel like
the handle stuck? The scrubber's trim handles get a rubber band past their
limit (give, then relax back on release) — this control does not; it clamps
outright. If a hard stop feels wrong next to the scrubber's give, that is a
real finding: the fix is to add the same rubber-band treatment here, not to
loosen the floor. `MIN_SELECTION_POINTS` (4) is also the number most likely
to be wrong — it was chosen so a degenerate crop can never reach the helper,
not for how it feels to grab.

---

## §2 — handle hit-testing on a floored (tiny) selection

Shrink a marquee all the way to the floor (§1), then try to grab a specific
handle on it — say, just the "e" edge, not a corner.

* At that size the eight handles are closer together than
  `HANDLE_GRAB_PADDING` (8px), so a press near the centre can be genuinely
  equidistant from several of them. `overlay-hittest.ts`'s `handleAt` breaks
  an exact tie by declared order (last-checked wins) — deterministic, not
  "correct", because there is no principled answer when the distances are
  literally equal.
* **The judgement:** is a floored selection still usable at all, or does it
  become impossible to grab a specific handle rather than whichever one the
  tie-break happens to prefer? If it is unusable, the fix is not the
  tie-break — it is a bigger floor, or handles that shrink their own hit
  targets less aggressively than the marquee does.

---

## What to write down

If either dial above needs to move, change the rule (`selection.ts`'s header)
and the constant together, in that header — not the constant alone. The next
control in the series (the floating thumbnail's motion) inherits whatever
this file and the scrubber's both say.
