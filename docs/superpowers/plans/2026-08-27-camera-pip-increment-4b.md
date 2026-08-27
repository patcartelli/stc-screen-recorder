# Camera PiP — Increment 4b: both sinks + determinism gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both sinks draw the camera PiP through the one shared compositor, and a determinism gate proves they draw the *same* PiP — and that they actually draw one.

**Architecture:** `render()` already returns `fs.pip` geometry (increment 2) and `loadSession()` already exposes `session.cameraVideo` (increment 4a). This increment adds a second decoder per sink — `ForwardFrameSource` for export, `SeekingFrameSource` for preview — and one new parameter to `composite()`. No new transform logic: the PiP rectangle is computed by `render()` and only *drawn* here.

**Tech Stack:** TypeScript, WebCodecs (`VideoDecoder`), OffscreenCanvas, mp4box.js, vite + Playwright + real Chrome for the gate, vitest.

## Global Constraints

- **`render(project, session, t)` stays pure.** No decoder scheduling, no wall clock. Sinks may not fork it, and may not fork `composite()` either.
- **One in-flight decode request PER DECODER.** PHASE-0 §4b's rule is per decoder, not per app, and two decoders is exactly where it gets violated by accident. `SeekingFrameSource` and `ForwardFrameSource` each serialise internally, so **two separate instances are correct by construction** — do not share one, and do not add a shared queue.
- **Close `VideoFrame`s in the output callback path; never buffer them.** ~30 MB each at 4K.
- **Every wait needs a bound and a reason.** Use `withTimeout(p, ms, what)` from `transform/src/timeout.ts`.
- **Frame selection: greatest PTS ≤ t, hold, never interpolate.** Same rule for the camera track, bounded at both ends by `anchors.camera` (already implemented in `pipStateAt`).
- **Do not change `fixtures/pip/project.json`'s `output` block.** `transform/test/render.test.ts:169-229` asserts `pip.width === 480` and `pip.x === 3840 - 480 - 32` against it.
- **Pre-encode RGBA is the gate, never encoded MP4 bytes.** Container timestamps and encoder state are not contractually deterministic.

## The trap this increment exists to avoid

**Sink identity does NOT prove the PiP is drawn.** If `composite()` ignored the camera frame entirely, both sinks would still produce byte-identical output and every hash check would pass. The existing gate shape is blind to this exact failure — and it is the most likely failure, because "forgot to wire the camera through" is the default state of the code before this increment.

So the gate must carry a **positive** assertion: with `pip.enabled: true`, the pixels inside the PiP rectangle must differ from the same frame rendered with `pip.enabled: false`. Task 4 builds that, and it is the single most important check in this plan.

This is the same lesson as PHASE-2's cursor: hashes prove the sinks AGREE, only a positive check (and a human's eyes) prove the agreed answer is right.

---

### Task 1: `composite()` draws the PiP

**Files:**
- Modify: `transform/src/compositor.ts:10-19`
- Modify: `transform/src/export.ts:103` (call site only — keeps the build green)
- Modify: `transform/src/preview.ts:113-115` (call site only)
- Modify: `harness/sink-identity.ts:67,80` (call sites only)
- Modify: `harness/main.ts:40,71` (call sites only)

**Interfaces:**
- Consumes: `FrameState.pip` (`PipState | null`) from `transform/src/render.ts:29-36` — fields `frameIndex`, `framePtsNs`, `x`, `y`, `width`, `height`.
- Produces: `composite(ctx, frame, camera, fs, width, height)` — the `camera` parameter is inserted **third**, immediately after `frame`, so the two image inputs sit together. Every call site must be updated in this task or the build breaks.

- [ ] **Step 1: Change the signature and draw the PiP**

In `transform/src/compositor.ts`, replace the signature and add the PiP draw **after** the display frame and **before** the cursor — the cursor must stay on top, or a cursor over the PiP corner would vanish behind it:

```typescript
export function composite(
  ctx: OffscreenCanvasRenderingContext2D,
  frame: ImageBitmap | null,
  camera: ImageBitmap | null,
  fs: FrameState,
  width: number,
  height: number,
): void {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  if (frame) ctx.drawImage(frame, 0, 0, width, height);

  // The PiP sits under the cursor deliberately: a cursor over the bottom-right
  // corner must stay visible, and `render()` has already decided the rectangle.
  // Drawn only when BOTH the geometry and a decoded camera frame exist — a
  // missing frame means the decoder has nothing yet, which is a black gap, not
  // a stretched stale frame.
  if (fs.pip && camera) {
    ctx.drawImage(camera, fs.pip.x, fs.pip.y, fs.pip.width, fs.pip.height);
  }

  if (!fs.cursor.visible) return;

  const { x, y, scale, pressed } = fs.cursor;
  const r = 8 * scale;
  if (pressed) {
    ctx.beginPath();
    ctx.arc(x, y, r * 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2 * scale;
  ctx.strokeStyle = "#000000";
  ctx.stroke();
}
```

- [ ] **Step 2: Update all SIX call sites to pass `null` for now**

**`npx tsc --noEmit` will NOT catch a missed one.** `tsconfig.json` includes
only `transform/**/*.ts`, so `harness/` and `app/` are not typechecked at all —
verified the hard way: missing `harness/main.ts` left tsc clean and 195 tests
green, and only `npm run gate` caught it as a runtime TypeError. Find them all
with:

```bash
grep -rn "composite(" --include="*.ts" . | grep -v node_modules | grep -v "export function composite"
```


`transform/src/export.ts:103`:

```typescript
      composite(ctx, frame as unknown as ImageBitmap | null, null, fs, width, height);
```

`transform/src/preview.ts:113-115`:

```typescript
      composite(this.ctx as unknown as OffscreenCanvasRenderingContext2D,
                frame as unknown as ImageBitmap | null, null, fs,
                this.project.output.width, this.project.output.height);
```

`harness/sink-identity.ts:67`:

```typescript
      composite(fwdCtx, frame as unknown as ImageBitmap | null, null, fs, width, height);
```

`harness/sink-identity.ts:80`:

```typescript
      composite(prevCtx, frame as unknown as ImageBitmap | null, null, fs, width, height);
```

`harness/main.ts:40` and `:71` — both identical, the increment-0 harness with
pre-decoded bitmaps and no camera:

```typescript
    composite(ctx, fs.frameIndex === null ? null : bitmaps[fs.frameIndex]!, null, fs, width, height);
```

Passing `null` here is deliberate and temporary: Tasks 2 and 3 replace each one with a real camera frame. It keeps this task's deliverable independently reviewable — a signature change with no behaviour change.

- [ ] **Step 3: Verify nothing regressed**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean, all tests pass (same count as before this task — no test asserts on the compositor directly; there is no Node-testable canvas path, which is why Task 4's browser gate is the real verification).

Do not read a clean tsc as proof the call sites are right — it does not see
`harness/`. Step 4 is the one that actually checks.

- [ ] **Step 4: Verify the existing gate still passes**

Run: `npm run gate`
Expected: `GATE: PASS` — 200 sampled t identical, 300 export frames identical twice over.

- [ ] **Step 5: Commit**

```bash
git add transform/src/compositor.ts transform/src/export.ts transform/src/preview.ts harness/sink-identity.ts
git commit -m "STC-232 4b: composite() takes a camera frame and draws the PiP

The rectangle comes from render(); this only draws it. Under the cursor
deliberately — a cursor over the bottom-right corner must not disappear
behind the PiP.

Call sites pass null until the sinks supply a frame in the next two commits,
so this stands alone as a signature change with no behaviour change."
```

---

### Task 2: the export sink decodes the camera

**Files:**
- Modify: `transform/src/export.ts:56` (add the camera source), `:101-103` (feed it), `:164-167` (close it)
- Test: `transform/test/export-pip.test.ts` (create) — asserts the wiring contract that IS Node-testable

**Interfaces:**
- Consumes: `LoadedSession.cameraVideo?: DemuxedVideo` (`transform/src/session.ts:27`), `composite(ctx, frame, camera, fs, w, h)` from Task 1.
- Produces: `ExportResult.cameraDecodedFrames: number` — a new field, so the gate can assert the camera decoder actually ran rather than silently no-opping.

- [ ] **Step 1: Write the failing test**

Create `transform/test/export-pip.test.ts`. This asserts the one thing about export+PiP that is testable without a canvas: a session with a camera reports camera frames decoded, and one without reports zero.

```typescript
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession } from "../src/session.js";
import type { Project } from "../src/types.js";

const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const mp4 = (p: string) => {
  const b = readFileSync(join(root, p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe("export reports whether the camera decoder ran", () => {
  // exportSession needs WebCodecs, which Node does not have — so this asserts
  // the SESSION contract the export sink depends on, not the export itself.
  // The export path proper is verified by the browser gate in Task 4, which is
  // the only place a canvas and a VideoDecoder both exist.
  test("a PiP session exposes a camera track for the sink to decode", async () => {
    const s = await loadSession({
      anchors: load("fixtures/pip/anchors.json"),
      events: load("fixtures/pip/events.json"),
      displayMp4: mp4("fixtures/pip/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });
    expect(s.cameraVideo, "the sink cannot decode what loadSession did not demux").toBeDefined();
    expect(s.cameraVideo!.chunks.length).toBeGreaterThan(0);
    expect(s.cameraFrames!.length).toBe(118);
  });

  test("a camera-less session exposes none, so the sink draws no PiP", async () => {
    const s = await loadSession({
      anchors: load("fixtures/basic/anchors.json"),
      events: load("fixtures/basic/events.json"),
      displayMp4: mp4("fixtures/basic/display.mp4"),
    });
    expect(s.cameraVideo).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run transform/test/export-pip.test.ts`
Expected: FAIL — `fixtures/pip/display.mp4` does not exist yet (ENOENT). That file is created in Task 4 Step 1; if you are executing tasks in order, create it now with the command below and re-run.

```bash
cp fixtures/basic/display.mp4 fixtures/pip/display.mp4
```

`fixtures/pip/frames.json` is byte-identical to `fixtures/basic/frames.json` (verified), so `fixtures/basic/display.mp4` is exactly the matching display track. `loadSession`'s `checkFrameOffset` will reject it loudly if that ever stops being true.

Re-run. Expected now: PASS for the second test, FAIL for the first only if the copy was skipped.

- [ ] **Step 3: Add the camera source to the export sink**

In `transform/src/export.ts`, after line 56 (`const source = new ForwardFrameSource(session.video);`):

```typescript
  // A SECOND decoder, never a shared one. PHASE-0 §4b's one-in-flight rule is
  // per decoder, and ForwardFrameSource serialises internally, so two instances
  // are correct by construction.
  //
  // Forward-only is safe for the camera too: pip.frameIndex is monotonic in t
  // exactly as the display index is. pipStateAt() returns null outside the
  // track's bounds, so this is simply not asked for a frame there — it never
  // goes backwards.
  const cameraSource = session.cameraVideo
    ? new ForwardFrameSource(session.cameraVideo)
    : null;
```

Replace lines 101-103 with:

```typescript
      const frame = idx === null ? null : await source.frameAt(idx);
      const cameraFrame = fs.pip && cameraSource
        ? await cameraSource.frameAt(fs.pip.frameIndex)
        : null;
      peakBuffered = Math.max(peakBuffered, source.bufferedCount + (cameraSource?.bufferedCount ?? 0));
      composite(ctx, frame as unknown as ImageBitmap | null,
                cameraFrame as unknown as ImageBitmap | null, fs, width, height);
```

- [ ] **Step 4: Report the camera decode count and close the source**

Add to the `ExportResult` interface (after `decodedFrames: number;` at line 38):

```typescript
  /** Camera frames decoded. Zero for a camera-less take; zero for a PiP take means the PiP never drew. */
  cameraDecodedFrames: number;
```

In the returned object (after `decodedFrames: source.decodedCount,`):

```typescript
      cameraDecodedFrames: cameraSource?.decodedCount ?? 0,
```

In the `finally` block (after `source.close();`):

```typescript
    cameraSource?.close();
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean, all tests pass including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add transform/src/export.ts transform/test/export-pip.test.ts fixtures/pip/display.mp4
git commit -m "STC-232 4b: the export sink decodes and draws the camera

A second ForwardFrameSource, never a shared decoder. Forward-only is safe for
the camera because pip.frameIndex is monotonic in t and pipStateAt() returns
null outside the track rather than clamping backwards.

cameraDecodedFrames is reported so the gate can tell 'drew no PiP' from
'decoded nothing' — a silent zero is the failure mode a hash comparison
cannot see."
```

---

### Task 3: the preview sink decodes the camera

**Files:**
- Modify: `transform/src/preview.ts:15` (field), `:34` (construct), `:103-120` (draw), `:122-126` (close)

**Interfaces:**
- Consumes: `LoadedSession.cameraVideo`, `SeekingFrameSource` (`transform/src/seeking-frame-source.ts`), `composite(...)` from Task 1.
- Produces: no new public API. `PreviewPlayer.stats` gains `cameraRenderedFrames` for Task 5's memory measurement.

- [ ] **Step 1: Add the camera source field and construct it**

In `transform/src/preview.ts`, after line 15 (`private readonly source: SeekingFrameSource;`):

```typescript
  private readonly cameraSource: SeekingFrameSource | null;
```

After line 34 (`this.source = new SeekingFrameSource(session.video);`):

```typescript
    // A second SeekingFrameSource, not a shared one. Each serialises its own
    // requests internally (ticket/chain), so the one-in-flight-per-decoder rule
    // holds by construction — sharing one decoder between two tracks is exactly
    // the accident PHASE-0 §4b warns about.
    this.cameraSource = session.cameraVideo
      ? new SeekingFrameSource(session.cameraVideo)
      : null;
```

- [ ] **Step 2: Draw the PiP**

Replace the body of `draw()` (lines 103-120) with:

```typescript
  private async draw(): Promise<void> {
    if (this.rendering || this.closed) { this.lateFrames++; return; }
    this.rendering = true;
    try {
      const tick = tickOf(this.tNs);
      const t = tickTimeNs(tick);
      const fs = render(this.project, this.session, t);
      const idx = frameIndexAt(this.session.frames, t);
      // Both decoders are driven concurrently. They are independent decoders
      // with independent in-flight guards, and `this.rendering` already
      // serialises whole draws — so a superseded seek can never pair a display
      // frame from one t with a camera frame from another.
      const [frame, cameraFrame] = await Promise.all([
        idx === null ? null : this.source.frameAt(idx),
        fs.pip && this.cameraSource ? this.cameraSource.frameAt(fs.pip.frameIndex) : null,
      ]);
      if (this.closed) return;
      composite(this.ctx as unknown as OffscreenCanvasRenderingContext2D,
                frame as unknown as ImageBitmap | null,
                cameraFrame as unknown as ImageBitmap | null, fs,
                this.project.output.width, this.project.output.height);
      this.renderedFrames++;
      if (cameraFrame) this.cameraRenderedFrames++;
    } finally {
      this.rendering = false;
    }
  }
```

Add the counter field after line 24 (`private renderedFrames = 0;`):

```typescript
  private cameraRenderedFrames = 0;
```

And extend the `stats` getter (line 56):

```typescript
  get stats() {
    return {
      lateFrames: this.lateFrames,
      renderedFrames: this.renderedFrames,
      cameraRenderedFrames: this.cameraRenderedFrames,
    };
  }
```

- [ ] **Step 3: Close the camera source**

In `close()` (after `this.source.close();`):

```typescript
    this.cameraSource?.close();
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean, all tests pass.

Run: `npm run gate:seek`
Expected: PASS — the seeking source's own gate must be unaffected by a second instance existing.

- [ ] **Step 5: Commit**

```bash
git add transform/src/preview.ts
git commit -m "STC-232 4b: the preview sink decodes and draws the camera

A second SeekingFrameSource. Both are driven with Promise.all: they are
independent decoders with independent in-flight guards, and the existing
`rendering` flag already serialises whole draws, so a superseded seek cannot
pair a display frame from one t with a camera frame from another."
```

---

### Task 4: the determinism gate, extended to a PiP session

**Files:**
- Create: `fixtures/pip/display.mp4` (copy — see Task 2 Step 2)
- Modify: `fixtures/pip/anchors.json` (add `files.camera`)
- Modify: `harness/sink-identity.ts` (whole `runSinkIdentity` body)
- Modify: `scripts/identity-gate.mjs` (accept a fixture dir; assert the new fields)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `runSinkIdentity(dir, sampleCount)` returning `{ samples, mismatches, peakBuffered, decoderGenerations, totalOut, cameraPresent, pipDrawnFrames, pipBlindMismatches }`.

- [ ] **Step 1: Complete the fixture**

```bash
cp fixtures/basic/display.mp4 fixtures/pip/display.mp4
```

In `fixtures/pip/anchors.json`, change the `files` block to:

```json
  "files": {
    "display": "display.mp4",
    "camera": "camera.mp4"
  },
```

`schema/anchors-2.schema.json` already allows `files.camera` (optional string). The harness uses its presence to decide whether to fetch a camera track, so a take that has one says so in its own anchors rather than the gate guessing.

- [ ] **Step 2: Verify the fixture still validates and still loads**

Run: `npx vitest run transform/test/session.test.ts helper/test/anchors.test.ts`
Expected: PASS. If `anchors.test.ts` fails on `additionalProperties`, the schema does not allow `files.camera` — re-read `schema/anchors-2.schema.json` before changing anything else.

- [ ] **Step 3: Rewrite `runSinkIdentity` to read the take's own project and drive both tracks**

Replace the body of `(window as any).runSinkIdentity` in `harness/sink-identity.ts` with:

```typescript
(window as any).runSinkIdentity = async (dir: string, sampleCount = 60) => {
  try {
    const anchors = await fetch(`${dir}/anchors.json`).then((r) => r.json());
    const events = await fetch(`${dir}/events.json`).then((r) => r.json());
    const mp4 = await fetch(`${dir}/${anchors.files.display}`).then((r) => r.arrayBuffer());
    const cameraMp4 = anchors.files.camera
      ? await fetch(`${dir}/${anchors.files.camera}`).then((r) => r.arrayBuffer())
      : undefined;

    const session = await loadSession({ anchors, events, displayMp4: mp4, cameraMp4 });

    // The take's OWN project.json, never a synthesised one. A CLI gate that
    // hardcoded a project instead of reading the take's is exactly what made
    // test:slow report a hash mismatch between two correct implementations
    // once trim existed. Falls back only when a take has no project at all.
    const project: Project = await fetch(`${dir}/project.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      ?? {
        version: 1,
        output: { fps: 60, width: anchors.capture.width, height: anchors.capture.height },
        cursor: { style: "default", scale: 1 },
      };

    const { width, height } = project.output;
    const mkCtx = () => new OffscreenCanvas(width, height)
      .getContext("2d", { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

    const lastNs = session.frames[session.frames.length - 1]!;
    const totalOut = Math.floor((lastNs * 60) / 1e9) + 1;

    const ks: number[] = [];
    for (let i = 0; i < sampleCount; i++) ks.push(Math.floor((i * (totalOut - 1)) / (sampleCount - 1)));
    const shuffled = [...ks];
    let seed = 0xc0ffee;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    // --- export sink (forward-only, ascending) ---
    const fwdCtx = mkCtx();
    const fwd = new ForwardFrameSource(session.video);
    const fwdCam = session.cameraVideo ? new ForwardFrameSource(session.cameraVideo) : null;
    const exportHash = new Map<number, string>();
    // Hash of the SAME frame composited with the PiP suppressed. Comparing the
    // two is the only check that can tell "both sinks drew the PiP identically"
    // from "both sinks ignored the camera identically" — the latter passes every
    // hash comparison in this file and is the likeliest way this increment fails.
    const blindHash = new Map<number, string>();
    const blindCtx = mkCtx();
    let pipDrawnFrames = 0;

    for (const k of ks) {
      const t = tickTimeNs(2 * k);
      const fs = render(project, session, t);
      const idx = frameIndexAt(session.frames, t);
      const frame = idx === null ? null : await fwd.frameAt(idx);
      const cam = fs.pip && fwdCam ? await fwdCam.frameAt(fs.pip.frameIndex) : null;
      composite(fwdCtx, frame as unknown as ImageBitmap | null,
                cam as unknown as ImageBitmap | null, fs, width, height);
      exportHash.set(k, await hashCanvas(fwdCtx, width, height));

      composite(blindCtx, frame as unknown as ImageBitmap | null, null, fs, width, height);
      blindHash.set(k, await hashCanvas(blindCtx, width, height));
      if (fs.pip && cam) pipDrawnFrames++;
    }
    fwd.close();
    fwdCam?.close();

    // --- preview sink (seeking, shuffled) ---
    const prevCtx = mkCtx();
    const seek = new SeekingFrameSource(session.video);
    const seekCam = session.cameraVideo ? new SeekingFrameSource(session.cameraVideo) : null;
    const mismatches: string[] = [];
    for (const k of shuffled) {
      const t = tickTimeNs(2 * k);
      const fs = render(project, session, t);
      const idx = frameIndexAt(session.frames, t);
      const [frame, cam] = await Promise.all([
        idx === null ? null : seek.frameAt(idx),
        fs.pip && seekCam ? seekCam.frameAt(fs.pip.frameIndex) : null,
      ]);
      composite(prevCtx, frame as unknown as ImageBitmap | null,
                cam as unknown as ImageBitmap | null, fs, width, height);
      const h = await hashCanvas(prevCtx, width, height);
      if (h !== exportHash.get(k)) mismatches.push(`frame ${k} (t=${(t / 1e6).toFixed(1)}ms)`);
    }
    const stats = seek.stats;
    seek.close();
    seekCam?.close();

    // Frames where drawing the PiP changed nothing. On a PiP take this must be
    // zero for every frame that HAS a pip — otherwise the camera is being
    // decoded and then thrown away.
    let pipBlindMismatches = 0;
    for (const k of ks) if (exportHash.get(k) === blindHash.get(k)) pipBlindMismatches++;

    return {
      samples: ks.length, mismatches, peakBuffered: stats.peakBuffered,
      decoderGenerations: stats.decoderGenerations, totalOut,
      cameraPresent: !!session.cameraVideo,
      pipDrawnFrames, pipBlindMismatches,
    };
  } catch (e: any) {
    return { fatal: String(e?.stack ?? e) };
  }
};
```

- [ ] **Step 4: Widen the gate server's file whitelist**

`scripts/identity-gate.mjs`'s `/session` middleware serves an explicit
whitelist and calls `next()` for anything else — so `camera.mp4` and
`project.json` would fall through to vite and never reach the page. This is
easy to miss because the failure is not a 404 in the gate output: the page's
`fetch` resolves with vite's own HTML, `r.json()` throws, and the take loads
camera-less and silently passes as a non-PiP session.

Replace the whitelist line:

```javascript
      if (!["anchors.json", "events.json", "display.mp4", "camera.mp4", "project.json"].includes(n)) return next();
```

Serving a file that is not there must fail loudly rather than fall through, so
guard the read:

```javascript
      const f = join(sessionDir, n);
      if (!existsSync(f)) { res.statusCode = 404; res.end(`no ${n} in this take`); return; }
      res.setHeader("content-type", n.endsWith(".json") ? "application/json" : "video/mp4");
      res.end(readFileSync(f));
```

A camera-less take genuinely has no `camera.mp4`, and the page only fetches it
when `anchors.files.camera` is set — so a 404 here means the anchors and the
directory disagree, which is worth failing on.

- [ ] **Step 5: Teach the gate script to run the PiP fixture**

In `scripts/identity-gate.mjs`, allow a fixture directory to be passed instead of a recorded take, and assert the new fields. Replace the `page.evaluate` call and the assertions after it with:

```javascript
    try { r = await page.evaluate((n) => window.runSinkIdentity("/session", n), SAMPLES); break; }
```

and add near the top, after `sessionDir` is resolved:

```javascript
// A PiP fixture is served the same way a real take is; 200 samples because the
// PiP determinism claim in the design spec is stated at 200.
const SAMPLES = Number(process.env.STC_IDENTITY_SAMPLES ?? 60);
```

After the existing mismatch assertions, add:

```javascript
  console.log(`camera track present: ${r.cameraPresent}`);
  if (r.cameraPresent) {
    console.log(`PiP drawn on ${r.pipDrawnFrames} of ${r.samples} sampled frames`);
    if (r.pipDrawnFrames === 0) {
      fail("camera track present but the PiP never drew — the sinks decoded nothing");
    }
    // THE check that hashes alone cannot make. Both sinks ignoring the camera
    // agree perfectly; only comparing against a PiP-suppressed render catches it.
    if (r.pipBlindMismatches > 0) {
      fail(`${r.pipBlindMismatches} of ${r.samples} frames are IDENTICAL with the PiP ` +
           `suppressed — the camera is decoded and then discarded`);
    }
  }
```

- [ ] **Step 6: Run the gate against the PiP fixture**

Run:

```bash
STC_IDENTITY_SAMPLES=200 npm run gate:identity -- fixtures/pip
```

Expected: `cameraPresent: true`, `PiP drawn on 200 of 200`, `0 mismatches`, `0` blind mismatches, and PASS.

**If `pipBlindMismatches` equals the sample count, do not "fix" the assertion** — it means the PiP is genuinely not being drawn, which is the defect this check exists to find. Work backwards: is `session.cameraVideo` defined, is `fs.pip` non-null, did `frameAt` return a frame?

- [ ] **Step 7: Run every other gate, to prove nothing regressed**

Run: `npm run gate && npm run gate:seek && npm run gate:identity`
Expected: all PASS. The camera-less path must be completely unaffected — `cameraPresent: false` and the PiP block skipped.

- [ ] **Step 8: Commit**

```bash
git add fixtures/pip/display.mp4 fixtures/pip/anchors.json harness/sink-identity.ts scripts/identity-gate.mjs
git commit -m "STC-232 4b: the determinism gate covers a PiP session

Two sinks agreeing is NOT evidence the PiP is drawn: both ignoring the camera
hash identically and pass every existing check. So the gate now composites
each sampled frame a second time with the PiP suppressed and requires the two
to DIFFER. That is the assertion that can actually fail if the camera is
decoded and discarded.

The gate also reads the take's own project.json instead of synthesising one —
the same defect test:slow caught once trim existed."
```

---

### Task 5: measure preview memory, and produce something a human can watch

**Files:**
- Modify: `PHASE-2.md` (record the measurement)
- Modify: `CLAUDE.md` (status + any trap found)

**Interfaces:**
- Consumes: `PreviewPlayer.stats.cameraRenderedFrames` from Task 3, `ExportResult.cameraDecodedFrames` from Task 2.

This task is deferred from 4a explicitly ("The preview memory measurement. It belongs with 4b, where a second decoder actually exists").

- [ ] **Step 1: Measure renderer RSS with two decoders**

The existing measurement path is `app.getAppMetrics()` — **not** `performance.memory.usedJSHeapSize`, which does not count ArrayBuffers and reports a 458 MB buffer as "0 MB heap growth".

Record: renderer RSS previewing a camera-less take vs the same take with a camera track, and the ratio against file size. The open risk in the design spec is stated as "a 720p camera track adds ~10-15% to renderer RSS" — **measure it, do not repeat the estimate.**

- [ ] **Step 2: Write the number into `PHASE-2.md`**

Alongside the existing "preview ~1.2x file size in RAM" line, with its caveats and the take it was measured on. If the ceiling moved, say what it moved to — STC-251's ~15-minute 4K ceiling is the number people plan against.

- [ ] **Step 3: Export something watchable**

```bash
node scripts/export-one.mjs <a real PiP take> 20
```

- [ ] **Step 4: WATCH IT. This is not optional.**

The spec is explicit and PHASE-2 learned it the hard way with the cursor: **a uniformly mispositioned or time-shifted PiP passes every automated check in this repo.** Hashes prove the sinks agree; only watching proves the agreed answer is right.

Confirm by eye: the camera image is in the bottom-right, correctly proportioned (not stretched), appears when the camera track starts and **disappears at its end rather than freezing on a last frame**, and is in sync with the display content.

This requires a real take with a camera, which requires the Camera grant — `npm run test:capture` produces one.

- [ ] **Step 5: Update `CLAUDE.md`**

Move increment 4b to done in the phase-3 table, and note that takes with `camera.present: true` can now be opened — the sequencing constraint from the 2026-08-27 handoff is discharged, which is what unblocks increment 5.

- [ ] **Step 6: Commit and open a PR**

```bash
git add PHASE-2.md CLAUDE.md
git commit -m "STC-232 4b: measured preview memory with two decoders, and watched the PiP"
git push -u origin HEAD
gh pr create --base master
```

Then `npm run merge -- <pr>` — never `gh pr merge --auto`.

---

## Self-review

**Spec coverage.** Design spec "Testing" → determinism gate extended to a PiP session, 200 sampled t, both sinks byte-identical, camera present: Task 4. Increment ladder item 4 "Both sinks + determinism gate extended for PiP": Tasks 1-4. Open risk "preview memory ... increment 4 should measure rather than estimate": Task 5. "One in-flight decode request per decoder": Global Constraints, enforced by using two instances in Tasks 2-3. Track-end behaviour (no frozen face): already in `pipStateAt`, confirmed by eye in Task 5 Step 4.

**Not covered here, by design.** The app UI toggle and the measured sync number are increment 5. `composite()` has no Node unit test because there is no Node-testable canvas path in this repo — Task 4's browser gate is the substitute, and Task 4 Step 6 says what to do when it fails.

**Known risk.** The PiP fixture's project declares a 3840×2160 output over a 640×360 source, so the gate hashes 200 4K canvases twice plus 200 blind ones. `gate:export` already hashes 3617 4K frames, so this is within proven budget — but if it is unacceptably slow, reduce `STC_IDENTITY_SAMPLES` rather than editing `fixtures/pip/project.json`, which `render.test.ts:169-229` asserts against.
