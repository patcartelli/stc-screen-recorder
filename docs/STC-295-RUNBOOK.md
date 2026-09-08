# STC-295 runbook — annotation, arrow, box and text

**There is no annotation UI in this slice, deliberately.** What shipped is the
format (`shot-2`), the layout and the render pass — everything the ticket's four
acceptance criteria are actually about. Nothing in the app creates an
annotation yet, so the only way to see one is to author it by hand, which is
what §1 is for.

Three of the four criteria are settled automatically and one of them —
*"annotations composite correctly over transparent output modes, with no halo
where an arrow crosses the window edge"* — is settled by the still gate, which
renders in a real browser. So this runbook is shorter than its predecessors,
and what is left is genuinely a matter of taste: does the accent colour work on
a real screenshot, is the arrow head the right size, does markup at 4K look
like a pen or like a hairline.

## What shipped

* **`shot-2`** — `decoration.annotations`, an array of arrow / box / text.
  Coordinates are normalised to the CAPTURE, exactly like STC-297's redactions,
  so an annotation moves with the picture rather than with the canvas.
* **The version is the minimum that can express the document.** A shot with no
  annotations is still written as `shot-1`, so the helper needed no change and
  a still that was never marked up stays readable by an older build. Adding an
  annotation makes it v2; removing the last one takes it back to v1.
* **A render pass OVER the decorated still** — the opposite of redaction, which
  composites into the picture before the decoration and before the encode.
* **One accent colour** (`#e8452c`), three stroke weights and three text sizes,
  all in POINTS at the capture's scale, so a 1× and a 2× capture of the same
  window get markup of the same apparent size.

## What is deliberately not here

* **Any way to draw one.** Selection, move, resize, delete and undo/redo are
  the ticket's own wording — *"hooked into the editor's existing history"* — and
  there is no editor: STC-300 is gated (`docs/STC-300-FORMAT-AUDIT.md`). Which
  surface gets the tools is an open decision, and this slice deliberately does
  not settle it by default.
* Numbered step badges, callout shapes, freehand pen, emoji stamps — the
  ticket names all four as out of scope.

---

## 0. What is already settled without a Mac

| claim | where |
|---|---|
| A drag becomes an arrow / box / label, or nothing; direction, clamping, the LENGTH floor for arrows (a horizontal arrow has no height and is still an arrow) | `transform/test/still-annotate.test.ts` |
| The arrow's head sits at the tip, the shaft stops at its base, and the head never overruns its own tail on a short arrow | same |
| **Criterion 1** — annotations survive a write and a read unchanged, and writing again produces the same bytes | same |
| **Criterion 2** — more padding moves annotations WITH the content by exactly the content's own shift, not with the canvas | same |
| **Criterion 3** — one font constant, one render path, and nothing measures text | same |
| A malformed annotation is refused with the index and the field named, and the schema agrees | same |
| **Criterion 4** — an arrow over the window's transparent corner is the accent at every alpha, keeps a real antialiased edge, and has no halo | `npm run gate:still` |

```
npm test
npm run gate:still
```

**The halo assertion was mutation-tested**: adding a white outline stroke under
the arrow makes it fail with `a pixel on the arrow is 255,255,255 at alpha 255,
211 from the accent`. Do not "fix" a future failure there by widening the
tolerance — the tolerance is 24 and a real halo lands two hundred away.

## 1. Making one by hand

Take any still, then edit its `shot.json`:

```jsonc
{
  "version": 2,                    // ← required; v1 refuses a non-empty array
  // ...
  "decoration": {
    // ...
    "annotations": [
      { "kind": "arrow", "from": {"x": 0.1, "y": 0.1}, "to": {"x": 0.45, "y": 0.4}, "weight": "regular" },
      { "kind": "box", "shape": "rect", "rect": {"x": 0.5, "y": 0.2, "width": 0.3, "height": 0.2}, "weight": "regular" },
      { "kind": "text", "at": {"x": 0.1, "y": 0.8}, "text": "the thing", "size": "regular" }
    ]
  }
}
```

Then open the still from the library (STC-294's **Open**) — the panel renders
the stored document, so the markup appears in the preview and in anything you
Save or Copy. The library tile shows it too, once its cached thumbnail is
re-rendered (delete `thumb.png` beside the shot to force it).

`node scripts/decorate-one.mjs <take>` renders the same document in every mode
to files you can open side by side, which is the fastest way to judge the
questions below.

**If you forget `"version": 2` the loader refuses the document by name** —
"decoration.annotations needs version 2" — and the library reports the shot as
unreadable rather than showing it without its markup. That is the intended
behaviour, not a bug to route around.

## 2. The judgement calls

None of these have a right answer a test can hold; all of them decide whether
this feature is usable.

1. **The accent colour.** `#e8452c` on a real screenshot — a code editor, a
   settings pane, a photo. **Does it read as "added" or as part of the
   picture?** The dial is `ANNOTATION_ACCENT` in
   `transform/src/still-annotate.ts`, and it is one constant.
2. **The arrow head.** `ARROW_HEAD_LENGTH_RATIO` is 4.2× the stroke and
   `ARROW_HEAD_WIDTH_RATIO` 3.2×. Draw a long arrow and a short one on the same
   shot: **do they look like the same pen?** A head that grows with the arrow's
   length would not, which is why it is tied to the weight instead.
3. **Weights at 4K.** `regular` is 3.5 pt. On a Retina 4K capture that is 7 px.
   **Is that a marker or a hairline?** This is the number most likely to be
   wrong, because it was chosen without a 4K screen to look at.
4. **Text.** Sizes are 13 / 18 / 26 pt. Put a label next to something and
   **check it is legible at the size the shot will actually be viewed** — a
   case-study figure is usually seen at half size or less.
5. **Two-line labels.** `\n` in the text renders as two lines at
   `ANNOTATION_LINE_HEIGHT` (1.25). Does the spacing look deliberate?

## 3. Criterion 3 by eye

*"Text renders identically in preview and export — same font, same rasterisation
path."* Structurally this cannot fail: both go through one `renderStill` in one
renderer process with one font constant, and nothing measures text. What is
worth confirming once is that the FONT resolves to something sensible on the
Mac — `-apple-system` should give San Francisco.

1. Annotate a still with a text label.
2. Look at the panel's preview, then **Save** and open the file.
3. **Same typeface, same weight, same position?** If they differ, something has
   introduced a second rendering path, which is the thing STC-293's Note
   forbids and worth a ticket immediately.

## 4. What would make this wrong, and is worth looking for

* **Markup that moves relative to the picture when you change Style.** The
  annotations are normalised to the CAPTURE, so switching between
  `selected-area` and a padded window mode must move them WITH the picture.
  If they stay put relative to the canvas instead, `annotationLayouts` is being
  handed the wrong rect — the same failure mode the redaction runbook names.
* **An arrow that stops short of what it points at.** The shaft stops at the
  head's base by design (so the join is not a blob), but the HEAD's tip is
  `to`. If the tip looks short, the geometry is wrong rather than the taste.
* **A halo the gate did not catch.** The gate samples a cross-section through
  one arrow at one place. If you see a light or dark fringe along markup
  anywhere over a transparent mode, that is a real finding and the gate's
  sample needs to move — say where you saw it.
