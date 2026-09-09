# STC-319 — Lab study: frame difference (GLSL)

**The rules list this ticket exists to produce is not written. This document
says why, and what session two needs.**

STC-319 is a sketchbook study, not a feature: find out what a frame-to-frame
change signal actually looks like on real recorder footage, and write down
the rules for which change is *the* change (auto-zoom stage 2's real input).
"Done when the rules are written, not when it is beautiful" is the ticket's
own bound. This session built everything up to the point of watching real
footage and could not get past that point — twice, for two independent
reasons, both recorded below rather than papered over.

## What is built

Published (unlisted, `noindex`) at `/lab/frame-diff` in
`patcartelli/studio-cartelli`, on branch `claude/loving-shannon-4j3s6a` there:

- A WebGL2/GLSL2 fragment shader (`src/lib/frame-diff-gl.ts`) that takes two
  consecutive decoded frames as textures and outputs a luma-difference mask,
  thresholded, drawn live over the canvas. A second draw path renders the
  same diff to a small (64×36) offscreen framebuffer and reads it back as one
  scalar per frame — the changed-pixel fraction — cheap enough to compute for
  every frame of a short clip and plot as a sparkline under the video.
- A loader (`src/lib/session/`) vendored from this repo's
  `transform/src/{session,demux,decode,timeout,decoder-preference}.ts`,
  per the ticket's own instruction to try `session.ts` +
  `seeking-frame-source.ts` before writing a second one — `decodeAll` from
  `decode.ts` turned out to be the better fit than the seeking source, since
  the study wants every frame in order rather than random access. Vendored
  rather than imported because the two repos are separate GitHub repos with
  no package published between them; each vendored file says so and names
  the upstream original to re-sync by hand if it changes.
- `/lab/frame-diff`'s own page renders the plot with event ticks (clicks in
  red, cursor-shape changes in blue) from the take's `events.json`, so a
  session with real footage can watch the mask and the plot side by side
  against what a viewer actually did.

`npx astro check` is clean on all of it (0 errors), `npm run check:demos`
is unaffected, and the page serves and fetches its assets correctly under a
real dev server. That is as far as this environment could verify.

## Why the rules are not written

**Two separate, stacked blockers, not one:**

1. **This sandbox cannot decode H.264 at all.** The bundled Chromium here
   throws `NotSupportedError: H.264 decoding is not supported` on
   `VideoDecoder.configure()` — the exact failure this repo's own CLAUDE.md
   already documents for `npm run gate*` on Linux. Confirmed by driving the
   published page with Playwright against `/opt/pw-browsers/chromium`: the
   fetch and `mp4box` demux both succeed (the loader is sound), and the
   failure is specifically the decode step, reproduced twice, cleanly, with
   no other error. **No amount of correctness in this session's code closes
   this gap — it needs a real browser, i.e. a Mac,** the same conclusion this
   repo's `gate.mjs` family already reached for the exact same reason.

2. **Even with a working decoder, the only fixture available is the wrong
   shape of data.** The stand-in used to build and smoke-test the plumbing —
   `fixtures/basic` from this repo's own test suite — is a *deterministic*
   clip: a hue-striped background and one square that moves on a fixed
   per-frame schedule (`fixtures/gen-display.swift`), built to prove the
   transform's two sinks agree pixel-for-pixel, not to look like a real
   screen. Its `events.json` is a hand-authored cursor track exercising the
   render pipeline's easing, **recorded independently of the video content**
   — the square does not move because of anything in that events file. So on
   this fixture the changed-pixel plot and the event ticks are structurally
   uncorrelated, and the study's actual question — does a change that starts
   near an event read differently from a caret blink, a spinner, a live
   chart tick, a hover trail — has **no evidence in this data either way**.
   There is no ambient/ignorable-change case in a hue background and one
   square; the study needs the two real fixtures the ticket names (Music
   Network from STC-313, 30–60s, continuous drag-heavy motion; a form-heavy
   app, 30–60s, discrete clicks/typing/dropdown/modal), and **neither is
   recorded yet** — STC-313's own status is "the recording is not done,"
   blocked on the same thing: a Mac.

Writing a rules list against this fixture would mean inventing the
temporal-filter behaviour from imagination rather than reading it off real
footage, which is exactly the thing the ticket's own framing rules out
("it can't be written before seeing the data") and exactly the kind of
unverified claim this repo's CLAUDE.md has repeatedly had to walk back
elsewhere. Better to say the rules are not written than to guess and dress
the guess up as a finding.

## What session two needs

A Mac, doing three things in order:

1. Record the two fixtures STC-319 actually asks for (or reuse STC-313's
   Music Network take once it exists, plus a fresh 30–60s pass over a
   form-heavy app — a real login/settings/checkout flow, not a mock).
2. Swap `/lab/frame-diff`'s `ASSET_BASE` (currently
   `/lab/study/frame-diff`, pointing at the synthetic stand-in) to the real
   take(s) — copy `display.mp4` + `anchors.json` + `events.json` into
   `public/lab/study/<slug>/` in `studio-cartelli` and update the one
   constant in `src/pages/lab/frame-diff.astro`. The loader and shader need
   no change for this; they were built against the real schema, not the
   synthetic fixture's shape.
3. Actually watch it: does the plotted changed-pixel fraction visibly spike
   near a click or a keystroke and stay low otherwise on the form app? Does a
   spinner or a live chart on either take show up as a small, continuous,
   ambient hump distinguishable from a discrete change? Write down what
   passes and what does not, per change type, with the timestamp/frame that
   shows each — that list is the deliverable, and per the ticket's own
   bound, if session two ends without it, that is the finding.

The GLSL half is the part that could be built without a Mac, and it is done.
The rules are the part that cannot be, and they are not.
