# Camera PiP — Increments 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Camera TCC grant reaches the helper through a signed bundle, then teach the transform to place a fixed-corner PiP — both without writing any camera capture code.

**Architecture:** Increment 1 extends `tools/test-host` and the helper with camera *authorization reporting only* — no `AVCaptureSession`, no device opened. Increment 2 adds `anchors-2` / `project-2` schemas, teaches `render()` a per-track frame-selection rule with an explicit track end, and validates it against a hand-authored fixture with no capture involved.

**Tech Stack:** Swift 5.8 (MacOSX13.3 SDK, no Xcode), TypeScript, vitest, ajv.

## Global Constraints

- Build the helper with `helper/build.sh`, never `swift build` — SwiftPM cannot resolve without full Xcode.
- Swift target is `arm64-apple-macos13.0` against `xcrun --show-sdk-path`. macOS 14+ API is unavailable except via KVC.
- All times are integer nanoseconds. No float seconds anywhere in the transform.
- `render(project, session, t)` stays pure: no wall clock, no decoder scheduling, no live stats, no current display state.
- Frame selection is always "greatest PTS ≤ t; hold, never interpolate", applied per track.
- Tests needing a TCC grant live in a `*.grant.test.ts` file excluded from `npm test` — a separate file, never a `skip`.
- Every wait gets a bound and a reason; use `withTimeout(p, ms, what)` from `transform/src/timeout.ts`.
- `npm test` must be green at the end of every task.

## Cross-increment hazard (read before starting Task 4)

Increment 2 introduces `anchors-2` / `project-2`, but the helper does not emit
version 2 until increment 3. If the loader simply required version 2, every
grant test would break in the gap between increments.

**Therefore the loader accepts version 1 *and* 2 and normalises v1 to v2
in memory** (camera absent, pip absent). `fixtures/basic` deliberately stays at
version 1 so that back-compatibility is a tested property rather than an
intention. Do not "tidy" the fixture to v2.

---

### Task 1: Test-host reports camera authorization

The bundle is where the Camera grant is anchored — `CFBundleIdentifier` is
load-bearing exactly as it is for Screen Recording. Without
`NSCameraUsageDescription` the prompt never appears and access fails silently,
which reads exactly like a broken device.

**Files:**
- Modify: `tools/test-host/STCTestHost.app/Contents/Info.plist`
- Modify: `tools/test-host/main.swift` (`runProbe`, around line 53)
- Test: `tools/test-host/` is exercised by Task 3; this task's verification is manual and scripted below.

**Interfaces:**
- Consumes: nothing.
- Produces: `--probe` JSON gains `cameraAuth: "notDetermined" | "restricted" | "denied" | "authorized"` and `cameraDevices: [String]`.

- [ ] **Step 1: Add the usage description to Info.plist**

Insert before `</dict>`:

```xml
  <key>NSCameraUsageDescription</key>
  <string>STC records a camera picture-in-picture alongside the screen.</string>
```

- [ ] **Step 2: Report camera state from the probe**

In `tools/test-host/main.swift`, add `import AVFoundation` at the top if absent, then inside `runProbe()` extend the dictionary. Replace the `var o: [String: Any] = [...]` statement with:

```swift
        // Camera is a SEPARATE grant from Screen Recording and from Input
        // Monitoring. authorizationStatus does not prompt; it reports.
        let camAuth: String
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:    camAuth = "authorized"
        case .denied:        camAuth = "denied"
        case .restricted:    camAuth = "restricted"
        case .notDetermined: camAuth = "notDetermined"
        @unknown default:    camAuth = "unknown"
        }
        let cams = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
            mediaType: .video, position: .unspecified).devices.map { $0.localizedName }

        var o: [String: Any] = ["verdict": n > 0 ? "granted" : "denied", "granted": n > 0,
                                "preflight": preflight, "displays": n,
                                "inputMonitoring": hidName,
                                "cameraAuth": camAuth, "cameraDevices": cams]
```

- [ ] **Step 3: Build and run the probe**

Run:
```bash
tools/test-host/build.sh && open -W tools/test-host/STCTestHost.app --args --probe --out /tmp/probe.json && cat /tmp/probe.json
```
Expected: JSON containing `"cameraAuth"` and `"cameraDevices"`. `cameraAuth` will be `"notDetermined"` on a machine that has never granted it — that is a pass for this step. The point is that the field exists and the bundle did not crash.

- [ ] **Step 4: Commit**

```bash
git add tools/test-host/main.swift tools/test-host/STCTestHost.app/Contents/Info.plist
git commit -m "STC-232: test-host probe reports camera authorization

Camera is a separate TCC grant from Screen Recording, keyed to the bundle
identifier. NSCameraUsageDescription is required or the prompt never appears
and access fails silently, which is indistinguishable from a broken device."
```

---

### Task 2: Helper reports its inherited camera authorization

The helper is a bare CLI binary and inherits the TCC identity of whatever
launched it. That is the property this whole increment exists to verify, and it
must be observable from the helper itself — not inferred from the bundle.

This task opens **no device**. It reports status only.

**Files:**
- Modify: `helper/src/main.swift` (command dispatch)
- Test: `helper/test/camera-probe.test.ts` (create)

**Interfaces:**
- Consumes: the existing JSON-line command dispatch and `IO.send`.
- Produces: command `{"cmd":"camera-probe"}` → reliable reply `{"ev":"camera-probe","auth":"<status>","devices":[String],"seq":N}`.

- [ ] **Step 1: Write the failing test**

Create `helper/test/camera-probe.test.ts`:

```typescript
import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const BIN = join(__dirname, "..", "build", "stc-helper");
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) { try { p.kill("SIGKILL"); } catch { /* gone */ } } });

const VALID = ["notDetermined", "restricted", "denied", "authorized", "unknown"];

describe("camera-probe", () => {
  // Reports only. Opening a device here would light the LED during `npm test`.
  test("answers with a valid authorization status and a device list", async () => {
    const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    live.push(proc);
    proc.stderr!.resume();

    const reply = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no camera-probe reply within 10s")), 10_000);
      let buf = "";
      proc.stdout!.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ev === "ready") proc.stdin!.write(JSON.stringify({ cmd: "camera-probe", seq: 1 }) + "\n");
          if (msg.ev === "camera-probe") { clearTimeout(timer); resolve(msg); }
        }
      });
      proc.stdout!.resume();
    });

    expect(VALID, `unexpected auth: ${reply.auth}`).toContain(reply.auth);
    expect(Array.isArray(reply.devices)).toBe(true);
    expect(reply.seq).toBe(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run helper/test/camera-probe.test.ts`
Expected: FAIL — "no camera-probe reply within 10s", because the command does not exist yet.

- [ ] **Step 3: Implement the command**

In `helper/src/main.swift`, ensure `import AVFoundation` is present, then add a case to the command dispatch alongside the existing `status` case:

```swift
        case "camera-probe":
            // Status only — never opens a device. Opening one here would light
            // the camera LED on every `npm test` run.
            let auth: String
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:    auth = "authorized"
            case .denied:        auth = "denied"
            case .restricted:    auth = "restricted"
            case .notDetermined: auth = "notDetermined"
            @unknown default:    auth = "unknown"
            }
            let devices = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
                mediaType: .video, position: .unspecified).devices.map { $0.localizedName }
            IO.send("camera-probe", ["auth": auth, "devices": devices], seq: seq)
```

If the existing dispatch passes `seq` differently, match the `status` case exactly rather than the snippet above.

- [ ] **Step 4: Rebuild and run the test**

Run: `helper/build.sh && npx vitest run helper/test/camera-probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all green, one test more than before.

- [ ] **Step 6: Commit**

```bash
git add helper/src/main.swift helper/test/camera-probe.test.ts
git commit -m "STC-232: helper reports its inherited camera authorization

The helper inherits the TCC identity of the bundle that launched it, so the
grant must be observable from the helper itself rather than inferred from the
bundle. Status only: opening a device would light the LED during npm test."
```

---

### Task 3: Prove the grant reaches the helper through the bundle

This is the increment's actual deliverable, and the reason it is sequenced
first: if the Camera grant cannot be made to reach the helper, increments 3–5
are wasted work.

**Files:**
- Test: `helper/test/camera.grant.test.ts` (create)
- Modify: `tools/test-host/main.swift` — add a `--camera-probe` mode that launches the helper and relays its reply

**Interfaces:**
- Consumes: Task 1's probe JSON; Task 2's `camera-probe` command.
- Produces: `--camera-probe --helper <bin> --out <json>` → `{"helperAuth": "<status>", "helperDevices": [...]}`.

- [ ] **Step 1: Add the relay mode to the test host**

In `tools/test-host/main.swift`, add a function modelled on the existing `runSession` (reuse its pipe-reading pattern verbatim rather than inventing a new one):

```swift
/// Launches the helper as a child of THIS bundle and asks it what camera
/// authorization it sees. The answer is the whole point: a bare CLI binary
/// inherits the launching bundle's TCC identity, and that is what ships.
func runCameraProbe(helper: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: helper)
    let inPipe = Pipe(), outPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = FileHandle.nullDevice
    try? p.run()

    inPipe.fileHandleForWriting.write("{\"cmd\":\"camera-probe\",\"seq\":1}\n".data(using: .utf8)!)

    var buf = Data()
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
        let d = outPipe.fileHandleForReading.availableData
        if d.isEmpty { break }
        buf.append(d)
        while let nl = buf.firstIndex(of: 0x0A) {
            let line = buf.subdata(in: buf.startIndex..<nl)
            buf.removeSubrange(buf.startIndex...nl)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  obj["ev"] as? String == "camera-probe" else { continue }
            writeResult(["helperAuth": obj["auth"] as? String ?? "missing",
                         "helperDevices": obj["devices"] as? [String] ?? []])
            p.terminate()
            exit(0)
        }
    }
    writeResult(["helperAuth": "timeout", "helperDevices": [String]()])
    p.terminate()
    exit(1)
}
```

Wire it in beside the existing `--probe` dispatch (near line 161):

```swift
    if args.contains("--camera-probe"), let h = value(for: "--helper") { runCameraProbe(helper: h); return }
```

Use whatever argument-reading helper `runSession` already uses instead of `value(for:)` if the name differs.

- [ ] **Step 2: Write the grant-gated test**

Create `helper/test/camera.grant.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

describe("camera grant — requires Camera access for STCTestHost", () => {
  // The property under test is inheritance: a bare CLI binary takes the TCC
  // identity of the bundle that launched it. Terminal-testing the helper proves
  // nothing about the shipped app, which is why this goes through the bundle.
  test("the helper inherits Camera authorization from the launching bundle", () => {
    const out = join(mkdtempSync(join(tmpdir(), "stc-cam-")), "result.json");
    execFileSync("open", ["-W", APP, "--args", "--camera-probe", "--helper", HELPER, "--out", out]);
    const result = JSON.parse(readFileSync(out, "utf8"));

    if (result.helperAuth === "notDetermined" || result.helperAuth === "denied") {
      throw new Error(
        `SKIP-GRANT: STCTestHost has no Camera grant (helperAuth=${result.helperAuth}). ` +
        `Grant Camera to STC Signing Probe in System Settings > Privacy & Security > Camera, ` +
        `then re-run. Until then the camera path is unverified.`,
      );
    }
    expect(result.helperAuth).toBe("authorized");
    expect(Array.isArray(result.helperDevices)).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 3: Confirm it is excluded from the default suite**

Run: `npm test`
Expected: `camera.grant.test.ts` does NOT appear in the output. If it does, add the exclusion to `vitest.config.ts` beside the existing `*.grant.test.ts` rule.

- [ ] **Step 4: Run the grant suite**

Run: `tools/test-host/build.sh && helper/build.sh && npm run test:capture`
Expected on a machine without the grant: a clear `SKIP-GRANT:` failure naming the exact System Settings path. Grant Camera to **STC Signing Probe**, re-run, and expect PASS with `helperAuth: "authorized"`.

**This is the increment's gate.** If `helperAuth` stays `notDetermined` after granting, stop and report it — that means inheritance does not work for Camera the way it does for Screen Recording, and increments 3–5 need redesigning.

- [ ] **Step 5: Commit**

```bash
git add tools/test-host/main.swift helper/test/camera.grant.test.ts
git commit -m "STC-232: prove Camera authorization reaches the helper via the bundle

Increment 1's gate. A bare CLI binary inherits the launching bundle's TCC
identity; terminal-testing the helper proves nothing about the shipped app.
If this cannot pass, increments 3-5 need redesigning, which is why it is first."
```

---

### Task 4: `anchors-2` and `project-2` schemas

**Files:**
- Create: `schema/anchors-2.schema.json`
- Create: `schema/project-2.schema.json`
- Create: `fixtures/pip/anchors.json`, `fixtures/pip/events.json`, `fixtures/pip/project.json`, `fixtures/pip/frames.json`, `fixtures/pip/camera-frames.json`
- Modify: `transform/test/schema.test.ts`

**Interfaces:**
- Produces: `anchors.camera?: { present, device, width, height, firstFramePtsNs, lastFramePtsNs, frameIntervalNs }`, `anchors.files.camera?: string`, `project.pip?: { enabled, corner, widthPct, marginPx }`.

- [ ] **Step 1: Write the failing schema tests**

Append to `transform/test/schema.test.ts`:

```typescript
describe("v2 schemas carry the camera track and PiP geometry", () => {
  test("the pip fixture's anchors conform to anchors-2", () => {
    const validate = compile("schema/anchors-2.schema.json");
    const ok = validate(load("fixtures/pip/anchors.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("the pip fixture's project conforms to project-2", () => {
    const validate = compile("schema/project-2.schema.json");
    const ok = validate(load("fixtures/pip/project.json"));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("project-2 rejects a corner it does not implement", () => {
    const validate = compile("schema/project-2.schema.json");
    const doc = clone(load("fixtures/pip/project.json"));
    doc.pip.corner = "top-left";
    expect(validate(doc)).toBe(false);
  });

  test("anchors-2 rejects a camera block missing frameIntervalNs", () => {
    // The transform bounds the PiP's track end with this value. Without it the
    // bound would have to be assumed, and the measured camera rate varies.
    const validate = compile("schema/anchors-2.schema.json");
    const doc = clone(load("fixtures/pip/anchors.json"));
    delete doc.camera.frameIntervalNs;
    expect(validate(doc)).toBe(false);
  });

  test("a v1 document is not a v2 document", () => {
    const validate = compile("schema/anchors-2.schema.json");
    expect(validate(load("fixtures/basic/anchors.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run transform/test/schema.test.ts`
Expected: FAIL — the schema files and the fixture do not exist yet.

- [ ] **Step 3: Write `schema/project-2.schema.json`**

Copy `project-1.schema.json`, change `$id` to `stc:project-2`, change `version` to `{ "const": 2 }`, and add to `properties`:

```json
    "pip": {
      "type": "object",
      "additionalProperties": false,
      "required": ["enabled", "corner", "widthPct", "marginPx"],
      "description": "Fixed-corner picture-in-picture. Absent means no PiP.",
      "properties": {
        "enabled": { "type": "boolean" },
        "corner": { "enum": ["bottom-right"], "description": "only corner implemented in phase 3" },
        "widthPct": { "type": "number", "exclusiveMinimum": 0, "maximum": 1,
                      "description": "fraction of output width; 0.125 gives 480px on a 3840px canvas" },
        "marginPx": { "type": "integer", "minimum": 0 }
      }
    }
```

Leave `pip` out of `required` — absent means no PiP.

- [ ] **Step 4: Write `schema/anchors-2.schema.json`**

Copy `anchors-1.schema.json`, change `$id` to `stc:anchors-2`, change `version` to `{ "const": 2 }`, add `"camera"` to `properties` (not to `required`), and add an optional `camera` string to the `files` object:

```json
    "camera": {
      "type": "object",
      "additionalProperties": false,
      "required": ["present", "device", "width", "height",
                   "firstFramePtsNs", "lastFramePtsNs", "frameIntervalNs"],
      "properties": {
        "present": { "type": "boolean" },
        "device": { "type": "string" },
        "width": { "type": "integer", "minimum": 1 },
        "height": { "type": "integer", "minimum": 1 },
        "firstFramePtsNs": { "type": "integer", "minimum": 0 },
        "lastFramePtsNs": { "type": "integer", "minimum": 0 },
        "frameIntervalNs": { "type": "integer", "minimum": 1,
                             "description": "median inter-frame delta; the transform bounds the track end with it" }
      }
    }
```

- [ ] **Step 5: Hand-author `fixtures/pip/`**

`fixtures/pip/events.json` — copy `fixtures/basic/events.json` verbatim.

`fixtures/pip/project.json`:
```json
{
  "version": 2,
  "output": { "fps": 60, "width": 3840, "height": 2160 },
  "cursor": { "style": "default", "scale": 1 },
  "pip": { "enabled": true, "corner": "bottom-right", "widthPct": 0.125, "marginPx": 32 }
}
```

`fixtures/pip/anchors.json` — copy `fixtures/basic/anchors.json`, set `"version": 2`, and add:
```json
  "camera": {
    "present": true,
    "device": "Fixture Camera",
    "width": 1280,
    "height": 720,
    "firstFramePtsNs": 1035500000,
    "lastFramePtsNs": 3024500000,
    "frameIntervalNs": 17000000
  }
```

`fixtures/pip/frames.json` — copy `fixtures/basic/frames.json` verbatim. This is
the display PTS grid; `render.test.ts` loads it directly rather than demuxing.

`fixtures/pip/camera-frames.json` — the camera PTS grid, 118 entries starting at
the warm-up offset and spaced by `frameIntervalNs`. Generate it exactly:

```bash
python3 -c "
import json
first, iv, n = 1035500000, 17000000, 118
json.dump([first + k*iv for k in range(n)], open('fixtures/pip/camera-frames.json','w'))
print(first, first+(n-1)*iv)"
```
Expected output: `1035500000 3024500000`. That last value MUST equal
`anchors.camera.lastFramePtsNs` — the track-end test in Task 6 depends on the
grid and the anchor agreeing.

The camera starts at 1.0355 s on purpose: that is the warm-up gap phase 0
measured, so the fixture exercises the empty window rather than a convenient
zero.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run transform/test/schema.test.ts`
Expected: PASS, all five new tests.

- [ ] **Step 7: Commit**

```bash
git add schema/anchors-2.schema.json schema/project-2.schema.json fixtures/pip transform/test/schema.test.ts
git commit -m "STC-232: anchors-2 and project-2 carry the camera track and PiP geometry

frameIntervalNs is required, not optional: the transform bounds the PiP's
track end with it, and the measured camera rate varies run to run, so an
assumed nominal rate would be wrong in a way nothing would catch."
```

---

### Task 5: Types and a loader that accepts v1 and v2

**Files:**
- Modify: `transform/src/types.ts`
- Modify: `transform/src/session.ts:40-45`
- Test: `transform/test/session.test.ts`

**Interfaces:**
- Consumes: Task 4's schemas.
- Produces: `CameraTrack`, `Pip`; `Anchors.version: 1 | 2`, `Anchors.camera?: CameraTrack`; `Project.version: 1 | 2`, `Project.pip?: Pip`; `Session.cameraFrames?: number[]`.

- [ ] **Step 1: Write the failing test**

Append to `transform/test/session.test.ts`:

```typescript
describe("loader accepts v1 and v2 anchors", () => {
  // The helper does not emit v2 until increment 3. A loader that demanded v2
  // would break every grant test in the gap between increments.
  test("a version 1 anchors document still loads", async () => {
    const input = await basicInput();          // existing helper in this file
    input.anchors.version = 1;
    await expect(loadSession(input)).resolves.toBeDefined();
  });

  test("a version 2 anchors document loads", async () => {
    const input = await basicInput();
    input.anchors.version = 2;
    await expect(loadSession(input)).resolves.toBeDefined();
  });

  test("a version 3 anchors document is rejected by name", async () => {
    const input = await basicInput();
    (input.anchors as any).version = 3;
    await expect(loadSession(input)).rejects.toThrow(/version 3 is not supported/);
  });
});
```

If `session.test.ts` has no `basicInput()` helper, reuse whatever fixture-loading helper it already defines and adapt these three tests to it — do not add a second loading path.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run transform/test/session.test.ts`
Expected: FAIL on the v2 case — "anchors.json version 2 is not supported (expected 1)".

- [ ] **Step 3: Extend the types**

In `transform/src/types.ts`, add:

```typescript
/** Mirrors the optional `camera` block in schema/anchors-2.schema.json. */
export interface CameraTrack {
  present: boolean;
  device: string;
  width: number;
  height: number;
  firstFramePtsNs: number;
  lastFramePtsNs: number;
  /** median inter-frame delta; bounds the track end (see render()) */
  frameIntervalNs: number;
}

/** Mirrors the optional `pip` block in schema/project-2.schema.json. */
export interface Pip {
  enabled: boolean;
  corner: "bottom-right";
  widthPct: number;
  marginPx: number;
}
```

Change `Anchors.version` to `1 | 2`, add `camera?: CameraTrack`, change `files` to `{ display: string; camera?: string }`. Change `Project.version` to `1 | 2` and add `pip?: Pip`. Add `cameraFrames?: number[]` to `Session`.

- [ ] **Step 4: Widen the loader's version check**

In `transform/src/session.ts`, replace the two version guards with:

```typescript
  // v1 and v2 differ only by additions the transform treats as optional
  // (camera track, pip geometry), so v1 loads as a v2 with both absent. The
  // helper does not emit v2 until increment 3; refusing v1 here would break
  // every grant test in the gap.
  if (anchors?.version !== 1 && anchors?.version !== 2) {
    throw new SessionLoadError(`anchors.json version ${anchors?.version} is not supported (expected 1 or 2)`);
  }
  if (events?.version !== 1) {
    throw new SessionLoadError(`events.json version ${events?.version} is not supported (expected 1)`);
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run transform/test/session.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add transform/src/types.ts transform/src/session.ts transform/test/session.test.ts
git commit -m "STC-232: types and loader accept v1 and v2 sessions

v1 loads as a v2 with camera and pip absent. The helper does not emit v2 until
increment 3, so a loader that demanded v2 would break the grant tests in the
gap between increments."
```

---

### Task 6: `render()` places the PiP, and knows when the track ends

The one genuinely new rule in this phase. "Greatest PTS ≤ t, hold" is correct
for gaps *within* a track and wrong at the *end* of one: a camera unplugged
30 s into a 60 s take would otherwise freeze a face on screen for the
remaining 30 s.

**Files:**
- Modify: `transform/src/render.ts`
- Test: `transform/test/render.test.ts`

**Interfaces:**
- Consumes: `frameIndexAt` from `./time.js`; `CameraTrack`, `Pip` from Task 5.
- Produces: `FrameState.pip: PipState | null`, where
  `PipState = { frameIndex: number; framePtsNs: number; x: number; y: number; width: number; height: number }`.

- [ ] **Step 1: Write the failing tests**

First add these two helpers to `transform/test/render.test.ts`, beside the
existing `fixtureSession()` / `fixtureProject()` (which load `fixtures/basic`
the same way — follow that pattern exactly, do not introduce `loadSession`):

```typescript
function pipSession(): { project: Project; session: Session } {
  return {
    project: load("fixtures/pip/project.json"),
    session: {
      anchors: load("fixtures/pip/anchors.json"),
      events: load("fixtures/pip/events.json").events,
      frames: load("fixtures/pip/frames.json"),
      cameraFrames: load("fixtures/pip/camera-frames.json"),
    },
  };
}
const basicSession = () => ({ project: fixtureProject(), session: fixtureSession() });
```

Then append:

```typescript
describe("PiP placement and track bounds", () => {
  const CAM_FIRST = 1_035_500_000;
  const CAM_LAST = 3_024_500_000;
  const CAM_INTERVAL = 17_000_000;

  test("no PiP before the camera's first frame", () => {
    const { project, session } = pipSession();
    expect(render(project, session, CAM_FIRST - 1).pip).toBeNull();
  });

  test("PiP appears at the camera's first frame", () => {
    const { project, session } = pipSession();
    const pip = render(project, session, CAM_FIRST).pip;
    expect(pip).not.toBeNull();
    expect(pip!.framePtsNs).toBe(CAM_FIRST);
  });

  test("PiP sits in the bottom-right corner at the configured size", () => {
    const { project, session } = pipSession();   // 3840x2160, widthPct 0.125, margin 32
    const pip = render(project, session, CAM_FIRST).pip!;
    expect(pip.width).toBe(480);                 // 3840 * 0.125
    expect(pip.height).toBe(270);                // 480 * 720/1280
    expect(pip.x).toBe(3840 - 480 - 32);
    expect(pip.y).toBe(2160 - 270 - 32);
  });

  test("the PiP holds the last frame at or before t, never interpolating", () => {
    const { project, session } = pipSession();
    const justBeforeSecond = CAM_FIRST + CAM_INTERVAL - 1;
    expect(render(project, session, justBeforeSecond).pip!.framePtsNs).toBe(CAM_FIRST);
  });

  test("the PiP disappears after the track ends rather than freezing", () => {
    // A camera unplugged mid-take must not leave a frozen face on screen for
    // the rest of the recording. Track end is lastFramePtsNs + frameIntervalNs.
    const { project, session } = pipSession();
    expect(render(project, session, CAM_LAST).pip).not.toBeNull();
    expect(render(project, session, CAM_LAST + CAM_INTERVAL).pip).not.toBeNull();
    expect(render(project, session, CAM_LAST + CAM_INTERVAL + 1).pip).toBeNull();
  });

  test("no PiP when the project disables it", () => {
    const { project, session } = pipSession();
    const off = { ...project, pip: { ...project.pip!, enabled: false } };
    expect(render(off, session, CAM_FIRST).pip).toBeNull();
  });

  test("no PiP for a v1 session that has no camera at all", () => {
    const { project, session } = basicSession();
    expect(render(project, session, 2_000_000_000).pip).toBeNull();
  });

  test("PiP placement is identical whether reached by stepping or seeking", () => {
    // The determinism property the two sinks depend on. render() memoises the
    // cursor sim per Session, so the comparison must be against a SEPARATELY
    // loaded session with a cold cache — comparing two renders of the same
    // warmed session would pass no matter what the cache did.
    const t = CAM_FIRST + 40 * CAM_INTERVAL;

    const cold = pipSession();
    const seeked = render(cold.project, cold.session, t).pip;

    const warm = pipSession();
    for (let u = 0; u < t; u += 8_333_333) render(warm.project, warm.session, u);
    const stepped = render(warm.project, warm.session, t).pip;

    expect(stepped).toEqual(seeked);
    expect(seeked).not.toBeNull();   // a test comparing two nulls proves nothing
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run transform/test/render.test.ts`
Expected: FAIL — `pip` is not a property of `FrameState`.

- [ ] **Step 3: Implement**

In `transform/src/render.ts`, add to the imports:

```typescript
import type { CursorState, Project, Session } from "./types.js";
```
(already present — add `Pip`/`CameraTrack` only if you reference the types directly).

Add the interface and helper above `render()`:

```typescript
export interface PipState {
  frameIndex: number;
  framePtsNs: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The PiP is drawn only while the camera track actually exists.
 *
 * "Greatest PTS <= t, hold" is right for gaps inside a track and wrong at its
 * end: a camera lost mid-take would otherwise hold its last frame for the rest
 * of the recording, leaving a frozen face on screen. Both bounds come from
 * anchors.camera, never from an assumed frame rate — the measured camera rate
 * varies run to run.
 */
function pipStateAt(project: Project, session: Session, tNs: number): PipState | null {
  const pip = project.pip;
  const cam = session.anchors.camera;
  const frames = session.cameraFrames;
  if (!pip?.enabled || !cam?.present || !frames?.length) return null;

  if (tNs < cam.firstFramePtsNs) return null;
  if (tNs > cam.lastFramePtsNs + cam.frameIntervalNs) return null;

  const frameIndex = frameIndexAt(frames, tNs);
  if (frameIndex === null) return null;

  const width = Math.round(project.output.width * pip.widthPct);
  const height = Math.round((width * cam.height) / cam.width);
  return {
    frameIndex,
    framePtsNs: frames[frameIndex]!,
    x: project.output.width - width - pip.marginPx,
    y: project.output.height - height - pip.marginPx,
    width,
    height,
  };
}
```

Add `pip: PipState | null;` to the `FrameState` interface with the comment `/** camera picture-in-picture, or null when there is none to draw */`, and add `pip: pipStateAt(project, session, tNs),` to the returned object.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run transform/test/render.test.ts`
Expected: PASS, all eight new tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add transform/src/render.ts transform/test/render.test.ts
git commit -m "STC-232: render() places the PiP and bounds it to the camera track

Adds the one rule this phase needs that the codebase did not already have: a
track ending is not a gap. Holding the last frame past the end of the camera
track would leave a frozen face on screen for the rest of the take, which reads
as a rendering bug. Both bounds come from anchors.camera, never an assumed rate."
```

---

## What these increments deliberately do NOT do

- No `AVCaptureSession`, no device opened, no `camera.mp4` written. That is increment 3.
- No compositor or sink changes — `FrameState.pip` is produced and not yet drawn. That is increment 4.
- No app toggle. That is increment 5.

`render()` returning a correct `pip` that nothing draws yet is the intended
end state: the transform defines the contract, and the helper and sinks are
producers and consumers to it.

## Self-review notes

- **Spec coverage:** increments 1 and 2 of the design are covered by Tasks 1–3 and 4–6 respectively. Increments 3–5 (capture, sinks, app toggle) are explicitly out of scope and listed above.
- **Deferred from the spec, on purpose:** the spec's per-track empty-edit handling and the `fixtures/offset/` camera sibling belong to increment 3, where a real `camera.mp4` first exists — there is nothing to demux until then.
- **Type consistency:** `frameIntervalNs`, `firstFramePtsNs`, `lastFramePtsNs`, `widthPct`, `marginPx`, and `corner` are spelled identically in the schemas (Task 4), the types (Task 5), and `render()` (Task 6).
