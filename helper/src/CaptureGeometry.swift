import Foundation

/// The hardware-encode ceiling (PHASE-0 §3). Above this, H.264 encode falls off
/// a cliff in one step — 0.81 -> 0.25 Gpx/s as it drops to software — and
/// Chrome's decoder shares the limit, so it caps both ends of the pipeline.
let MAX_CAPTURE_WIDTH = 3840
let MAX_CAPTURE_HEIGHT = 2160

/// Capture dimensions for a display of the given pixel size.
///
/// Not hypothetical rounding: this machine's built-in display is 6016x3384, so
/// capturing native would silently land on the software path and never reach
/// 60 fps. Aspect ratio is preserved; both dimensions are floored to even
/// numbers because H.264 4:2:0 requires them.
func captureSize(_ pixelWidth: Int, _ pixelHeight: Int) -> (w: Int, h: Int) {
    guard pixelWidth > 0, pixelHeight > 0 else { return (2, 2) }

    let scale = min(1.0,
                    Double(MAX_CAPTURE_WIDTH) / Double(pixelWidth),
                    Double(MAX_CAPTURE_HEIGHT) / Double(pixelHeight))

    // Round rather than truncate: 6016 * (3840/6016) lands on 3839.9999... in
    // binary floating point, and truncating there would silently shave a pixel
    // off an exact fit. Flooring to even afterwards keeps us under the cap even
    // if rounding nudged a dimension one over it.
    func evenFloor(_ v: Double) -> Int { max(2, Int(v.rounded()) / 2 * 2) }

    return (evenFloor(Double(pixelWidth) * scale),
            evenFloor(Double(pixelHeight) * scale))
}
