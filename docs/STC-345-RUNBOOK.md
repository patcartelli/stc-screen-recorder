# STC-345 — the take library, on a Mac

Written on Linux, so every judgement about feel below is unmade. This is the
fourth and last study in the series (scrubber → selection overlay handles →
floating thumbnail motion → **take library**). STC-294 already built and
tested the library — one scan, a grid, delete with no orphans — so this study
wrote down the rules already decided (`app/src/library-items.ts`'s header,
rules 1–10) and found two real issues reviewing it: a duplicate-in-flight
race that could interleave two unrelated shots' files into one directory
(rule 9, fixed and mutation-tested), and a dead, byte-for-byte duplicate of
`cameraSummary` sitting in the wrong module (rule 10, deleted). Neither
changes anything you can see — everything STC-294's own runbook already asks
you to look at (the grid's LOOK, the 500-take scroll, whether a transparent
thumbnail reads as transparent) still applies unchanged; see
`docs/STC-294-RUNBOOK.md`. This file is only the one thing this study added.

```
npm run app:start
```

---

## §1 — the duplicate race (rule 9). The only new thing to judge

This cannot be triggered reliably by a single click — it needs two
`still:duplicate` calls to land close enough together to race, which is a
double-click or two different tiles duplicated within the same second.
`app/test/takes.test.ts` proves the race is closed at the source (two
concurrent duplicates of the same take, and of two different takes, never
share a destination or mix their files); what a Mac adds is the feel:

1. Take two different stills (or one, if that's what's on hand).
2. Click **Duplicate** on one tile, then **immediately** click Duplicate on
   a second tile (or double-click the same one) before the grid has had a
   chance to refresh.
3. **Both duplicates should appear as separate, complete tiles.** Open each
   — the picture and the decoration should match the take it was duplicated
   from, never a mix of the two.
4. **What would say the fix is wrong:** a duplicate whose picture doesn't
   match its own metadata (e.g. a window-shadow decoration on a
   selected-area shot), or a duplicate that silently overwrote another one
   (fewer new tiles than duplicates clicked).

Nothing here should feel different from before — the fix is invisible when
it works, which is the point. If double-clicking Duplicate now visibly
skips or delays a click while the first is still copying, that would be a
regression worth naming (it isn't supposed to — the fix is a name claim, not
a lock on the button), but is not something this pass tested.

---

## What to write down

The ticket asks for a rules list, and it exists — `app/src/library-items.ts`'s
header, rules 1–10. If §1 above ever needs a real UI lock (disabling
Duplicate while one is in flight, say), the fix is to change the rule and the
mechanism together, in that header, not to bolt a debounce onto the button
and leave the header describing the old behaviour.

This is the last study in the series. The scrubber's, the selection
overlay's, the thumbnail's and this file's rules together are the vocabulary
the eventual still/recording editor inherits, rather than a fifth one it
invents.
