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
    printJSON(d, marker: "JSON-NO-CAMERA:")
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
    printJSON(d, marker: "JSON-WITH-CAMERA:")
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
