# Camera PiP — Increment 5: app toggle (sticky) + a measured sync number

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recording with the camera on is a thing a user can do from the app, the setting survives a restart, and the resulting take previews and exports with its PiP — plus a *measured* camera-to-display sync figure rather than "looks right".

**Architecture:** Every layer below the UI already exists. The helper's `start` command already accepts `camera: Bool` (`helper/src/main.swift:97`), `CameraCapture.swift` already records, and both sinks already draw the PiP. This increment is the app: a toggle, a persisted preference, the flag threaded through `recorder:start`, and one gap in the transform that would otherwise make every app-recorded camera take show no PiP at all.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), vitest, Playwright-Electron.

## The gap this increment must close, beyond the toggle

**A camera take recorded by the app would preview with NO PiP today.**

- The app writes `project.json` only through `preview:writeProject`, which exists for trim. **Nothing writes one at record time.**
- With no `project.json`, `app/src/renderer.ts:234` calls `parseProject(null, …)`, which returns `defaultProject(w, h)`.
- `defaultProject` (`transform/src/trim.ts:57`) sets `version`, `output`, `cursor` — and **no `pip`**.
- `render()` therefore returns `pip: null`, and `composite()` draws nothing.

So the toggle alone produces a take with a perfectly good `camera.mp4` and an invisible PiP. This is the same family as the defect the 15:51 hardware take exposed — that take had no `project.json` either, and one had to be written by hand before the PiP appeared.

**Decision: default the PiP on for takes that have a camera**, rather than writing a `project.json` at record time. Reasons:

1. It fixes takes that already exist, and takes produced by `tools/test-host`, neither of which has a `project.json`.
2. Absence of a project means "show me the take as recorded", and a recorded camera track *is* part of the take. A project is the edit document; needing one to see what you filmed is backwards.
3. It keeps record-time writing out of the capture path, which is where STC-254 lived.

Writing a `project.json` at record time remains available later for persisting *edited* geometry; it is not needed for this.

## Global constraints

- **Camera is opt-in: toggle, default off, sticky** (design spec §Decisions). The camera LED is physical and the TCC prompt must appear at a moment the user caused.
- **The device opens on start and closes on stop — never held while idle.** Already true in the helper; this increment must not change it, and Task 5 confirms it on hardware.
- **`render()` stays pure.** The pip default is decided when the project is parsed, never inside `render()`.
- **The renderer never names a path.** The preference lives in the main process, like every other piece of state the renderer is not trusted with.
- **`npm run typecheck` is three passes.** `document` in main and `process` in the renderer are both type errors now.

---

### Task 1: a take with a camera gets a PiP by default

**Files:**
- Modify: `transform/src/trim.ts` (`defaultProject`, `parseProject`)
- Modify: `app/src/renderer.ts:234` (the one production caller)
- Test: `transform/test/trim.test.ts`

**Interfaces:**
- Produces: `defaultProject(width, height, trim?, hasCamera?)` and
  `parseProject(raw, width, height, durationNs, hasCamera?)`. `hasCamera` defaults to `false`, so every existing caller keeps its current meaning; the app passes `anchors.camera?.present === true`.
- Default geometry matches `fixtures/pip/project.json`: `{ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 }`.

- [ ] **Step 1: Write the failing tests**

```typescript
  test("a take with a camera gets a PiP even with no project.json", () => {
    const p = parseProject(null, 3840, 2160, duration, true);
    expect(p.pip).toEqual({ enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32 });
  });

  test("a take with no camera gets no PiP", () => {
    expect(parseProject(null, 3840, 2160, duration, false).pip).toBeUndefined();
    // The default must not change for the takes that already exist.
    expect(parseProject(null, 1920, 1080, duration)).toEqual(defaultProject(1920, 1080));
  });

  test("an explicit pip in the document beats the default", () => {
    // Someone who turned the PiP off must stay off — the default is a default,
    // not an override, or disabling the PiP would be impossible on a camera take.
    const raw = { version: 2, output: { fps: 60, width: 640, height: 360 },
                  cursor: { style: "default", scale: 1 },
                  pip: { enabled: false, corner: "bottom-right", widthPct: 0.125, marginPx: 32 } };
    expect(parseProject(raw, 640, 360, duration, true).pip!.enabled).toBe(false);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run transform/test/trim.test.ts`
Expected: the first and third fail (`pip` undefined / the default overwriting the document); the second passes already, which is the point — it pins the behaviour that must NOT change.

- [ ] **Step 3: Implement**

In `transform/src/trim.ts`:

```typescript
/**
 * The PiP a camera take gets when its project does not say otherwise.
 *
 * Matches fixtures/pip/project.json so the fixture and the app agree about what
 * "default" means.
 */
export const DEFAULT_PIP: Pip = {
  enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32,
};

export function defaultProject(width: number, height: number, trim?: Trim, hasCamera = false): Project {
  const project: Project = {
    version: 2,
    output: { fps: 60, width, height },
    cursor: { style: "default", scale: 1 },
  };
  // A recorded camera track is part of the take, so a take with one shows its
  // PiP without needing an edit document to say so. Without this, every take
  // the app records with the camera on previews with an invisible PiP: nothing
  // writes a project.json at record time, and render() returns pip: null.
  if (hasCamera) project.pip = { ...DEFAULT_PIP };
  if (trim) project.trim = trim;
  return project;
}
```

and in `parseProject`, thread `hasCamera` into both `defaultProject` calls, leaving the existing `if (doc.pip …) project.pip = doc.pip;` after it so an explicit document always wins.

- [ ] **Step 4: Wire the one production caller**

`app/src/renderer.ts:234`:

```typescript
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: clean, all green.

- [ ] **Step 6: Commit**

---

### Task 2: the camera preference, owned by the main process

**Files:**
- Modify: `app/src/main.ts`
- Modify: `app/src/preload.ts`
- Test: `app/test/settings.test.ts` (create)

**Interfaces:**
- Produces: `recorder:getSettings` → `{ camera: boolean }`, `recorder:setSettings` (partial) → the merged settings. Backed by `settings.json` in `app.getPath("userData")`.

- [ ] **Step 1: Write the failing test** for a pure read/write helper (`readSettings`/`writeSettings` taking a directory), covering: missing file → `{ camera: false }`; corrupt JSON → default, not a throw; round-trip; and an unknown key being dropped rather than persisted.

- [ ] **Step 2: Watch it fail.** Expected: module not found.

- [ ] **Step 3: Implement** the helper plus the two IPC handlers. A corrupt or unreadable settings file must never cost the user a recording — fall back to defaults, exactly as `parseProject` does for a corrupt sidecar.

- [ ] **Step 4: Expose on the preload surface** — `getSettings`, `setSettings`, listed explicitly like every other channel.

- [ ] **Step 5: Verify and commit.**

---

### Task 3: the toggle, and the flag reaching the helper

**Files:**
- Modify: `app/renderer/index.html` (the control, next to `#record`)
- Modify: `app/src/renderer.ts`
- Modify: `app/src/main.ts` (`recorder:start`)

- [ ] **Step 1: Add the control**

```html
    <label id="camera-label"><input type="checkbox" id="camera"> Camera</label>
```

- [ ] **Step 2: Load the saved value on startup, persist on change, and disable it while recording** — the helper opens the device at `start`, so flipping it mid-take would be a lie about what is being recorded.

- [ ] **Step 3: Thread it through `recorder:start`**

```typescript
  const { camera } = await readSettings(app.getPath("userData"));
  const r = await sup.startRecording(dir, { camera });
```

Read at start time from the stored settings, **not** passed up from the renderer: the main process already owns the preference, and a renderer-supplied flag would be a second source of truth for the thing that turns on a camera.

- [ ] **Step 4: Verify and commit.**

---

### Task 4: prove it in the app, without a camera

**Files:**
- Modify: `app/test/shell.e2e.test.ts` or a new `app/test/camera-toggle.e2e.test.ts`
- Modify: `app/test/_fake-helper.mjs` if the start payload needs asserting

The point of this task is that Tasks 1-3 are each individually plausible and jointly untested. The loader gap in 4b was exactly this shape: every piece looked right, and nothing exercised the whole path.

- [ ] **Step 1: The toggle persists across an app restart.** Launch, tick it, close, relaunch with the same `userData`, assert it is still ticked.

- [ ] **Step 2: `start` carries `camera: true` when the toggle is on.** Drive the real `recorder:start` against `_fake-helper.mjs` and assert the payload — the flag reaching the helper is the whole feature, and nothing else checks it.

- [ ] **Step 3: A camera take previews with a visible PiP.** Extend the `fixtures/pip` E2E from 4b: assert the PiP rectangle's pixels differ from the same take with `pip.enabled: false`. Identity is blind to a missing PiP — see the 4b plan.

- [ ] **Step 4: Verify and commit.**

---

### Task 5: hardware — a real take, and a sync NUMBER

**BLOCKED** on the physical camera: see STC-286. `Elgato Facecam 4K [USB2]` is not currently enumerated, and capture silently falls through to `Elgato Virtual Camera` at ~1 fps. Reconnect it and confirm with `system_profiler SPCameraDataType` before recording anything for this task.

- [ ] **Step 1: Record from the app with the toggle on.** Confirm the TCC prompt appears at a moment the user caused, and that the device closes on stop — the LED is the check.

- [ ] **Step 2: Preview it in the app.** The PiP must appear with no hand-written `project.json`. This is what Task 1 exists for.

- [ ] **Step 3: Measure the sync.** `scratch/avsync.cjs` and `scratch/clap.cjs` exist for this. Produce a camera-to-display alignment figure in milliseconds.

  "Looks in sync" is already established — the PiP was watched and confirmed on 2026-08-28. What is missing is a **number**, and a number is what the design spec asks for. Record it in `PHASE-2.md` with the take it came from, and say what it does not cover: one take, one camera, one machine.

- [ ] **Step 4: Update `CLAUDE.md` and close STC-232.**

## Self-review

**Spec coverage.** "App toggle (sticky)": Tasks 2-3. "Watch-and-confirm": already done 2026-08-28, recorded in `CLAUDE.md`. "A measured sync number": Task 5 Step 3. "Camera is opt-in, default off, sticky": Task 2 default plus Task 4 Step 1. "Device opens on start, closes on stop": unchanged in the helper, confirmed in Task 5 Step 1.

**Not covered, deliberately.** Adjustable PiP geometry — the spec calls fixed-corner the slice and "adjustable geometry is the follow-on". Writing `project.json` at record time — not needed once the default handles it, and it would put a write in the capture path.

**Ordering.** Tasks 1-4 need no camera and can land while STC-286 is open. Only Task 5 is blocked.
