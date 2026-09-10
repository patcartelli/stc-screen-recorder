# STC-343 — the floating thumbnail's motion, on a Mac

Written on Linux, so every judgement about feel below is unmade. This study
did not build the panel — STC-296 already did, across several passes, with
44+ unit assertions and a real-Electron E2E suite. It wrote down the rules
already decided (`app/src/thumbnail.ts`'s header, rules 1–10) and found one
real defect reviewing the motion math: a discard (swipe or right-click
Delete) could race the panel's own timeout, and on a coincidental delete
failure the recovery UI would be stranded inside a window main had already
hidden. That is fixed (rule 6) and covered by a source-level regression test
— see the header for why a live timing test was not the right instrument.

Everything STC-296's own runbook already asks for — the panel's look, the
appear animation, the timeout floor's feel, expand-in-place, capture
exclusion — still applies; see `docs/STC-296-RUNBOOK.md` (though it predates
drag-out, the right-click menu, swipe and stacking, all of which have since
landed — treat its "What is deliberately not here" section as stale).

```
npm run app:start
```

Take a still (the window's button, or a bound hotkey) and work with the panel
that appears.

---

## §1 — the discard/timeout race (rule 6). The main thing this study changed

This cannot be triggered on demand by hand — it needs a discard to land in
the same narrow window as the panel's own timeout AND the delete to fail,
which on a healthy Trash is rare. What is worth doing:

1. Set **Closes after** to the floor (3 s) in **Still capture**.
2. Take a still, and swipe it toward its own corner right as the panel is
   about to expire — aim for the last second of its countdown.
3. It should discard cleanly: the panel flies off, and the shot is in the
   Trash. Nothing about this should look different from a discard early in
   the panel's life.

**What would tell you the fix is wrong:** a panel that discards but a moment
later the SAME shot reappears somewhere (the settle path running anyway), or
a discard failure message that never appears when you'd expect one (revoke
write access to the Trash location, if you want to force a real failure, and
confirm "Could not discard" is legible rather than the panel just vanishing).

---

## §2 — drag-out and the panel's lifecycle (rule 8)

Drag a collapsed panel out toward Finder, Slack, or Mail — NOT toward its
own corner (that discards; see rule 5's corner-direction split).

* The drag should commit quickly (`DRAG_START_PX` is 12 px — well under the
  90 px a discard needs), and the file that lands should be the DECORATED
  still, not the raw capture.
* **After the drop, the panel does not disappear.** It stays exactly where
  it was, still counting down. This is deliberate (rule 8) — Electron gives
  no signal that a drag has completed, so there is nothing to hook a
  dismissal to, and the panel simply times out normally afterwards.
* **The judgement:** does that read as a bug, or as reasonable? If it reads
  as a bug to everyone who tries it, the honest fix is not a fake signal
  (there isn't one to fake) — it would be showing something in the panel
  itself once the drag starts (a brief "sent" state) so the ongoing
  countdown reads as intentional rather than as the app forgetting what
  just happened.
* Also try dragging and dropping on **nothing** (an empty desktop area, or
  releasing over the panel's own display with no drop target under it). The
  panel should behave exactly as if the drag never started.

---

## §3 — stacking's motion (rule 4)

Fire a capture, then three or four more in quick succession (a bound hotkey
is easiest) before any timeout could fire.

1. Each should stack, newest at the corner, older ones visible as a sliver
   behind it (`STACK_STEP_PX` is 26 px).
2. **The judgement:** does the 26 px step read as a legible deck, or does it
   look like noise / an accidental duplicate window? This is the number most
   likely to be wrong — it was chosen with no screen.
3. Let the stack drain on its own. Panels should settle oldest-first, in the
   order they appeared, with no visible queue or delay between them.
4. Click a panel that is NOT the newest (in the middle of the stack) to
   expand it. **It should grow in place, in the position it already
   occupied** — not jump to the bare corner. Try this on the OLDEST panel of
   a full 5-deep stack, since that is the position furthest from the corner
   and the one most likely to reveal a resize that grew the wrong way.

---

## §4 — the swipe and its resistance (rule 5, 7)

1. Swipe a panel toward its own corner, releasing short of the 90 px
   threshold. It should snap back to its resting position, and the click
   that follows should still expand it (a short swipe is still a click).
2. Swipe it the OTHER way (away from its corner) — the panel should not
   budge at all, however far the pointer travels. If it visibly slides even
   a little, that is a real bug (`swipeOffset` should return exactly 0).
3. Swipe it far enough to discard (past 90 px) and release. It should fly
   off toward the edge it was already leaning, fading as it goes.
4. **The judgement:** does the fade (opacity dropping as the panel
   approaches the threshold) make the 90 px point legible without a number
   on screen, or does it need something more explicit?

---

## What to write down

The ticket asks for a rules list, and it exists — `app/src/thumbnail.ts`'s
header, rules 1–10. If anything in §2, §3 or §4 is judged wrong, the fix is
to change the rule and the constant together, in that header, not to tune a
number and leave the prose describing the old behaviour. The next control in
the series (the take library) inherits whatever the scrubber's, the
selection overlay's, and this file's rules say.
