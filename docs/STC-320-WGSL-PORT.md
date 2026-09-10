# STC-320 — Lab study two: frame difference, WGSL port

**The port is written, published and cross-checked. The WGSL leg has never
run on a GPU, because this environment has none. That is the one thing left,
and it is stated here rather than implied by a green tick.**

Companion to `docs/STC-319-frame-diff-study.md`. The code lives in
`patcartelli/studio-cartelli` (PR #524, branch
`accounts/stc-320-lab-study-frame-difference-wgsl-port`), published unlisted
at `/lab/frame-diff-wgsl` beside study one.

## Why this matters to THIS repo

STC-320 is not really a lab exercise. The recorder's compositor is locked to
WGSL, STC-322 (the change-track spike that writes `changes.json`) lifts this
kernel directly, and auto-zoom stage 2 keys off the signal it produces. So
the notes below are the first entry in this repo's WGSL vocabulary, and the
finding in the next section changes what stage 2 can be built on.

## The finding: study one's number was an estimator, not a total

Study one computes its per-frame scalar by rendering the diff into a 64×36
framebuffer and reading it back. With `NEAREST` filtering each of those 2304
texels is a **point sample of exactly one source pixel** — it is not an
average over a tile. On a 640×360 clip that reads **one pixel in a hundred**.

A text caret is two pixels wide. Measured over the ten horizontal positions
that cover one period of the sampling lattice:

| | registers a blinking caret | changed pixels reported |
|---|---|---|
| study one, point sample | **2 of 10 positions** | 0, or 200 when it hits |
| study two, reduction | 10 of 10 | 32, at every position |

Which two positions is a property of the lattice, not of the recording.

This is not a rounding quibble, and it is worth being blunt about why:
STC-319's own framing names the blinking caret as the canonical change that
*matters* ("the text field with the blinking caret *is*" where the viewer
should be looking). It is the case that justifies keying auto-zoom off frame
difference instead of the cursor at all. **On the signal the rules list is
most about, the measurement it was going to be read off was structurally
unable to see it 80% of the time.** Any rule written from study one's plot
would have been fitted to a signal with a hole exactly where the interesting
case lives.

The reduction has no such hole: one workgroup per grid cell, every pixel of
that cell's tile visited exactly once, an atomic counter per cell. Same 32
pixels wherever the caret sits.

## What changed in the port

1. **The grid became a reduction rather than a raster.** This is the whole
   port; everything else is bookkeeping. The two therefore produce
   *different numbers by design*, and the cross-check holds each to the model
   it actually implements rather than pretending they should match.
2. **`textureLoad`, not `textureSample`.** A sampler brings filtering and
   wrap modes with it and a reduction wants exact texel fetches. It also
   removes study one's `UNPACK_FLIP_Y_WEBGL` from the compute path entirely
   — the flip survives only in the eye-view pass, which really is a raster.
3. **Acquisition is async, so the constructor had to go.**
   `getContext('webgl2')` returns synchronously; `requestAdapter` /
   `requestDevice` are promises, and readback is `mapAsync` against study
   one's synchronous `readPixels`. Two API shape changes, both forced by the
   platform. Anything in this repo that swaps a GL renderer for a WGSL one
   inherits both.
4. **Errors arrive on a side channel.** A GLSL compile failure is one
   synchronous call away at the point of the mistake. WGSL validation
   surfaces through `popErrorScope`, asynchronously, and an unhandled one is
   a blank canvas that reads as a rendering bug. `create()` wraps module
   creation in an error scope and refuses rather than returning a half-built
   renderer — the same instinct as this repo's "every wait needs a bound and
   a reason".
5. **Float width turned out to be part of the rule.** See below.

## Two things found by measurement, kept as notes

**The reference was more precise than the thing it modelled.** The shared
rule was first written in float64 while both shaders run in float32. A
fixture engineered to sit exactly on the threshold lands 5.6e−17 *below* it
in float64 and exactly *on* it in float32 — because the Rec.601 weights sum
to `0.99999999999999989` rather than 1. So the reference disagreed with both
shaders over arithmetic rather than over the rule, and the harness would have
reported a port bug that existed only in its own precision. The reference
rounds to float32 now (`Math.fround`). Same family as this repo's
rasterization-backend trap: an oracle that does not share the subject's
numeric environment is not a stricter check, it is a different one.

**Exact-boundary behaviour cannot be pinned portably, so it is not claimed.**
Flipping the rule's `>=` to `>` passes every fixture in the suite, and no
portable fixture could catch it — the only fixture that separates the two
operators is one sitting exactly on the threshold, which is precisely the one
that disagrees for float-width reasons. Inverting the comparison outright
(`<`) *is* caught, by four fixtures at once. So `>=` is a documented
convention between the three ports rather than a checked one, said out loud
instead of left as an implied guarantee.

## How it is verified, and what is not

The rule lives in **one place** (`src/lib/frame-diff-rule.ts` over there,
plain TypeScript, no GPU) and both shaders are ports of *that* rather than of
each other, so a disagreement names a culprit. Fixtures with closed-form
answers check the reference itself, so three ports of one mistake cannot
certify each other.

| leg | status |
|---|---|
| reference (TypeScript) | **runs everywhere**, on every build, no hardware — `npm run check:frame-diff`, wired into `build` |
| GLSL / WebGL2 (study one) | **passed**, on SwiftShader in this container |
| WGSL / WebGPU (study two) | **NOT RUN — no WebGPU adapter here** |

Mutation-tested rather than assumed. Caught: an inverted comparison, a tile
overlap, a comparator that cannot fail, both luma-weight transpositions, and
— for the GLSL leg specifically — shifting the sampling lattice off texel
centres, which fails it on the caret fixture. That last one is what
establishes the GLSL leg is a real check and not a vacuous pass.

The WGSL test **skips loudly to stderr** (never `console.warn`, which vitest
and Playwright both discard from a skipped test — this repo has paid for that
one already) and the published page names every implementation that did not
run, so neither a green suite nor the page can be misread as complete.

## What a machine with WebGPU needs to do

One thing, and it is short:

```
cd studio-cartelli
npx playwright test tests/frame-diff-wgsl.spec.ts
```

The WGSL leg must go from skipped to passed. It asserts the frame-wide
fraction against the reference reduction **and** compares all 2304 grid cells
one by one — the total can agree while the grid is wrong, since a transposed
tile index moves change between cells without changing the sum, and the grid
is what STC-320's done-condition actually names.

Loading `/lab/frame-diff-wgsl` in any WebGPU browser does the same thing
visibly: the cross-check table fills its WGSL column and the verdict line
stops saying anything is unverified.

Two things that will still fail on a Mac and are **not** this ticket's:
the live-footage panel needs the real fixtures STC-319 is waiting on, and the
rules list — which change is *the* change — remains unwritten and still needs
30–60s of real footage that does not exist yet.

## Environment notes worth keeping

Measured here, not inferred, and useful next time something needs a GPU:

- **This container has no WebGPU.** `navigator.gpu` is absent under a bare
  Chromium launch with `--enable-unsafe-webgpu`, Vulkan features and
  swiftshader, headless and headed under Xvfb alike. Under Playwright's own
  launch flags `navigator.gpu` *is* present but `requestAdapter()` returns
  null — a different failure, which is why the support check distinguishes
  three cases rather than reporting one "unavailable".
- **WebGL2 DOES work here**, via ANGLE on SwiftShader. That is what let the
  GLSL leg be verified locally, and it is worth remembering: this repo's
  `gate*` family is blocked on **H.264 decoding**, not on WebGL, so a check
  that builds its own frames in-page can run here even though the gates
  cannot.
