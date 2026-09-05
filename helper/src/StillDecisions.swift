import Foundation
import CoreGraphics

/// The decisions the one-frame path makes (STC-289), kept free of
/// ScreenCaptureKit and AppKit so `helper/test/still/main.swift` can compile
/// them into a throwaway binary and exercise them without a display, a grant
/// or a pointer — the same arrangement `CaptureDecisions.swift` has for the
/// recording path (STC-248). `Still.swift` calls these; it does not repeat them.
///
/// What is decided here: what a `capture-still` request means and whether it
/// is well-formed; which region of the display a crop resolves to; where the
/// pointer is in the source display's own coordinates, or that it is elsewhere;
/// and the exact `shot.json` the helper writes (which shape the pointer is comes
/// from STC-309's classifier, shared with the recording path). That last one is the contract with `transform/src/shot.ts`
/// (schema/shot-1.schema.json), and `still-decisions.test.ts` validates every
/// document this produces against both — the writer half of STC-301 gate 5,
/// checked on every `npm test` rather than only on a Mac with a grant.

/// A rectangle in display-local POINTS, top-left origin: the shot-1 `rect`.
struct StillRect: Equatable {
    var x: Double, y: Double, width: Double, height: Double

    var json: [String: Any] { ["x": x, "y": y, "width": width, "height": height] }
    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
    init(_ r: CGRect) {
        self.init(x: Double(r.origin.x), y: Double(r.origin.y),
                  width: Double(r.size.width), height: Double(r.size.height))
    }
}

/// The shot-1 `kind` discriminator. A window is NOT a crop (STC-289, changed
/// decision): a crop out of a display capture is always an opaque rectangle
/// with whatever was behind the window baked in.
enum StillKind: String {
    case displayCrop = "display-crop"
    case window
}

struct StillRequest: Equatable {
    /// The shot's own directory; `file` and `shot.json` are written inside it.
    let dir: String
    let kind: StillKind
    /// display-crop: which display. nil means the first one ScreenCaptureKit
    /// lists, which is the main display — the same fallback `start` uses.
    let displayId: UInt32?
    /// display-crop: the region in display-local points. nil means the whole
    /// display, which is what a full-screen shot is.
    let crop: StillRect?
    /// window: the CGWindowID, from the `windows` verb or the picker (STC-290).
    let windowId: UInt32?
    /// The frame's file name, beside shot.json. A NAME, never a path.
    let file: String
    /// CGWindowIDs to leave OUT of a display capture (STC-290).
    ///
    /// The selection overlay is a window like any other, and a still taken
    /// while it is still composited would capture the dimming and the marquee.
    /// Hiding it first is necessary and not sufficient — the hide and the
    /// capture reach the window server through different paths, with no
    /// ordering between them — so the caller also names the windows it must not
    /// see. Empty for every other caller. Window shots ignore it: their filter
    /// contains exactly one window, so nothing else can appear anyway.
    let excludeWindowIds: [UInt32]

    static let defaultFile = "frame.png"
}

enum StillRequestError: Error, Equatable, CustomStringConvertible {
    case missingDir
    case badKind(String)
    case missingWindowId
    case cropOnWindow
    case badCrop(String)
    case badFile(String)

    var code: String {
        switch self {
        case .missingDir:      return "missing-dir"
        case .badKind:         return "bad-kind"
        case .missingWindowId: return "missing-window-id"
        case .cropOnWindow:    return "crop-on-window"
        case .badCrop:         return "bad-crop"
        case .badFile:         return "bad-file"
        }
    }

    var description: String {
        switch self {
        case .missingDir: return "capture-still requires \"dir\""
        case .badKind(let k): return "kind must be display-crop or window, not \"\(k)\""
        case .missingWindowId: return "a window shot requires \"windowId\" (a CGWindowID; see the windows verb)"
        case .cropOnWindow: return "a window shot must not carry a crop — the window's own bounds are the region"
        case .badCrop(let why): return "crop must be {x, y, width, height} in display-local points with positive size: \(why)"
        case .badFile(let f): return "file must be a bare file name beside shot.json, not \"\(f)\""
        }
    }
}

/// Numbers arrive from JSONSerialization as NSNumber, and `as? Double` bridges
/// an integral NSNumber too — which is what lets a client send `"x": 100` for
/// a rect. A native Swift `Int` inside `Any` does NOT take that bridge (the
/// harness's dictionary literals are exactly that), so it is accepted by name.
/// CI's first run of the harness found this: `crop-on-window` came back as
/// `bad-crop` for a crop written as integers.
private func number(_ v: Any?) -> Double? {
    if let d = v as? Double, d.isFinite { return d }
    if let i = v as? Int { return Double(i) }
    return nil
}

/// A display or window id: a non-negative integer that fits the CG types.
private func id32(_ v: Any?) -> UInt32? {
    guard let i = v as? Int, i >= 0, i <= Int(UInt32.max) else { return nil }
    return UInt32(i)
}

private func parseRect(_ v: Any) -> Result<StillRect, StillRequestError> {
    guard let o = v as? [String: Any],
          let x = number(o["x"]), let y = number(o["y"]),
          let w = number(o["width"]), let h = number(o["height"])
    else { return .failure(.badCrop("not an object of four finite numbers")) }
    guard w > 0, h > 0 else { return .failure(.badCrop("width \(w) x height \(h)")) }
    return .success(StillRect(x: x, y: y, width: w, height: h))
}

/// What the command line asked for, or exactly why it cannot be done.
///
/// Refuses rather than defaults on anything that changes what gets captured —
/// a crop on a window shot is two claims about the region, and `parseShot`
/// refuses the same pair on the way back in. The two defaults that remain
/// (kind, file) change nothing about the pixels.
func parseStillRequest(_ cmd: [String: Any]) -> Result<StillRequest, StillRequestError> {
    guard let dir = cmd["dir"] as? String, !dir.isEmpty else { return .failure(.missingDir) }

    let kindRaw = cmd["kind"] as? String ?? StillKind.displayCrop.rawValue
    guard let kind = StillKind(rawValue: kindRaw) else { return .failure(.badKind(kindRaw)) }

    let file = cmd["file"] as? String ?? StillRequest.defaultFile
    // A name, not a path: the shot's directory is the request's `dir` and
    // nothing in the request may write outside it.
    guard !file.isEmpty, !file.contains("/"), file != ".", file != ".." else {
        return .failure(.badFile(file))
    }

    var crop: StillRect? = nil
    if let c = cmd["crop"] {
        switch parseRect(c) {
        case .success(let r): crop = r
        case .failure(let e): return .failure(e)
        }
    }

    // Anything unreadable is dropped rather than refused: an id the window
    // server no longer knows is exactly what a stale overlay id looks like, and
    // excluding a window that is already gone is a no-op, not an error.
    let exclude = (cmd["excludeWindowIds"] as? [Any] ?? []).compactMap(id32)

    switch kind {
    case .displayCrop:
        return .success(StillRequest(dir: dir, kind: kind, displayId: id32(cmd["displayId"]),
                                     crop: crop, windowId: nil, file: file,
                                     excludeWindowIds: exclude))
    case .window:
        guard crop == nil else { return .failure(.cropOnWindow) }
        guard let wid = id32(cmd["windowId"]) else { return .failure(.missingWindowId) }
        return .success(StillRequest(dir: dir, kind: kind, displayId: nil,
                                     crop: nil, windowId: wid, file: file,
                                     excludeWindowIds: exclude))
    }
}

enum CropDecision: Equatable {
    /// The region to capture, in display-local points, inside the display.
    case region(StillRect)
    /// Nothing of the crop lies on the display.
    case outside
}

/// The region a display-crop shot captures.
///
/// A crop that overshoots an edge is clamped, not refused: a drag that runs
/// off the screen is the normal way to mean "to the edge". Only a crop with no
/// overlap at all is refused, because there is nothing honest to return for it.
func resolveCrop(_ crop: StillRect?, pointWidth: Int, pointHeight: Int) -> CropDecision {
    let display = CGRect(x: 0, y: 0, width: pointWidth, height: pointHeight)
    guard let crop else { return .region(StillRect(display)) }
    let r = crop.cgRect.intersection(display)
    guard !r.isNull, r.width > 0, r.height > 0 else { return .outside }
    return .region(StillRect(r))
}

/// The frame's size in pixels for a region in points. Rounded, never
/// truncated — 1279.9999 points at 2x is 2560 pixels, not 2559 — and never
/// below one pixel on either axis.
func framePixelSize(points: StillRect, backingScale: Double) -> (width: Int, height: Int) {
    (max(1, Int((points.width * backingScale).rounded())),
     max(1, Int((points.height * backingScale).rounded())))
}

/// Where the pointer is on the SOURCE display, in that display's own
/// top-left-origin points — or nil when it is on another display.
///
/// `NSEvent.mouseLocation` is a Cocoa global point: origin at the bottom-left
/// of the MAIN display, y up. Display bounds (`CGDisplayBounds`) are CoreGraphics
/// global: origin at the top-left of the main display, y down. The flip is
/// against the main display's height, whatever display the pointer is over —
/// a flip against the source display's height is right only when that display
/// is the main one, and wrong by a silent constant otherwise.
///
/// Nil is nil: the schema says a cursor block is ABSENT when the pointer was
/// elsewhere, and a zeroed one would be a pointer drawn at the corner.
func localizeCursor(mouseX: Double, mouseY: Double,
                    mainDisplayHeight: Double, display: CGRect) -> (x: Double, y: Double)? {
    let cgY = mainDisplayHeight - mouseY
    let p = CGPoint(x: mouseX, y: cgY)
    guard display.contains(p) else { return nil }
    return (mouseX - Double(display.minX), cgY - Double(display.minY))
}

/// The cursor's `shape` is one of `cursorShapeNames` (CaptureDecisions.swift),
/// classified by STC-309's `classifyCursor`; shot-1's enum is the same set as
/// events-2's, and `still-decisions.test.ts` holds the Swift list to it.

struct StillWindowInfo: Equatable {
    let id: Int
    let app: String?
    let title: String?
    /// display-local points
    let bounds: StillRect
}

struct StillCursorSample: Equatable {
    let x: Double, y: Double
    let shape: String
}

struct StillFrameInfo: Equatable {
    let file: String
    /// pixels
    let width: Int, height: Int
    /// true only when the capture actually carries an alpha channel
    let alpha: Bool
}

/// Builds shot.json (schema/shot-1.schema.json).
///
/// Pure on purpose, like `anchorsDocument`: the shape of this document is a
/// contract with the transform, and a contract that can only be checked by
/// performing a real capture is a contract nothing checks on most runs.
///
/// The decoration is the honest default for what was captured, and it is
/// decided on the FRAME, not the request: a window shot whose pixels came back
/// without alpha gets `selected-area`, because `window-only` promises
/// transparency outside the window's shape and `parseShot` refuses that
/// promise on an opaque frame. The reply carries a warning for that case.
func shotDocument(kind: StillKind,
                  capturedAtNs: UInt64,
                  timebase: (numer: Int, denom: Int),
                  display: DisplayGeometry,
                  colorSpace: String?,
                  crop: StillRect?,
                  window: StillWindowInfo?,
                  frame: StillFrameInfo,
                  cursor: StillCursorSample?) -> [String: Any] {
    var displayBlock: [String: Any] = [
        "id": display.id,
        "pointWidth": display.pointWidth, "pointHeight": display.pointHeight,
        "pixelWidth": display.pixelWidth, "pixelHeight": display.pixelHeight,
        "backingScale": display.backingScale,
        "originX": display.originX, "originY": display.originY,
    ]
    if let colorSpace { displayBlock["colorSpace"] = colorSpace }

    var doc: [String: Any] = [
        "version": 1,
        "kind": kind.rawValue,
        // String, like anchors.t0Ns: boot-relative ns crosses 2^53 at ~104
        // days of uptime and a JSON number would round.
        "capturedAtNs": String(capturedAtNs),
        "timebase": ["numer": timebase.numer, "denom": timebase.denom],
        "display": displayBlock,
        "frame": ["file": frame.file, "width": frame.width, "height": frame.height,
                  "alpha": frame.alpha] as [String: Any],
        "decoration": [
            "mode": kind == .window && frame.alpha ? "window-only" : "selected-area",
            "canvas": "natural",
            "cursor": false,
            "redactions": [] as [Any],
        ] as [String: Any],
    ]

    switch kind {
    case .displayCrop:
        doc["crop"] = (crop ?? StillRect(x: 0, y: 0, width: Double(display.pointWidth),
                                          height: Double(display.pointHeight))).json
    case .window:
        if let w = window {
            var wb: [String: Any] = ["id": w.id, "bounds": w.bounds.json]
            if let app = w.app, !app.isEmpty { wb["app"] = app }
            if let title = w.title, !title.isEmpty { wb["title"] = title }
            doc["window"] = wb
        }
    }

    if let c = cursor {
        doc["cursor"] = ["x": c.x, "y": c.y, "shape": c.shape]
    }
    return doc
}
