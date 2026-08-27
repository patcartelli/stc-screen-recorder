# Camera PiP — Increment 4a: the camera data path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A camera track can be demuxed and loaded into a `Session`, with its own empty-edit offset applied, so the sinks in 4b have something correct to draw.

**Architecture:** The demuxer becomes per-track rather than display-only; `loadSession` optionally takes a `camera.mp4` and fills `cameraFrames`; a deterministic camera fixture makes all of it testable in Node.

**Tech Stack:** TypeScript, vitest, mp4box.js, Swift (fixture generator only).

## Global Constraints

- All times are integer nanoseconds.
- `render(project, session, t)` stays pure. This increment does not touch it.
- Every wait needs a bound and a reason. mp4box signals a malformed file by **never calling back** — no `onReady`, no `onError` — so any promise wrapping it needs a watchdog. `demux.ts` already has one; keep it.
- `npm test` must be green at the end of every task. It is 182 tests / 27 files at the start.
- Do NOT touch `transform/src/compositor.ts` or either sink. Drawing the PiP is 4b, where the browser determinism gate can actually verify it — there is no Node-testable path to a canvas context today.

## The trap this increment exists to get right

`display.mp4`'s first sample is **not** at session time zero. AVAssetWriter records the gap between "start received" and "first frame arrived" as an **empty edit** (`media_time: -1`) and leaves sample CTS starting at 0. A demuxer reading only the sample table reports every frame early by that gap — measured at 231.7 ms on a real display capture, about 14 frames of cursor desync, small enough to look like a rendering bug rather than a clock one.

**The camera's gap is far worse.** Phase 0 measured ~1035 ms of warm-up, and increment 3 measured an Elgato Facecam taking 2.246 s merely to open. So the same compensation must be applied *per track*, and a camera track that skips it would be out by seconds rather than milliseconds.

---

### Task 1: Demux any track, not just the display

**Files:**
- Modify: `transform/src/demux.ts`
- Modify: callers — `transform/src/session.ts`, and anything else `grep -rn demuxDisplayMp4` finds

**Interfaces:**
- Produces: `demuxTrack(buf: ArrayBuffer, what: string): Promise<DemuxedVideo>` — `what` names the file in error messages.
- `demuxDisplayMp4` is REMOVED, not kept as an alias. Two names for one function is how a codebase ends up with two behaviours.

- [ ] **Step 1: Rename and add the label**

Rename `demuxDisplayMp4` to `demuxTrack` and give it a second parameter naming the file. Thread that name through every error message in the function — there are several that currently say "display.mp4" literally, and a camera failure reporting "display.mp4" is a diagnostic that lies, which this repo has been bitten by repeatedly.

The watchdog message is one of them. Check every string.

- [ ] **Step 2: Update callers**

Run `grep -rn "demuxDisplayMp4" --include='*.ts' --include='*.mjs' .` (excluding `node_modules`) and update each. Pass the real filename.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: green at 182 tests. This task adds no tests — it is a rename plus honest error strings, and Task 2 is what exercises the new name.

- [ ] **Step 4: Commit**

```bash
git add transform/src/demux.ts transform/src/session.ts
git commit -m "STC-232: demux any track, and name the file in its errors

The demuxer was display-only in name and in its error strings. A camera track
failing to parse reported 'display.mp4 may be truncated', which is a diagnostic
that lies — the class of bug this repo keeps paying for.

demuxDisplayMp4 is renamed rather than aliased: two names for one function is
how a codebase ends up with two behaviours."
```

---

### Task 2: A deterministic camera fixture

`fixtures/pip/` has `camera-frames.json` (118 PTS values from 1.0355 s to 3.0245 s) but no `camera.mp4`. Nothing can demux a camera track until one exists.

**Files:**
- Modify: `fixtures/gen-display.swift`
- Create: `fixtures/pip/camera.mp4` (generated, committed)
- Test: `transform/test/fixture-mp4.test.ts`

**Interfaces:**
- Produces: `fixtures/pip/camera.mp4`, whose demuxed PTS grid equals `fixtures/pip/camera-frames.json` exactly once the empty edit is honoured.

- [ ] **Step 1: Parameterise the generator's frame size**

`fixtures/gen-display.swift:27` hardcodes `let W = 640, H = 360`. A camera fixture wants a different size, both to exercise aspect-ratio handling in 4b and so a human can tell the two tracks apart by eye.

Add an optional `--size WxH` flag, defaulting to `640x360` so the existing display fixtures regenerate byte-identically. Follow the file's existing `--offset-ns` parsing style.

- [ ] **Step 2: Generate the fixture**

The camera's first frame is at 1.0355 s, which is exactly the warm-up gap the empty edit encodes. Generate the file with sample CTS starting at zero and that gap as an empty edit — the same shape a real capture produces:

```bash
xcrun swiftc -O -o /tmp/gen-display fixtures/gen-display.swift
python3 -c "
import json
g = json.load(open('fixtures/pip/camera-frames.json'))
first = g[0]
json.dump([t - first for t in g], open('/tmp/camera-rel.json','w'))
print('first', first, 'count', len(g), 'last-rel', g[-1]-first)"
/tmp/gen-display /tmp/camera-rel.json fixtures/pip/camera.mp4 --size 320x180 --offset-ns 1035500000
```

The grid handed to the generator is **relative** (starting at 0) and the offset carries the 1.0355 s — that is what makes AVAssetWriter emit an empty edit rather than shifting the sample times, which is the whole point of the fixture.

- [ ] **Step 3: Write the failing test**

Append to `transform/test/fixture-mp4.test.ts`, following the file's existing `demuxSamples()` pattern:

```typescript
describe("the camera fixture carries its warm-up as an empty edit", () => {
  // The camera's gap is ~1035 ms, against the display's measured 231.7 ms. A
  // demuxer that reads only the sample table would put every camera frame a
  // full second early — seconds of PiP desync rather than the milliseconds the
  // display track risks.
  test("demuxed camera PTS match camera-frames.json exactly", async () => {
    const buf = readFileSync(join(root, "fixtures", "pip", "camera.mp4"));
    const video = await demuxTrack(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      "camera.mp4",
    );
    const expected = JSON.parse(
      readFileSync(join(root, "fixtures", "pip", "camera-frames.json"), "utf8"));
    expect(video.framesNs).toEqual(expected);
  });

  test("the fixture's first frame is the warm-up gap, not zero", async () => {
    const buf = readFileSync(join(root, "fixtures", "pip", "camera.mp4"));
    const video = await demuxTrack(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      "camera.mp4",
    );
    // If this comes back 0 the empty edit was ignored and every PiP would sit
    // a second ahead of where it belongs.
    expect(video.framesNs[0]).toBe(1_035_500_000);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx vitest run transform/test/fixture-mp4.test.ts`
Expected: FAIL — the fixture file does not exist yet. `demuxTrack` DOES exist by now (Task 1 created it), so a failure naming `demuxTrack` instead of the missing file means Task 1 is incomplete; stop and say so rather than working around it.

- [ ] **Step 5: Commit**

```bash
git add fixtures/gen-display.swift fixtures/pip/camera.mp4 transform/test/fixture-mp4.test.ts
git commit -m "STC-232: a deterministic camera fixture, warm-up carried as an empty edit

fixtures/pip has had a camera PTS grid since increment 2 and no camera.mp4 to
demux. This generates one whose first sample sits 1.0355 s into the session as
an EMPTY EDIT rather than a shifted sample time — the shape a real capture
produces, and the shape that catches a demuxer reading only the sample table.

The camera's gap matters more than the display's: 1035 ms against 231.7 ms
measured, so ignoring it desyncs a PiP by a second rather than by 14 frames."
```

---

### Task 3: `loadSession` loads the camera track

**Files:**
- Modify: `transform/src/session.ts`
- Test: `transform/test/session.test.ts`

**Interfaces:**
- Consumes: `demuxTrack` (Task 1), `fixtures/pip/camera.mp4` (Task 2).
- Produces: `SessionInput` gains `cameraMp4?: ArrayBuffer`; `LoadedSession` gains `cameraVideo?: DemuxedVideo`; `Session.cameraFrames` is populated.

- [ ] **Step 1: Write the failing tests**

Append to `transform/test/session.test.ts`, using the file's existing `load`/`mp4`/`offsetAnchors` helpers:

```typescript
describe("loading a camera track", () => {
  const camAnchors = (over: any = {}) => offsetAnchors({
    version: 2,
    camera: {
      present: true, device: "Fixture Camera", width: 320, height: 180,
      firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
      frameIntervalNs: 17_000_000,
    },
    files: { display: "display.mp4", camera: "camera.mp4" },
    ...over,
  });

  test("a camera track becomes session.cameraFrames", async () => {
    const s = await loadSession({
      anchors: camAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    });
    expect(s.cameraFrames?.length).toBe(118);
    expect(s.cameraFrames?.[0]).toBe(1_035_500_000);
  });

  test("a session claiming a camera but given no camera.mp4 is refused", async () => {
    // Silently loading it as camera-less would leave render() returning
    // pip: null for a take that has one, which looks like a rendering bug.
    await expect(loadSession({
      anchors: camAnchors(),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    })).rejects.toThrow(/camera/i);
  });

  test("a camera whose demuxed start disagrees with the anchors is refused", async () => {
    // Same reasoning as the display track's existing offset check: the helper
    // wrote down what it measured, the file preserves a quantised version, and
    // comparing them turns a silent seconds-long desync into a loud failure.
    await expect(loadSession({
      anchors: camAnchors({ camera: { ...camAnchors().camera, firstFramePtsNs: 5_000_000_000 } }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
      cameraMp4: mp4("fixtures/pip/camera.mp4"),
    })).rejects.toThrow(/camera.*offset|offset.*camera/i);
  });

  test("a v2 session with no camera still loads", async () => {
    const s = await loadSession({
      anchors: offsetAnchors({ version: 2, camera: { present: false } }),
      events: { version: 1, events: [] },
      displayMp4: mp4("fixtures/offset/display.mp4"),
    });
    expect(s.cameraFrames).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run transform/test/session.test.ts`
Expected: FAIL. The first three fail because `cameraMp4` is not accepted and the existing guard rejects any `camera.present === true`. Confirm the failures name that guard rather than a typo.

- [ ] **Step 3: Implement**

In `transform/src/session.ts`:

- Add `cameraMp4?: ArrayBuffer` to `SessionInput` and `cameraVideo?: DemuxedVideo` to `LoadedSession`.
- **Delete** the increment-3 guard that throws whenever `anchors.camera?.present === true`. It exists only because there was no way to load a camera track; there is now.
- Replace it with the honest pair:
  - `camera.present === true` and no `cameraMp4` → throw, naming the take and saying the camera track was not supplied.
  - `cameraMp4` supplied and `camera.present !== true` → throw. A camera file with no anchors block means the two disagree about what was recorded, and guessing is worse than refusing.
- When both are present, demux with `demuxTrack(input.cameraMp4, "camera.mp4")` and set `cameraFrames`.
- Apply the same drift check the display track has: compare the demuxed first frame against `anchors.camera.firstFramePtsNs` with the existing `OFFSET_TOLERANCE_NS`, and fail loudly naming both numbers. Reuse the existing check rather than writing a second one if you can do so without contorting it.

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: green. Report the count.

- [ ] **Step 5: Commit**

```bash
git add transform/src/session.ts transform/test/session.test.ts
git commit -m "STC-232: loadSession loads the camera track

Increment 3 made loadSession REFUSE any session claiming a camera, because
there was no way to load one and silently returning a camera-less session
would have made render() report pip: null for a take that has a PiP. There is
a way now.

A camera file and an anchors camera block must agree: either both or neither.
A file with no anchors block means the two disagree about what was recorded,
and guessing which is right is worse than refusing.

The demuxed first frame is checked against anchors.camera.firstFramePtsNs, the
same way the display track's is. On the display that check catches a 231.7 ms
error; on the camera the gap it protects is ~1035 ms, so an unchecked one would
be seconds of PiP desync — visible in motion, invisible in a still frame."
```

---

## Out of scope, deliberately

- `composite()` and both sinks. Drawing the PiP is 4b: there is no Node-testable path to a canvas context, so the browser determinism gate is the only thing that can verify it, and that gate is 4b's deliverable.
- The preview memory measurement. It belongs with 4b, where a second decoder actually exists.

## Self-review notes

- **The riskiest thing here is the per-track empty edit.** It appears in the global constraints, in Task 1's fixture design, in Task 1's second assertion (`framesNs[0]` must be the gap, not zero), and in Task 3's drift check. A camera track that ignores it is out by a second, which looks like a rendering bug rather than a clock one.
- **Task 3's second and third tests exist because the failure they catch is silent.** A session that loads "successfully" without the camera track it claims, or with one whose timing disagrees with its anchors, produces a PiP that is absent or wrong rather than an error.
- `demuxDisplayMp4` is renamed rather than aliased on purpose; an alias is how one function becomes two behaviours.
