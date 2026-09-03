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
///
/// `requested` decides whether the `camera` block is written at all (STC-303).
/// schema/anchors-2.schema.json says absent means no camera was even
/// attempted and `present:false` means one was requested (or considered) but
/// yielded no track — before this parameter existed, the block was written
/// unconditionally, so every display-only take carried `present:false` and
/// the take library labelled it a camera that recorded nothing. `camera` and
/// `requested` are independent: `requested: true, camera: nil` is exactly the
/// STC-286 case (a camera opened and delivered zero frames), and still
/// produces `present:false` — this fix must not silence that.
func anchorsDocument(timebase: (numer: Int, denom: Int),
                     t0Ns: UInt64,
                     display: DisplayGeometry,
                     capture: CaptureGeometryDoc,
                     camera: CameraTrack?,
                     requested: Bool,
                     stopReason: String,
                     stopTNs: Int) -> [String: Any] {
    var files: [String: Any] = ["display": "display.mp4"]
    var cameraBlock: [String: Any]?
    if requested {
        cameraBlock = ["present": false]
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
    }
    var doc: [String: Any] = [
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
                    "originX": display.originX, "originY": display.originY] as [String: Any],
        "capture": ["width": capture.width, "height": capture.height, "codec": "h264",
                    "firstFrameNs": max(0, capture.firstFrameNs)] as [String: Any],
        "files": files,
        "stop": ["t": stopTNs, "reason": stopReason] as [String: Any],
    ]
    if let cameraBlock {
        doc["camera"] = cameraBlock
    }
    return doc
}
