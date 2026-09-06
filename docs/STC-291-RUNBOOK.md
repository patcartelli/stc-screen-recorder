# STC-291 — the decorated still: what to look at on the Mac

The whole ticket is a question of taste wearing correctness clothes. What can be
checked without a screen is checked: `transform/test/still-decorate.test.ts` runs
the layout arithmetic, `transform/test/still-render.test.ts` asserts the draw-op
sequence through the canvas recorder, and `npm run gate:still` renders in a real
browser and asserts properties of the resulting pixels. **None of that says the
presets look good**, which is the only thing the ticket actually asks for.

## The decisions taken, and why

| question | decision |
|---|---|
| the ticket asks for golden-image comparison | **refused, deliberately.** Gradients, blurred shadows and antialiased curves are Skia's output, and CLAUDE.md already records that this project's pre-encode hashes differ between rasterisation backends for far simpler drawing. A golden would be a stored constant across engines this codebase does not control, going red on a Chromium bump rather than on a regression. The gate asserts PROPERTIES instead — alpha is zero outside the window's real shape, the corner fringe is not dark, the shadow decreases to zero, a background has no holes — plus determinism between two renders inside one browser |
| rounding the window's corners | **nothing is rounded.** A window capture arrives with its real corners as alpha (`desktopIndependentWindow`, STC-289) and the shadow is cast from that same alpha. Re-deriving a radius would throw away the fidelity window mode exists for |
| scaling the capture to fit a canvas preset | **never.** Presets only GROW the canvas around the capture; the frame is drawn at its natural pixel size. Resampling a premultiplied image with a hard alpha edge is how a dark fringe appears at a corner, and not resampling is the cheapest way not to have one |
| padding units | a fraction of the capture's short edge, so a 1x and a 2x capture of the same window look the same — with a floor at the shadow's reach (see the trap below) |
| where the values live | `shot.json`. The presets are what a fresh capture GETS, not a ceiling: an explicit value in the document always wins, so a hand-edited shadow renders as written and the still editor (STC-300) has somewhere to write |

## 0. Build and run what runs anywhere

```
npm run typecheck
npm test
npm run gate:still       # needs a browser; bundled Chromium is fine, no H.264
```

The gate is the one in this repo that decodes no video, so it has no
`VideoDecoder.configure()` to wedge on and nothing for STC-259 to skip on.

## 1. The presets — the part only a person can judge

```
node scripts/decorate-one.mjs <shotDir>
```

`<shotDir>` is any folder `capture-still` wrote — `shot.json` plus its frame.
It renders every mode the shot can wear, beside the shot, as
`decorated-<mode>.png`. It takes every parameter except the mode from the
document, which is the lesson from `scripts/export-one.mjs` hardcoding a project
with no PiP and producing a clip that "proved" the PiP was broken.

Capture a **real** window — a browser, an editor, something with a title bar and
a shadow of its own — and then look:

- **`window-only`.** The corners are transparent, and the corner curve is clean.
  Open it over a dark background (Preview's dark mode, or drop it into a dark
  Keynote slide). A grey or black fringe on the curve is the premultiplied-alpha
  failure, and it is the single most likely thing to be wrong.
- **`window-shadow`.** The shadow reads as a shadow, not as a grey rectangle. It
  must fall to nothing well before the canvas edge — a hard band at the edge is
  the padding-vs-shadow-reach bug (fixed, but it is what to look for).
- **`window-shadow-background`.** The judgement call. Does this look like
  something you would put in a README or a landing page? The gradient is a quiet
  neutral on purpose; if it wants to be warmer, bluer, or plainly a solid, that
  is `PRESET_BACKGROUND` in `transform/src/still-decorate.ts`.
- **`selected-area`.** Byte-for-byte the capture. If it differs from `frame.png`
  at all, something in the pass-through path is resampling.

**If the padding looks too generous, turn down the SHADOW, not the padding** —
the padding has a correctness floor at the shadow's reach and will simply
refuse to go below it.

## 2. What the gate cannot see, and neither can Linux

- **The real capture's alpha.** Every gate assertion runs against a rounded
  rectangle synthesised in the page, because the gate has to know exactly where
  the shape ends. Whether a real `SCScreenshotManager` window capture carries the
  alpha this all assumes is STC-289's runbook question, and it is upstream of
  every mode here except `selected-area`.
- **Colour.** The renders are sRGB and this says nothing about a P3 display or an
  HDR one. Deferred with the rest of the HDR/EDR question.
- **A wallpaper background.** `background.kind: "wallpaper"` parses and falls back
  to a colour; nothing sources the desktop picture yet.

## 3. If something is wrong

The layout and the drawing are separate files on purpose. A wrong SIZE or
POSITION is `still-decorate.ts` and is reproducible on any machine with node —
add the case to `transform/test/still-decorate.test.ts`. A wrong PIXEL is
`still-render.ts` and needs the browser; `npm run gate:still` prints every
probe it took, and `harness/still.ts` is where a new probe goes.
