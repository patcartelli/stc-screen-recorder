# STC-338 — the scrubber, on a Mac

Written on Linux, so **every judgement about feel in this document is unmade.**
The rules are in `app/src/scrubber.ts`'s header and the arithmetic is tested;
what no test here can settle is whether the result feels like an editor's.
That is the ticket's own "Done means", and it is what this runbook is for.

Judge it on the **Music Network take** (STC-313) if it exists by then. If it
does not, any take over ~30 s will do for everything except §6 — the numbers
that are most likely to be wrong are the ones about a long track.

```
npm run app:start          # NOT via Playwright — see the TCC trap in CLAUDE.md
```

Open a take and leave the preview up. Everything below is in that window.

---

## §0 — before anything: is this the build you think it is?

`npm run app:start` rebuilds. If you have been running vitest, `app/dist/` may
hold whatever the last suite built. Confirm the scrubber is the new one:

* the clock reads **`0:00:00 / 0:04:59`** — three fields, not two
* the track has faint **tick marks** on it
* the playhead is a thin vertical bar, not a dot

Two fields in the clock means you are looking at the old build.

---

## §1 — snapping (rule 1). The one thing that is already proven

`scrubber.test.ts` proves the playhead cannot land between frames, and
`scrubber.e2e.test.ts` proves the control is parameterised in frames. So this
section is a **sanity check, not a test**: drag slowly and watch the clock's
last field. It should step through `…:00`, `…:01`, `…:02` and never show a
value that then corrects itself.

**What to look for that the tests cannot see:** whether the snap is
*perceptible* on a long take. At 10 minutes a frame is a fraction of a pixel,
so snapping is invisible and correct; at 5 seconds each frame is several
pixels and the playhead should visibly click from tick to tick. If the short
take feels like it is fighting you, the snap is right and the **track is too
short** — that is a layout question, not a snapping one.

---

## §2 — drag feel (rule 3). **The main thing to judge**

Drag the playhead fast, then let go.

* It must be **under the cursor the whole time** — no lag, no easing toward it.
* On release it must **stop dead**. No glide, no settle, no overshoot.

There is deliberately no momentum in the code. If it feels *dead* rather than
*direct*, that is a real finding and the fix is **not** to add inertia — a
preview that keeps moving after you let go is showing you a frame you did not
choose. Report it as "the drag feels dead" and the answer will be somewhere
else (the thumb's hit area, the track's height, the cursor).

**The thing most likely to be wrong:** the thumb is 3 px wide. That is right
for reading a position and possibly too thin to grab. `#scrub::-webkit-slider-thumb`
in `app/renderer/index.html` is the dial; grow the `:active` height first
before making the resting bar thicker.

---

## §3 — trim handles and the rubber band (rules 5 and 6)

Drag the **in** handle to the right until it meets the out handle.

* It should stop 2 frames short and **turn red and widen**, with the cursor
  visibly pulling away from it.
* Keep dragging: the handle keeps creeping, more and more slowly, and never
  gets more than **`RUBBER_BAND_PX` (24 px)** past its limit.
* Let go: it settles back onto the limit in about a tenth of a second.

**The judgement:** does the resistance read as *the app holding the handle*, or
as *the app being broken*? Those look similar and only an eye can tell them
apart. The two dials are `RUBBER_BAND_PX` (how far it gives) and the
`.handle.held` rule's `transform` / `background` (how loudly it says so).

**24 px is a guess made with no screen.** It is the number most likely to be
wrong in this ticket. Too small and nobody notices it; too large and the
handle looks detached from the pointer.

Also drag the in handle **off the left edge of the window**. It should go
`held` there too — that case was a real bug found by the tests, where clamping
the requested value first erased the fact that the pointer had left the track.

---

## §4 — the keyboard (rule 8)

All of this is covered by `scrubber.e2e.test.ts` under Xvfb, so it is
**verification, not discovery** — except the last item.

| press | expect |
|---|---|
| `←` / `→` | one frame; the clock's last field changes by one |
| `⇧←` / `⇧→` | ten frames |
| `L` | plays; `1x` appears beside the clock |
| `L` again | `2x`, then `4x`, then `8x` |
| `J` while running forward | **slows down** — 8x → 4x → 2x → 1x → stop → -1x |
| `K` | stops, wherever it is |
| `I` / `O` | in / out set at the playhead; `#triminfo` shows a range |
| `Home` / `End` | first / last frame |

**The one thing no automated test here reached:** reverse shuttle on a **4K**
take. `SeekingFrameSource` is built for a scrub — one in-flight request, latest
wins — so running backwards is repeated backward seeks, and on a long-GOP 4K
file each of those is a decode from the previous keyframe. Expect it to be
**choppy**, and the question is whether it is choppy enough to be useless. The
fixture it was tested against is 640×360.

If it is useless at 4K, the honest fix is not to make it smoother — it is to
cap reverse at a lower rung of the ladder and say so in `SHUTTLE_LADDER`.

**Also unwatched:** whether `J`/`K`/`L` collide with anything while a
**recording is live**. The preview is closed then, and the handler returns
early on a hidden `#player`, so it should be inert — but that is reasoning,
not watching.

---

## §5 — the readout (rule 10)

`M:SS:FF`, tabular figures, changing on every frame the canvas draws.

Nudge one frame at a time and watch that **the digits do not jitter
horizontally**. `font-variant-numeric: tabular-nums` is already on `#clock`;
if the width still moves, the `min-width: 132px` is too small for the take's
length (a take over 10 minutes has a wider minutes field).

---

## §6 — ticks (rule 9). **Needs a long take**

The tick stride comes from `tickStrideFrames`, which picks the finest stride
from a fixed ladder leaving ≥ 6 px between ticks, and draws **nothing** when
even the coarsest cannot.

1. On a 5 s take: ticks should be per-frame or near it, and readable.
2. On a several-minute take: ticks should be seconds or coarser.
3. **Resize the window narrower.** The ticks must coarsen, not crowd. This is
   wired to `window.resize` and is the part most likely to have been got wrong,
   because it was written against a fixed-width Xvfb display.
4. Make the window very narrow. At some point the ticks should **disappear
   entirely** rather than becoming a grey smear.

**The judgement:** at 6 px apart, do ticks read as a *scale* or as *noise*?
`MIN_TICK_PX` is the dial. There is a real chance the answer is 10 or 12.

---

## §7 — what was cut is dimmed, not fenced (rule 4)

Set an in and an out. The material outside should be **hatched and dim**, and
the playhead should still go there — drag it before the in point and confirm
the video still plays that material.

This is a deliberate choice (Premiere does the same) and it is worth a second
look on a real take: if the hatching is loud enough to be mistaken for the
video, lighten it. `.timeline .cut` in `app/renderer/index.html`.

---

## §8 — the regression surface

The scrubber's value changed meaning (per-mille → frames), so these are worth
one pass each even though CI covers them:

* **Export honours the trim** — set in/out with `I`/`O`, export, check the
  clip's length.
* **Copy frame / Save frame** still writes the frame the playhead is on. Both
  already snapped to the export grid; now the playhead is on it too, so they
  should agree exactly rather than nearly.
* **The viewer's eye toggle** (STC-318) — the clock and scrubber must not
  change when the render size does.

---

## What to write down

The ticket asks for a rules list, and it exists — `app/src/scrubber.ts`'s
header, rules 1–10. **If anything in §2, §3 or §6 is judged wrong, the fix is
to change the rule and the constant together**, in that header, not to tune a
number and leave the prose describing the old behaviour. The next control in
the series (the selection overlay's handles) inherits whatever that file says.
