# STC-300 format audit — does `shot.json` already hold what an editor would expose?

STC-300 (still editor) gates itself, and deliberately:

> Build this only when the panel gives out. … Until at least two of those are
> real annoyances, the panel wins on every axis.

It is still gated. Nothing here proposes building it. What this document does is
discharge the ticket's **Constraints** clause, which is the one part that is
worth doing *before* the signal arrives rather than after:

> Every parameter it exposes must already exist in `shot.json` from the slice.
> If building this requires adding fields to the format, the slice
> under-specified the format and that is the real bug.

That clause is a bug report waiting to be written, and the cheapest time to find
out whether it fires is now — while STC-289/291/293/296/297 are fresh and the
people who chose those fields can still say why. Audited against
`schema/shot-1.schema.json`, `transform/src/shot.ts`, `transform/src/
still-decorate.ts` and `transform/src/still-render.ts` at `fa67aff`.

**Verdict: the format holds for six of the seven inspector items. Two things
fall out — one real gap (re-crop) and one item in the ticket that appears to be
wrong rather than missing (corner radius).** Neither is urgent, because neither
is reachable until the editor exists; both are cheaper to fix now than after a
second consumer of `shot-1` ships.

---

## The scorecard

The ticket's inspector list, item by item.

| inspector item | field | verdict |
|---|---|---|
| padding | `decoration.paddingPct` | **present** — with a caveat about what a slider would mean, §1 |
| corner radius | *none* | **the ticket is wrong, not the format**, §2 |
| shadow parameters | `decoration.shadow` | **present** — five of six parameters, §3 |
| background fill | `decoration.background` | **present in the format, unwired in the code**, §4 |
| output canvas | `decoration.canvas` | **present** as a four-value enum, §5 |
| cursor toggle | `decoration.cursor` | **present**, §6 |
| crop / re-frame | `shot.crop` | **the real gap**, §7 |
| undo/redo over the decoration model | n/a | **needs no field**, §8 |

---

## 1. Padding — present, but a slider would lie

`decoration.paddingPct` is a fraction of the capture's **short edge**, not a
pixel count, which is what makes a 1× and a 2× capture of the same window render
the same. That is right and an editor can write to it directly.

The catch is in `paddingPixels()`:

```ts
return Math.round(Math.max(requested, shadowReachPixels(shadow)));
```

Padding is a **floor**, not a value. STC-291's gate found that a percentage of a
small capture can be narrower than a shadow expressed in points, and the shadow
then clips against the canvas edge as a hard grey band. So the layout takes
whichever is larger.

An inspector padding slider therefore does nothing at all below the shadow's
reach — drag it and the picture does not move. That is **not a format gap**: the
document says what was asked for and the renderer says what is safe, which is the
correct division. It is a UI honesty problem, and the answer when the editor is
built is to show the effective padding next to the requested one (or to disable
the lower part of the range while a shadow is on), not to remove the floor. The
comment on `shadowReachPixels` already says which dial to turn instead: the
shadow.

## 2. Corner radius — the item is wrong, not the format

There is no corner-radius field anywhere in `shot-1`, and there should not be
one. This is the audit's one disagreement with the ticket.

A window capture arrives **with its real rounded corners, as alpha**, because
the helper captures through `desktopIndependentWindow` (STC-289). Nothing in
the still path synthesises a shape, and the shadow is cast from that same alpha
rather than from a rounded rectangle the code guessed at.
`still-decorate.ts`'s header states it as a design rule:

> re-deriving a radius would throw away the fidelity it was built for.

The other mode is `selected-area`, documented in the schema as *"raw crop, no
corners, shadow or padding"* — a rectangle of the display, which has no corners
to describe.

So a radius control would either (a) do nothing, on the modes whose corners are
real, or (b) mask the capture to a radius someone chose, which on a window shot
would *destroy* the true corner it was captured for and on a display crop would
invent a shape the screen never had. Both are worse than the current answer.

**Recommendation: strike "corner radius" from STC-300's inspector list**, with
this reasoning attached, rather than adding the field. If a rounded display crop
turns out to be wanted for its own sake — a decoration, not a fidelity claim —
that is a new decoration parameter with a new name, and it should not be
confused with the window's own corners.

## 3. Shadow — five of six parameters

`decoration.shadow` carries `offsetX`, `offsetY`, `blur`, `spread` and
`opacity`, all required, all real, all consumed by `layoutStill` and scaled into
output pixels by `pxPerPoint`. `spread` has no Canvas 2D equivalent and is
implemented by scaling the shadow-casting silhouette, which is a render concern
and correctly not visible in the document.

**What is missing is shadow COLOUR.** `still-render.ts` hardcodes it:

```ts
ctx.shadowColor = `rgba(0, 0, 0, ${s.opacity})`;
```

so the document can say how dark the shadow is but not what hue it is. Whether
that counts as a gap depends on what "shadow parameters" is taken to mean. A
tinted shadow — picking up a background's colour instead of neutral grey — is a
normal thing for a product-shot tool to offer and is exactly the sort of dial
someone reaches for once presets stop being enough.

It is an **additive, low-cost** change if wanted: one optional `color` on
`decoration.shadow`, defaulting to black, with `opacity` continuing to mean
what it means. Not proposed now — nothing has asked for it, and §9's cost note
applies.

## 4. Background — the format is complete and the code is not

`decoration.background` has `kind` (`solid` | `linear` | `radial` | `image` |
`wallpaper`), `colors`, `angleDeg` and `file`. For the three procedural kinds
that is everything an inspector needs, and `still-render.ts` draws all three.

`image` and `wallpaper` are a different matter, and the gap is in the **wiring,
not the format**. `paintBackground` takes the picture from
`StillSources.background`, and **nothing in the app ever supplies it** — no
caller in `app/src/`, `harness/` or `scripts/` sets that field. Both kinds
therefore fall back to the first colour:

```ts
// No image supplied — for `wallpaper` that is the normal state today,
// since nothing sources the desktop picture yet (STC-291, not built).
```

The fallback is right (a mode that promises a background must produce one) and
it is honest in its comment, but an inspector offering "background: image" today
would present a control that silently does nothing.

Two things to note when the editor is built:

* `background.file` is documented as **"a file beside this document"**, so an
  editor accepting an arbitrary image must **copy it into the take directory**
  and store the basename. A path to somewhere in the user's home would make the
  shot un-portable, which contradicts the schema's own framing that the
  document plus its neighbours *are* the still.
* Loading that file and handing it to `paintBackground` is unbuilt work, not a
  format change.

## 5. Output canvas — an enum, and that is a decision to revisit

`decoration.canvas` is `natural | 16:9 | 4:3 | 1:1`. An inspector exposing those
four as radio buttons is fully served.

An inspector exposing an **arbitrary** output size or ratio is not, and would
need a format change. Worth stating plainly so the choice is deliberate when it
arrives: the enum is not an oversight, it goes with `canvasSize()`'s rule that a
preset **only ever grows** —

> a 16:9 preset that shaved the top off a window would be a decoration silently
> destroying the thing being decorated

— and an arbitrary target size makes that rule harder to keep (an arbitrary
ratio can only be met by growing, so any *smaller* target has to either scale
the capture, which the still path refuses everywhere, or crop it, which is the
thing the rule forbids). If arbitrary canvases are wanted, the question to
settle first is what a too-small target means, not what the field is called.

## 6. Cursor toggle — present

`decoration.cursor` is a boolean and `shot.cursor` carries the sampled position
and shape. `layoutStill` draws it only when both are there.

One behaviour an editor's UI has to account for: `cursorLayout()` returns
`undefined` when the pointer was **outside the captured area**, which is not an
error — the schema says the block is absent (not zeroed) when the pointer was on
another display, and a pointer beside the captured window is the same case. So
the toggle can legitimately be on and draw nothing, and the inspector should say
"no pointer was captured" rather than leaving a checkbox that appears broken.
No format change: `shot.cursor` being absent already carries that fact.

## 7. Re-crop — the real gap

This is the one that fires the Constraints clause.

**`shot.crop` is not a render-time parameter.** It is a record of which region of
the display was captured, and `frame.png` already holds only those pixels
(`helper/src/Still.swift` sets `cfg.sourceRect = region.cgRect` at capture, so
the crop is applied by ScreenCaptureKit and never again). In the transform,
`shot.crop` is read in exactly two places:

* `cursorLayout()` — to move the pointer from display-local points into the
  crop's frame;
* `pxPerPointOf()` — `shot.frame.width / shot.crop.width`, the scale that turns
  the document's points into output pixels, which `still-export.ts`'s
  `scaleFactor` then depends on for what a 1× export means.

`layoutStill` sizes the content from `shot.frame.width/height` and never from
`crop`. So **editing `crop` does not re-crop the picture** — it moves the cursor
and changes the pointer's and the shadow's scale, and at a 1× export it changes
the output resolution. An editor that wrote a tighter `crop` expecting a tighter
picture would get a correctly-rendered wrong answer, which is the worst kind.

There is also a hard capture-side limit worth stating separately, because it
survives any format fix: **a re-crop can only ever shrink.** The pixels outside
the original region were never captured. "Re-frame a shot after the fact,
including changing a region shot's bounds" is achievable only inward. Widening
means re-capturing, and the display has moved on.

**Recommendation when STC-300 is built:** add a *decoration-side* crop —
normalised (0..1) over the frame, exactly like `decoration.redactions` already
is, living in `decoration` rather than at the top level. That keeps `crop`
meaning what it means (provenance: which region of which display the pixels came
from, and the scale that follows from it), makes the new field mean the one
thing an editor needs (which part of the captured pixels to show), and inherits
redactions' own property for free — a normalised rectangle **moves with the
content**, so a redaction placed before a re-crop stays over the thing it
covers. It also composes with the "nothing is ever resampled" rule, since a crop
removes pixels rather than scaling them.

It is additive and small. It is *not* proposed now: nothing can write it, and a
field no producer writes and no consumer reads is a claim the tests cannot
check.

## 8. Undo/redo — needs nothing

`decoration` is a plain, wholly serialisable value, and `decorationForMode()`
already builds one from a mode plus overrides. A history stack is therefore a
list of `Decoration` values in the editor's own memory, and undo is assignment.
Nothing about it belongs in the document — persisting a *history* would make the
shot's format carry the editor's session state, which is a different artefact.

The adjacent thing that *is* missing is a **write path**, not a field. Today
the only way anything reaches a stored `shot.json` after capture is
`still:writeShot`, which deliberately accepts **regions and never a document**
so a renderer cannot rewrite a shot's display, crop, frame filename or capture
time. An editor needs to persist the whole `decoration` block, which means a
second guarded handler with the same shape of defence (re-read stored, replace
only `decoration`, re-validate through `parseShot`, write). That is
implementation work for STC-300 and does not touch the format.

## 9. The cost of adding a field, which is why this was worth checking early

`parseShot`'s `noExtra()` **throws** on any field it does not know:

```
${what} has a field this version does not know: ${k}
```

That is the right strictness — it is what makes `parseShot` refuse rather than
default — but it means the format is closed in both directions. A document
carrying a field added later is rejected outright by an older parser, so any
addition is a `shot-2` decision rather than a free extension, and every consumer
moves together.

Right now there is exactly one producer (the helper) and a short list of
consumers, all in this repo. That is the cheapest this will ever be. Once
STC-294 puts stills in the take library and STC-295 adds annotation, a format
change costs more.

---

## The other open question, now that the code has been read

The ticket's **Open** section asks: own window, or a mode of the existing take
editor — *"Decide when the code is in front of you, not now."* The code is in
front of us, so:

**Own window.** Three reasons from the code rather than from taste:

1. **The still path already has its own everything.** `shot.json` is its own
   schema, `still-decorate.ts` + `still-render.ts` are its own transform,
   `still-export.ts` is its own export funnel, and `thumbnail-window.ts` is its
   own window with its own narrow preload. There is no shared surface a mode
   would reuse — it would import the still modules exactly as a separate window
   would, and additionally inherit the take editor's chrome, which is built
   around a timeline a still does not have. The ticket's own hunch (*"a still
   editor with no timeline shares less with the video editor than it first
   appears"*) is confirmed by the module boundaries.

2. **This app is menu-bar-first now (STC-292).** The Dock icon comes and goes
   with windows, `still:capture` is a main-process function with three doors,
   and the still path is already reachable with no main window open at all. A
   still editor as a *mode* of the take editor would require the take editor to
   exist to edit a still, which inverts that.

3. **The conditional-leakage risk the ticket names is real and one-directional.**
   The still and video paths share `render()`'s discipline but no code; a mode
   would put `if (isStill)` into a window whose whole job is a timeline. Nothing
   in the current split has that shape, and adding it would be the first.

The cost the ticket names — duplicated chrome — is small here and already paid
twice (the overlay and the thumbnail panel are both their own windows with their
own preloads, on purpose).

---

## What would change this document's mind

Per the ticket's own gate, the signal to build is two of: wanting a padding value
the presets don't offer, wanting to nudge a redaction rectangle, wanting to
re-crop a shot taken last week. If that arrives, the work this audit says is
needed *before* the inspector can be honest is:

1. A normalised `decoration.crop` (§7), which is the only real format gap.
2. A guarded write path for the whole `decoration` block (§8).
3. Sourcing and loading a background image (§4), if `image`/`wallpaper` are to
   be offered at all.
4. Striking corner radius from the scope (§2).

Everything else on the inspector list is already in the document and already
consumed by the renderer.
