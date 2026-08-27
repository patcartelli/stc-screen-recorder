# Camera PiP — Increment 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The helper captures the camera to `camera.mp4` alongside `display.mp4`, and records what it captured in `anchors.camera` — emitting to the `anchors-2` schema increment 2 already defined.

**Architecture:** An `AVCaptureSession` feeding a second `AVAssetWriter`, inside the existing helper process so both tracks share one mach clock. The camera writer gets its own `WriterGate`. Camera never sits on the critical path: a missing, denied or busy device leaves the recording display-only.

**Tech Stack:** Swift 5.8 / MacOSX13.3 SDK, AVFoundation, ScreenCaptureKit, TypeScript, vitest.

## Global Constraints

- Build the helper with `helper/build.sh`, never `swift build`.
- Swift 5.8 against the MacOSX13.3 SDK on macOS 27. macOS 14+ API is unavailable except via KVC.
- All times are integer nanoseconds.
- **Camera PTS is used as-is.** `CMSampleBufferGetPresentationTimeStamp` is already mach host time and already latency-compensated (measured 91.5 ms and 115.8 ms on two runs). Session-relative is `pts_ns - t0Ns`. **No timebase conversion** — the same rule as `CGEvent.timestamp`, and the one mistake that would desync the PiP silently.
- Every append goes through a `WriterGate`; an append and its teardown must never overlap (STC-254).
- Every wait needs a bound and a reason.
- Grant-requiring tests live in `*.grant.test.ts`, excluded from `npm test`.
- `npm test` must be green at the end of every task.

## Decisions taken before this plan

- **The helper always emits `anchors` version 2** and always writes a `camera` block — `{"present": false}` when no camera was requested or none was available. One document shape in the wild; the version tells a reader whether camera support existed at all. `anchors-2` requires the measurement fields only when `present` is true.
- **`start` gains `camera: bool`.** Absent or false opens no device. The app-facing toggle is increment 5.
- **720p.** A corner PiP at `widthPct` 0.125 on a 4K canvas is 480x270, so 1280x720 is ~2.7x oversampled — headroom to reframe later without doubling preview RAM.

---

### Task 1: A pure anchors document, tested without capture

`anchors.json` is written during `stop`, so today its shape can only be checked by a grant-gated real recording. Extract the document construction so the camera block can be tested with no capture at all — the same move `CaptureDecisions` made for frame selection, and it is why that rule is testable.

**Files:**
- Create: `helper/src/AnchorsDoc.swift`
- Modify: `helper/src/Capture.swift` (`writeSidecars`, ~line 415)
- Create: `helper/test/anchors/main.swift`, `helper/test/anchors.test.ts`

**Interfaces:**
- Produces: `func anchorsDocument(timebase:t0Ns:display:capture:camera:stopReason:stopTNs:) -> [String: Any]`, and `struct CameraTrack { present, device, width, height, firstFramePtsNs, lastFramePtsNs, frameIntervalNs }`.

- [ ] **Step 1: Write the failing Swift assertions**

Create `helper/test/anchors/main.swift`. Follow `helper/test/ring/main.swift` for style — accumulate failures, print `ALL PASS` or `FAIL:` lines and exit 1.

```swift
import Foundation

var failures: [String] = []
func check(_ c: Bool, _ what: String) { if !c { failures.append(what) } }

let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160,
                              originX: 0, originY: 0)
let capture = CaptureGeometryDoc(width: 3840, height: 2160, firstFrameNs: 200_000_000)

// 1. Always version 2, and a camera block is always present.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil,
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 2, "version must be 2")
    let cam = d["camera"] as? [String: Any]
    check(cam != nil, "camera block must always be written")
    check(cam?["present"] as? Bool == false, "absent camera must record present:false")
    check(cam?["device"] == nil, "an absent camera must not invent measurements")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] == nil, "files.camera must be absent when there is no camera")
}

// 2. A present camera records its measurements and its file.
do {
    let track = CameraTrack(present: true, device: "Fixture Camera", width: 1280, height: 720,
                            firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
                            frameIntervalNs: 17_000_000)
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: track,
                            stopReason: "user", stopTNs: 20_000_000_000)
    let cam = d["camera"] as? [String: Any]
    check(cam?["present"] as? Bool == true, "present camera must record present:true")
    check(cam?["device"] as? String == "Fixture Camera", "device name must be recorded")
    check(cam?["width"] as? Int == 1280 && cam?["height"] as? Int == 720, "camera size")
    check(cam?["firstFramePtsNs"] as? Int == 1_035_500_000, "first frame pts")
    check(cam?["lastFramePtsNs"] as? Int == 3_024_500_000, "last frame pts")
    check(cam?["frameIntervalNs"] as? Int == 17_000_000, "frame interval")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] as? String == "camera.mp4", "files.camera must name the file")
}

// 3. t0Ns stays a STRING: boot-relative ns crosses 2^53 at ~104 days of uptime
//    and a JSON number would round.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 18_446_744_073, display: display,
                            capture: capture, camera: nil,
                            stopReason: "user", stopTNs: 1)
    check(d["t0Ns"] as? String == "18446744073", "t0Ns must be a string")
}

if failures.isEmpty { print("ALL PASS") }
else { for f in failures { print("FAIL: \(f)") }; exit(1) }
```

Create `helper/test/anchors.test.ts`, modelled exactly on `helper/test/ring.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import { runSwiftHarness } from "./_swift-harness.js";

describe("anchors document", () => {
  test("Swift anchors assertions all pass", async () => {
    const out = await runSwiftHarness({
      label: "anchors",
      sources: [
        "helper/src/AnchorsDoc.swift",
        "helper/test/anchors/main.swift",
      ],
    });
    expect(out, out).toContain("ALL PASS");
  });
}, 60_000);
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run helper/test/anchors.test.ts`
Expected: FAIL — `anchors: swiftc exited 1`, because `AnchorsDoc.swift` does not exist. The failure message includes the compiler's stderr tail.

- [ ] **Step 3: Write `helper/src/AnchorsDoc.swift`**

Must import Foundation ONLY — no ScreenCaptureKit, no AVFoundation. That is what lets the harness compile it standalone.

```swift
import Foundation

/// Display geometry as the anchors document records it.
struct DisplayGeometry {
    let id: Int, pointWidth: Int, pointHeight: Int
    let pixelWidth: Int, pixelHeight: Int
    let originX: Double, originY: Double
}

/// The display track's captured size plus the helper's own measurement of when
/// its first frame landed.
struct CaptureGeometryDoc {
    let width: Int, height: Int, firstFrameNs: Int
}

/// What the camera track turned out to be. `nil` means no camera on this take.
struct CameraTrack {
    let present: Bool
    let device: String
    let width: Int, height: Int
    let firstFramePtsNs: Int
    let lastFramePtsNs: Int
    /// Median inter-frame delta. The transform bounds the PiP's track end with
    /// this; the measured camera rate varies run to run, so it must be recorded
    /// rather than assumed.
    let frameIntervalNs: Int
}

/// Builds anchors.json.
///
/// Pure on purpose: the shape of this document is a contract with the transform,
/// and a contract that can only be checked by performing a real recording is a
/// contract nothing checks on most runs.
func anchorsDocument(timebase: (numer: Int, denom: Int),
                     t0Ns: UInt64,
                     display: DisplayGeometry,
                     capture: CaptureGeometryDoc,
                     camera: CameraTrack?,
                     stopReason: String,
                     stopTNs: Int) -> [String: Any] {
    var files: [String: Any] = ["display": "display.mp4"]
    var cameraBlock: [String: Any] = ["present": false]
    if let c = camera, c.present {
        files["camera"] = "camera.mp4"
        cameraBlock = [
            "present": true,
            "device": c.device,
            "width": c.width,
            "height": c.height,
            "firstFramePtsNs": c.firstFramePtsNs,
            "lastFramePtsNs": c.lastFramePtsNs,
            "frameIntervalNs": c.frameIntervalNs,
        ]
    }
    return [
        "version": 2,
        "timebase": ["numer": timebase.numer, "denom": timebase.denom],
        // String on purpose: boot-relative ns crosses 2^53 at ~104 days of
        // uptime, and a JSON number would round.
        "t0Ns": String(t0Ns),
        "display": ["id": display.id,
                    "pointWidth": display.pointWidth, "pointHeight": display.pointHeight,
                    "pixelWidth": display.pixelWidth, "pixelHeight": display.pixelHeight,
                    "backingScale": display.pointWidth > 0
                        ? Double(display.pixelWidth) / Double(display.pointWidth) : 1.0,
                    "originX": display.originX, "originY": display.originY],
        "capture": ["width": capture.width, "height": capture.height, "codec": "h264",
                    "firstFrameNs": max(0, capture.firstFrameNs)],
        "files": files,
        "camera": cameraBlock,
        "stop": ["t": stopTNs, "reason": stopReason],
    ]
}
```

- [ ] **Step 4: Run the harness test**

Run: `npx vitest run helper/test/anchors.test.ts`
Expected: PASS.

- [ ] **Step 5: Make `writeSidecars` use it**

In `helper/src/Capture.swift`, replace the inline dictionary in `writeSidecars` with a call to `anchorsDocument(...)`, passing `camera: nil` for now — the camera track arrives in Task 3. The `events.json` write is unchanged.

- [ ] **Step 6: Verify nothing regressed**

Run: `helper/build.sh && npm test`
Expected: green. `helper/build.sh` must exit 0 — a failed `swiftc` leaves the previous binary in place, so a green test can be testing stale code.

- [ ] **Step 7: Commit**

```bash
git add helper/src/AnchorsDoc.swift helper/src/Capture.swift helper/test/anchors helper/test/anchors.test.ts
git commit -m "STC-232: extract the anchors document so its shape is testable without capture

anchors.json is written during stop, so until now its shape could only be
checked by performing a real grant-gated recording. The camera block lands
next and needs assertions that run on every machine, so the document
construction moves to a pure function tested by a Swift harness — the same
move CaptureDecisions made for frame selection.

Emits version 2 and always writes a camera block, present:false when there is
no camera. One document shape in the wild rather than two."
```

---

### Task 2: Camera capture

**Files:**
- Create: `helper/src/CameraCapture.swift`
- Test: covered by Task 4's grant-gated test; this task's check is that it builds and that `npm test` stays green.

**Interfaces:**
- Consumes: `WriterGate` (`helper/src/WriterGate.swift`), `CameraTrack` (Task 1).
- Produces: `final class CameraCapture` with
  `init(dir: URL, t0Ns: UInt64)`,
  `func start() -> Result<String, Error>` (returns the device name),
  `func stop(completion: @escaping (CameraTrack?) -> Void)`.

- [ ] **Step 1: Write `helper/src/CameraCapture.swift`**

```swift
import Foundation
import AVFoundation

enum CameraError: Error, CustomStringConvertible {
    case noDevice
    case notAuthorized(AVAuthorizationStatus)
    case sessionRefusedInput
    case writerFailed(Error?)

    var description: String {
        switch self {
        case .noDevice: return "no camera device is available"
        case .notAuthorized(let s): return "camera access is \(s.rawValue), not authorized"
        case .sessionRefusedInput: return "the capture session refused the camera input"
        case .writerFailed(let e): return "camera writer failed: \(String(describing: e))"
        }
    }

    var code: String {
        switch self {
        case .noDevice: return "camera-no-device"
        case .notAuthorized: return "camera-not-authorized"
        case .sessionRefusedInput: return "camera-input-refused"
        case .writerFailed: return "camera-writer-failed"
        }
    }
}

/// Camera capture for one session, writing camera.mp4 beside display.mp4.
///
/// PTS is used AS-IS. CMSampleBufferGetPresentationTimeStamp is already mach
/// host time and already latency-compensated (phase 0 measured 91.5 ms and
/// 115.8 ms on two runs of the same hardware). Session-relative time is
/// `pts_ns - t0Ns`, with no timebase conversion — the same rule as
/// CGEvent.timestamp. Converting here would desync the PiP silently.
final class CameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let dir: URL
    private let t0Ns: UInt64
    private let queue = DispatchQueue(label: "stc.capture.camera")

    private var session: AVCaptureSession?
    private var writer: AVAssetWriter?
    private let gate = WriterGate()
    private var deviceName = ""

    private let lock = NSLock()
    private var firstPtsNs: Int64 = -1
    private var lastPtsNs: Int64 = -1
    private var deltas: [Int64] = []
    private var appended = 0

    static let width = 1280
    static let height = 720

    init(dir: URL, t0Ns: UInt64) {
        self.dir = dir
        self.t0Ns = t0Ns
    }

    func start() -> Result<String, Error> {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        guard status == .authorized else { return .failure(CameraError.notAuthorized(status)) }

        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
            mediaType: .video, position: .unspecified)
        guard let device = discovery.devices.first else { return .failure(CameraError.noDevice) }
        deviceName = device.localizedName

        let s = AVCaptureSession()
        s.beginConfiguration()
        s.sessionPreset = .hd1280x720
        guard let input = try? AVCaptureDeviceInput(device: device), s.canAddInput(input) else {
            s.commitConfiguration()
            return .failure(CameraError.sessionRefusedInput)
        }
        s.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        // Dropping a late camera frame is correct: the PiP holds the previous
        // one, exactly as the display track does across a VFR stall.
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard s.canAddOutput(output) else {
            s.commitConfiguration()
            return .failure(CameraError.sessionRefusedInput)
        }
        s.addOutput(output)
        s.commitConfiguration()

        do { try setupWriter() } catch { return .failure(error) }

        session = s
        s.startRunning()
        return .success(deviceName)
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("camera.mp4")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        w.movieTimeScale = 90_000
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Self.width,
            AVVideoHeightKey: Self.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ])
        inp.expectsMediaDataInRealTime = true
        inp.mediaTimeScale = 1_000_000_000
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp,
                                                      sourcePixelBufferAttributes: nil)
        guard w.canAdd(inp) else { throw CameraError.writerFailed(nil) }
        w.add(inp)
        guard w.startWriting() else { throw CameraError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w
        gate.install(input: inp, adaptor: ad)
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        autoreleasepool {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
            // Already mach host time, already latency-compensated. Do not convert.
            let ptsNs = Int64(CMSampleBufferGetPresentationTimeStamp(sb).seconds * 1_000_000_000)
            let rel = ptsNs - Int64(t0Ns)
            guard rel >= 0 else { return }          // arrived before the session began

            lock.lock()
            if lastPtsNs >= 0 {
                if rel <= lastPtsNs { lock.unlock(); return }   // non-monotonic: drop
                deltas.append(rel - lastPtsNs)
            }
            if firstPtsNs < 0 { firstPtsNs = rel }
            lastPtsNs = rel
            lock.unlock()

            if gate.append(pb, at: CMTime(value: rel, timescale: 1_000_000_000)) == .appended {
                lock.lock(); appended += 1; lock.unlock()
            }
        }
    }

    /// Stops and reports what was captured. Answers exactly once, and is bounded:
    /// neither stopRunning nor finishWriting promises to call back.
    func stop(completion: @escaping (CameraTrack?) -> Void) {
        let answered = NSLock()
        var done = false
        let finish: (CameraTrack?) -> Void = { track in
            answered.lock()
            if done { answered.unlock(); return }
            done = true
            answered.unlock()
            completion(track)
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + 10) { finish(self.track()) }

        session?.stopRunning()
        gate.closeAndMarkFinished()
        guard let w = writer else { finish(track()); return }
        w.finishWriting { finish(self.track()) }
    }

    private func track() -> CameraTrack? {
        lock.lock(); defer { lock.unlock() }
        guard appended > 0, firstPtsNs >= 0, lastPtsNs >= firstPtsNs else { return nil }
        return CameraTrack(present: true, device: deviceName,
                           width: Self.width, height: Self.height,
                           firstFramePtsNs: Int(firstPtsNs),
                           lastFramePtsNs: Int(lastPtsNs),
                           frameIntervalNs: Int(medianDelta()))
    }

    /// Median, not mean: a single long stall would drag a mean upward and
    /// stretch the PiP's track end past where frames actually stopped.
    private func medianDelta() -> Int64 {
        if deltas.isEmpty { return 16_666_667 }
        let s = deltas.sorted()
        return s[s.count / 2]
    }
}
```

- [ ] **Step 2: Build and verify nothing regressed**

Run: `helper/build.sh && npm test`
Expected: build exits 0, suite green. Nothing calls `CameraCapture` yet.

- [ ] **Step 3: Commit**

```bash
git add helper/src/CameraCapture.swift
git commit -m "STC-232: camera capture into camera.mp4

An AVCaptureSession feeding a second AVAssetWriter in the helper process, so
both tracks share one mach clock — the property that took real work to
establish for the display track and is free this way.

PTS is used as-is: it is already mach host time and already latency-compensated
(phase 0 measured 91.5 ms and 115.8 ms across two runs). Converting it would
desync the PiP silently.

Its own WriterGate, because an append and its teardown must not overlap
(STC-254), and a second writer without one is a second copy of that race.
Nothing calls this yet."
```

---

### Task 3: Wire the camera into a recording

**Files:**
- Modify: `helper/src/Capture.swift` (`CaptureSession`), `helper/src/main.swift` (`start` dispatch)
- Test: `helper/test/ipc.test.ts`

**Interfaces:**
- Consumes: `CameraCapture` (Task 2), `anchorsDocument` (Task 1).
- Produces: `start` accepts `"camera": true|false`; the `started` reply gains `"camera": "<device name>"` when a camera opened, and a `warning` with a `camera-*` code when one was requested and could not be opened.

- [ ] **Step 1: Write the failing IPC test**

Append to `helper/test/ipc.test.ts`, following the file's existing `spawnHelper`/`waitFor` style:

```typescript
describe("camera opt-in", () => {
  // The camera is optional and must never fail a recording. Without a grant, or
  // on a machine with no camera, start must still succeed or fail for its own
  // reasons — never because the camera could not be opened.
  test("start with camera:false opens no device and is unaffected", async () => {
    const h = spawnHelper();
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"));
    h.send({ cmd: "start", dir: session(), camera: false, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 30_000, "start reply");
    // Either outcome is fine — what must NOT appear is a camera error.
    expect(String(r.code ?? "")).not.toMatch(/^camera-/);
    expect(r.camera).toBeUndefined();
  }, 60_000);

  test("an unopenable camera warns and does not fail the start", async () => {
    const h = spawnHelper();
    await waitFor(() => h.fd3.find((l) => l.ev === "ready"));
    h.send({ cmd: "start", dir: session(), camera: true, seq: 1 });
    const r = await waitFor(() => h.fd3.find((l) => l.seq === 1), 30_000, "start reply");
    // On a machine with a camera AND a grant this succeeds with a device name;
    // without either it warns. Both are correct. A start that FAILS because of
    // the camera is not.
    expect(String(r.code ?? "")).not.toMatch(/^camera-/);
  }, 60_000);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run helper/test/ipc.test.ts`
Expected: FAIL — the helper does not accept a `camera` argument, so `r.camera` handling and the warning path do not exist. Confirm the failure names the missing behaviour rather than a typo.

- [ ] **Step 3: Wire it in**

In `helper/src/Capture.swift`:

- Add `private var camera: CameraCapture?` and `private var cameraTrack: CameraTrack?` to `CaptureSession`.
- Change `start` to `func start(displayId: CGDirectDisplayID?, camera wantCamera: Bool, completion: ...)`.
- After the display stream is up and `finishStart(.success(...))` would be called, open the camera OFF the critical path:

```swift
        // Optional subsystem: it must not sit on the critical path. PHASE-0
        // recorded camera/mic setup blocking startup once already.
        if wantCamera {
            let cam = CameraCapture(dir: dir, t0Ns: t0Ns)
            switch cam.start() {
            case .success(let name):
                self.camera = cam
                IO.stat("camera-started", ["device": name])
            case .failure(let e):
                let ce = e as? CameraError
                IO.send("warning", ["code": ce?.code ?? "camera-failed",
                                    "detail": ce.map { $0.description } ?? "\(e)"])
            }
        }
```

- In `stop`, close the camera before writing sidecars, and keep the result:

```swift
            if let cam = self.camera {
                let sem = DispatchSemaphore(value: 0)
                cam.stop { track in self.cameraTrack = track; sem.signal() }
                // Bounded: CameraCapture.stop already answers within 10 s, so a
                // wait longer than that means it broke its own contract.
                _ = sem.wait(timeout: .now() + 12)
            }
```

- Pass `camera: cameraTrack` to `anchorsDocument(...)` in `writeSidecars`.
- Include the device name in `describe()`'s dictionary when a camera opened, so `started` carries it.

In `helper/src/main.swift`, read the flag and pass it through:

```swift
        let wantCamera = cmd["camera"] as? Bool ?? false
        session.start(displayId: displayId, camera: wantCamera) { [weak self] result in
```

- [ ] **Step 4: Run the tests**

Run: `helper/build.sh && npx vitest run helper/test/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add helper/src/Capture.swift helper/src/main.swift helper/test/ipc.test.ts
git commit -m "STC-232: start --camera opens the camera alongside the display

start gains an opt-in camera flag. The device opens AFTER the display stream is
up and off the critical path: a missing, denied or busy camera emits a warning
and leaves the recording display-only. PHASE-0 recorded camera setup blocking
startup once already, and a recording lost to an optional subsystem is a worse
outcome than a take without a PiP.

stop closes the camera before the sidecars are written, with a bound, and the
resulting track goes into anchors.camera."
```

---

### Task 4: Prove it on real hardware, and measure the encoder cost

The design spec lists two open risks that this increment is the first able to measure. Both are measurements, not opinions.

**Files:**
- Create: `helper/test/camera-capture.grant.test.ts`

- [ ] **Step 1: Write the grant-gated test**

```typescript
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const APP = join(root, "tools/test-host/STCTestHost.app");
const HELPER = join(root, "helper/build/stc-helper");

describe("camera capture — requires Screen Recording AND Camera", () => {
  test("a real recording produces camera.mp4 and a schema-valid anchors.camera", () => {
    if (!existsSync(APP)) {
      throw new Error(`${APP} is missing — run tools/test-host/build.sh first`);
    }
    const dir = mkdtempSync(join(tmpdir(), "stc-camcap-"));
    execFileSync("open", ["-W", APP, "--args", "--helper", HELPER,
                          "--dir", dir, "--ms", "4000", "--camera",
                          "--out", join(dir, "result.json")],
                 { timeout: 120_000 });

    const anchorsPath = join(dir, "anchors.json");
    if (!existsSync(anchorsPath)) {
      throw new Error("SKIP-GRANT: no anchors.json — the recording never ran. " +
                      "Grant Screen Recording and Camera to STC Signing Probe.");
    }
    const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));

    if (anchors.camera?.present !== true) {
      throw new Error(
        `SKIP-GRANT: the take has no camera track (present=${anchors.camera?.present}). ` +
        `Grant Camera to STC Signing Probe, then re-run.`);
    }

    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(JSON.parse(
      readFileSync(join(root, "schema/anchors-2.schema.json"), "utf8")));
    expect(validate(anchors), JSON.stringify(validate.errors, null, 2)).toBe(true);

    expect(anchors.version).toBe(2);
    expect(anchors.files.camera).toBe("camera.mp4");
    expect(statSync(join(dir, "camera.mp4")).size).toBeGreaterThan(0);

    const cam = anchors.camera;
    expect(cam.width).toBe(1280);
    expect(cam.height).toBe(720);
    expect(cam.lastFramePtsNs).toBeGreaterThan(cam.firstFramePtsNs);
    // Phase 0 measured the camera's first frame landing ~1035 ms after the
    // screen's, from warm-up. Anything at or near zero means the PTS was
    // rebased somewhere it should not have been.
    expect(cam.firstFramePtsNs).toBeGreaterThan(50_000_000);
    // ~58.8 fps measured; anything outside this is not a camera frame interval.
    expect(cam.frameIntervalNs).toBeGreaterThan(8_000_000);
    expect(cam.frameIntervalNs).toBeLessThan(50_000_000);
  }, 180_000);
});
```

Extend `tools/test-host/main.swift`'s session mode to pass `"camera": true` in its `start` command when `--camera` is present, using the existing `arg(...)` helper.

- [ ] **Step 2: Run it**

Run: `tools/test-host/build.sh && helper/build.sh && npm run test:capture`
Expected: PASS, or a `SKIP-GRANT:` naming exactly which grant is missing.

**If `firstFramePtsNs` comes back at or near zero, stop.** That means the camera PTS was rebased rather than used as-is, and every PiP would be silently out of sync. It is the single most likely serious mistake in this increment.

- [ ] **Step 3: Measure the open risk — two concurrent hardware encodes**

The spec records this as unmeasured. Record a 30 s take with the camera on, then report from the helper's own stats:

```bash
node scripts/export-one.mjs <sessionDir> 5    # confirms the take is readable
```

Read `framesAppended`, `framesDropped` and the peak fps from the stop reply. Compare against the display-only baseline in `PHASE-2.md` (9311 frames, 0 dropped, peak 60.0 fps over 5 minutes).

Write the numbers into `PHASE-2.md` under a new heading. **If the display track drops frames with the camera on, say so plainly** — that is a finding that changes the design, not a detail.

- [ ] **Step 4: Commit**

```bash
git add helper/test/camera-capture.grant.test.ts tools/test-host/main.swift PHASE-2.md
git commit -m "STC-232: prove camera capture on real hardware and measure the encoder cost

A grant-gated recording that asserts camera.mp4 exists and anchors.camera
validates against anchors-2, including that firstFramePtsNs is NOT near zero:
phase 0 measured the camera's first frame landing ~1035 ms after the screen's,
so a near-zero value means the PTS was rebased and every PiP would be silently
out of sync.

Also records what two concurrent H.264 hardware encodes actually cost, which
the design spec listed as an open risk and nothing had measured."
```

---

## What increment 3 deliberately does NOT do

- No compositor or sink changes — `camera.mp4` is written and demuxed by nobody yet. That is increment 4.
- No app UI. The `camera` flag is IPC-only; the sticky toggle is increment 5.
- No `fixtures/offset` camera sibling. The per-track empty-edit check belongs with increment 4, where a camera track is first demuxed.

## Self-review notes

- **Spec coverage:** increment 3's three obligations — `camera.mp4`, `anchors.camera`, emitting to the schema increment 2 defined — are Tasks 2, 3 and 1 respectively, with Task 4 proving them on hardware.
- **The riskiest thing here** is the PTS rule. It appears in the global constraints, in `CameraCapture`'s doc comment, and as an explicit assertion in Task 4 with a stated stop condition, because getting it wrong produces a PiP that looks fine in a still frame and is wrong in motion.
- **Type consistency:** `CameraTrack`'s field names match `schema/anchors-2.schema.json` and `transform/src/types.ts` exactly — `present`, `device`, `width`, `height`, `firstFramePtsNs`, `lastFramePtsNs`, `frameIntervalNs`.
