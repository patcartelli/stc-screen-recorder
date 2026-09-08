import Foundation

var failures: [String] = []
func check(_ c: Bool, _ what: String) { if !c { failures.append(what) } }

/// Emits a built document as JSON, prefixed by `marker`, so the TS harness
/// (helper/test/anchors.test.ts) can pull it back out of stdout and validate
/// it against schema/anchors-2.schema.json with Ajv. This closes the gap
/// STC-262 already named: the member-by-member `check()`s above can drift
/// from the schema silently, because the only thing that ever validated a
/// built document against anchors-2 was the grant-gated
/// camera-capture.grant.test.ts, which needs a Camera grant and has never
/// run in CI.
func printJSON(_ o: [String: Any], marker: String) {
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
          let s = String(data: d, encoding: .utf8) else {
        failures.append("\(marker) document did not serialize to JSON")
        return
    }
    print("\(marker)\(s)")
}

let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160,
                              originX: 0, originY: 0)
let capture = CaptureGeometryDoc(width: 3840, height: 2160, firstFrameNs: 200_000_000)

// 1. Always version 2. No camera requested: the block is ABSENT, not
//    present:false (STC-303) — present:false is a claim that a camera was
//    asked for and yielded nothing, which is untrue for a display-only take.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            stopReason: "user", stopTNs: 20_000_000_000)
    check(d["version"] as? Int == 2, "version must be 2")
    check(d["camera"] == nil, "camera block must be absent when no camera was requested")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] == nil, "files.camera must be absent when there is no camera")
    printJSON(d, marker: "JSON-NO-CAMERA:")
}

// 2. Requested, but no track — STC-286: a camera that opened and delivered
//    zero frames. This is the one case present:false must still say, so
//    fixing check 1 must not silence it.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: true,
                            stopReason: "user", stopTNs: 20_000_000_000)
    let cam = d["camera"] as? [String: Any]
    check(cam != nil, "a requested camera must always write a camera block")
    check(cam?["present"] as? Bool == false, "a requested camera with no track must record present:false")
    check(cam?["device"] == nil, "a camera with no track must not invent measurements")
    let files = d["files"] as? [String: Any]
    check(files?["camera"] == nil, "files.camera must be absent when the camera produced no track")
    printJSON(d, marker: "JSON-CAMERA-REQUESTED-NO-FRAMES:")
}

// 3. A present camera records its measurements and its file.
do {
    let track = CameraTrack(present: true, device: "Fixture Camera", width: 1280, height: 720,
                            firstFramePtsNs: 1_035_500_000, lastFramePtsNs: 3_024_500_000,
                            frameIntervalNs: 17_000_000)
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: track, requested: true,
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
    printJSON(d, marker: "JSON-WITH-CAMERA:")
}

// 4. t0Ns stays a STRING: boot-relative ns crosses 2^53 at ~104 days of uptime
//    and a JSON number would round.
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 18_446_744_073, display: display,
                            capture: capture, camera: nil, requested: false,
                            stopReason: "user", stopTNs: 1)
    check(d["t0Ns"] as? String == "18446744073", "t0Ns must be a string")
}

// 5. A take ended by SHUTDOWN, not by a stop anyone asked for (STC-311).
//    Every case above used stopReason "user", so the only reasons ever run
//    through the schema were the ones that were already in its enum — while
//    App.shutdown writes "quit", "stdin-closed" and "signal-N" (STC-304), and
//    STC-305 writes "stopped-during-start". Those documents are as real as any
//    other and had never been validated. `signal-15` also pins the open-ended
//    family: it is why the schema cannot be a closed enum.
do {
    for reason in ["quit", "stdin-closed", "signal-15", "stopped-during-start"] {
        let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                                capture: capture, camera: nil, requested: false,
                                stopReason: reason, stopTNs: 8_000_000_000)
        let stop = d["stop"] as? [String: Any]
        check(stop?["reason"] as? String == reason, "stop.reason must be written verbatim: \(reason)")
        printJSON(d, marker: "JSON-STOP-\(reason.uppercased()):")
    }
}

// 6. The writer did not finalise in time, on a shutdown reason. The backstop
//    appends "-timeout" to WHATEVER reason it was given (CaptureSession.stop),
//    so the suffix is not a fixed list of five — a wedged writer during a
//    SIGTERM writes "signal-15-timeout".
do {
    let d = anchorsDocument(timebase: (125, 3), t0Ns: 1000, display: display,
                            capture: capture, camera: nil, requested: false,
                            stopReason: "signal-15-timeout", stopTNs: 8_000_000_000)
    check((d["stop"] as? [String: Any])?["reason"] as? String == "signal-15-timeout",
          "a timed-out shutdown keeps its suffixed reason")
    printJSON(d, marker: "JSON-STOP-SIGNAL-TIMEOUT:")
}

if failures.isEmpty { print("ALL PASS") }
else { for f in failures { print("FAIL: \(f)") }; exit(1) }
