# STC-297 runbook — redaction, solid fill over anything private

Written on Linux. The arithmetic and the irreversibility are both checked
automatically and on every push — what is left here is the part that is a
judgement (does a fill read as deliberate?) and the part that needs a
pasteboard (does a redacted copy paste redacted?).

## What shipped

* **Redact** in the post-capture panel (STC-296) is live. Clicking it grows the
  panel to 520×420 — big enough to place a box over a line of text rather than
  over a fifth of the screenshot — and turns the preview into a drag surface.
* Drag a rectangle to cover something; multiple boxes per shot; **Undo** takes
  back the last one; **Done** or Escape leaves redact mode.
* The fill colour follows the content UNDER each box: near-black (`#0b0b0c`) on
  light content, near-white (`#f2f2f3`) on dark. Per region, not per capture —
  a dark terminal inside a light page gets the near-white box while the page
  around it gets the near-black.
* Regions are stored in `shot.json` as normalised (0..1) rectangles, written on
  every change, so they survive the panel and the app.
* The fill composites over the capture and under nothing — no shadow, no
  background, no gradient can soften it — at alpha 1, always.

## What is deliberately not here

* **Blur and pixelate.** v1 is solid fill only, and that is a security decision
  rather than an unfinished one: blur and pixelate both LOOK safe while being
  recoverable, and proving a given radius safe needs an adversarial test that
  the ticket defers along with the feature.
* **Re-opening an old shot to adjust its boxes.** The regions are on disk and
  the panel reads them, but the only thing that opens a shot in v1 is the
  post-capture panel itself. Adjusting yesterday's shot needs a surface to
  reach it from — STC-294, screenshots in the take library.
* **Drag-out.** The ticket's clipboard criterion mentions "and in the drag-out
  file"; drag-out itself is still deferred from STC-296, so there is nothing to
  check there yet. When it lands it inherits the composite, which is where the
  fill already is.

---

## 0. What is already settled without a Mac

Do not re-litigate these by hand.

| claim | where |
|---|---|
| Light/dark choice, the threshold, alpha weighting, the transparent-corner case | `transform/test/still-redact.test.ts` |
| A drag becomes a normalised rect; reversed drags match; off-edge drags clamp; a click is not a region | same |
| Every region it produces is one `parseShot` accepts | same |
| The fill is drawn over the capture, after it, with nothing after that could soften it | `transform/test/still-render.test.ts` |
| Each region takes its own colour, in order; a missing colour still fills; the pass forces `globalAlpha = 1` | same |
| **An exported PNG's covered pixels are EXACTLY the fill, and the covered colour appears nowhere in the file** | `helper/test/still-encode.test.ts` — decodes the encoded PNG (inflate + unfilter) rather than looking at it. Runs on CI, no grant needed. |
| A real drag becomes a region, Undo is last-in-first-out, and the regions reach `shot.json` on disk | `app/test/redaction.e2e.test.ts` |

## 1. Does the fill read as deliberate?

This is the one the ticket cares about and no test can answer: a box that reads
as a rendering failure defeats the point, because the person receiving it
cannot tell "hidden on purpose" from "broken".

1. Capture something LIGHT — a document, a settings pane. Redact a line.
   **The box should be near-black and should look like ink, not like a hole.**
2. Capture something DARK — a terminal, a dark-mode editor. Redact a line.
   **The box should be near-white.** A near-black box on a dark terminal is the
   failure mode this rule exists to avoid: it reads as a rendering artefact,
   and worse, it is hard to see that anything was hidden at all.
3. Capture something MIXED — a light page with a dark terminal panel in it.
   Redact one box on each. **They should differ**: this is the per-region rule
   doing its job, and it is the case that would have looked wrong under a
   single per-capture decision.
4. **A judgement call worth reporting either way:** do two differently-coloured
   boxes on one shot look considered, or do they look inconsistent? If the
   answer is "inconsistent", the dial is `fillForLuminance` in
   `transform/src/still-redact.ts` — going per-capture is a small change, and
   the reasoning for per-region is in this ticket's thread rather than in
   anything load-bearing.

## 2. Is the drag precise enough?

The panel grows to 520×420 for redact mode. On a 4K or 6K capture the preview
is still a long way from 1:1.

1. Capture a full display at native resolution.
2. Redact, and try to cover **exactly one line of text** — an email address in
   a signature, a token in a terminal.
3. **Can you do it in one attempt?** Undo exists for when you cannot, but
   needing it every time is the finding. If it is too coarse, the size is
   `REDACT_SIZE` in `app/src/thumbnail-window.ts` and the box the canvas is fit
   into is `REDACT_BOX` in `app/src/thumbnail-renderer.ts` — they are a pair,
   and the window has to be the larger of the two.
4. Check the box lands where you drew it — draw one over something
   recognisable, then Save and open the file. **The fill should be over the
   thing you covered**, not offset. An offset here would mean the
   view→capture mapping is wrong for this shot's padding or scale, which is
   exactly what a mode with padding (`window-shadow-background`) would expose:
   try it in that mode too.

## 3. The panel's own behaviour

1. Redact, then **Done**. The panel returns to its compact size, still in the
   same corner, boxes still visible in the preview.
2. Redact with the panel in each of the four corners (Still capture → Panel
   corner). **It should grow into the screen, never off it** — a bottom-right
   panel that grew by moving its origin would walk off the display.
3. Press **Escape** while in redact mode. It should leave redact mode and
   nothing else — NOT close the panel and export. (Escape from the expanded
   panel, not redacting, still settles it as before.)

## 4. The clipboard criterion

The ticket: *"A redacted shot copied to the clipboard is redacted in every
pasteboard representation."*

1. Redact something, then **Copy**.
2. Paste into **Preview** (PNG), **Mail** (TIFF), and **Finder** (the file
   URL). All three are different pasteboard representations of the same copy.
3. **All three must show the fill.** They come from one composite through one
   encoder, so a difference between them would be an encoder bug rather than a
   redaction one — but this is the check that would find it.

## 5. Survives a restart

1. Redact a shot. Note its take directory.
2. `cat <take>/shot.json` — `decoration.redactions` should hold your boxes as
   normalised numbers.
3. Quit the app and relaunch. The document still carries them (nothing in v1
   re-opens the shot to show you, which is §"deliberately not here" — the point
   of this step is that the DATA survived, ready for STC-294).

## 6. What would make this wrong, and is worth looking for

* A box that is very slightly translucent — the covered thing faintly visible
  when you zoom in. That would mean something reintroduced alpha into the fill
  pass; `still-render.ts` forces `globalAlpha = 1` and a test pins it, but an
  eye on a real export is the last check.
* A box that moves relative to the content when you change Style in the panel.
  The regions are normalised to the CAPTURE, so switching between
  `selected-area` and a padded window mode must move the box WITH the picture.
  If it stays put relative to the canvas instead, `redactionToPixels` is being
  handed the wrong rect.
