// Pure-function tests for the one-frame path's decisions (STC-289). Compiled
// together with the production source, same as the geometry and decisions
// harnesses: no XCTest, so the "framework" is assertions plus a non-zero exit.
//
// Every shot.json this prints (`shot-json ` lines) is validated by
// still-decisions.test.ts against schema/shot-1.schema.json AND parseShot —
// the writer half of STC-301 gate 5, checked without a display or a grant.
import Foundation
import CoreGraphics

var failures = 0
// Compares descriptions, so `got` must be unwrapped (`?? sentinel`) — an
// Optional describes as `Optional("x")` and never equals `"x"`. CI's first
// run of this file failed 8 checks that way while the code was right.
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        print("FAIL \(label): got \(got), want \(want)")
        failures += 1
    }
}

// ── request parsing ─────────────────────────────────────────────────────────
func parse(_ cmd: [String: Any]) -> String {
    switch parseStillRequest(cmd) {
    case .success(let r): return "ok:\(r.kind.rawValue):\(r.file)"
    case .failure(let e): return "err:\(e.code)"
    }
}

check("dir is required", parse(["cmd": "capture-still"]), "err:missing-dir")
check("an empty dir is missing", parse(["dir": ""]), "err:missing-dir")
check("kind defaults to display-crop, file to frame.png",
      parse(["dir": "/tmp/x"]), "ok:display-crop:frame.png")
check("an unknown kind is refused, not defaulted", parse(["dir": "/tmp/x", "kind": "region"]), "err:bad-kind")
check("a window shot needs a windowId", parse(["dir": "/tmp/x", "kind": "window"]), "err:missing-window-id")
check("a negative windowId is no windowId",
      parse(["dir": "/tmp/x", "kind": "window", "windowId": -1]), "err:missing-window-id")
check("a window shot with a crop is two claims about the region",
      parse(["dir": "/tmp/x", "kind": "window", "windowId": 12,
             "crop": ["x": 0, "y": 0, "width": 10, "height": 10]]), "err:crop-on-window")
check("a window shot parses", parse(["dir": "/tmp/x", "kind": "window", "windowId": 12]), "ok:window:frame.png")
check("a crop written as integers parses (a Swift Int in Any is not an NSNumber)",
      parse(["dir": "/tmp/x", "crop": ["x": 0, "y": 0, "width": 10, "height": 10]]), "ok:display-crop:frame.png")
check("a crop with zero height is refused",
      parse(["dir": "/tmp/x", "crop": ["x": 0, "y": 0, "width": 10, "height": 0]]), "err:bad-crop")
check("a crop missing a side is refused",
      parse(["dir": "/tmp/x", "crop": ["x": 0, "y": 0, "width": 10]]), "err:bad-crop")
check("a crop that is not an object is refused", parse(["dir": "/tmp/x", "crop": "all"]), "err:bad-crop")
check("file is a name beside shot.json, never a path",
      parse(["dir": "/tmp/x", "file": "../elsewhere.png"]), "err:bad-file")
check("file cannot be empty", parse(["dir": "/tmp/x", "file": ""]), "err:bad-file")
check("file can be renamed", parse(["dir": "/tmp/x", "file": "grab.png"]), "ok:display-crop:grab.png")

if case .success(let r) = parseStillRequest(["dir": "/tmp/x", "displayId": 3,
                                              "crop": ["x": 10, "y": 20.5, "width": 300, "height": 200]]) {
    check("displayId is carried", r.displayId ?? 0, UInt32(3))
    check("integral and fractional coordinates both parse",
          r.crop ?? StillRect(x: 0, y: 0, width: 0, height: 0), StillRect(x: 10, y: 20.5, width: 300, height: 200))
} else {
    print("FAIL a full display-crop request did not parse"); failures += 1
}
if case .success(let r) = parseStillRequest(["dir": "/tmp/x"]) {
    check("no displayId means the first display", r.displayId, nil as UInt32?)
    check("no crop means the whole display", r.crop, nil as StillRect?)
}

// ── crop resolution ─────────────────────────────────────────────────────────
check("no crop is the whole display",
      resolveCrop(nil, pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 0, y: 0, width: 1920, height: 1080)))
check("a crop inside the display is itself",
      resolveCrop(StillRect(x: 100, y: 80, width: 640, height: 360), pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 100, y: 80, width: 640, height: 360)))
check("a crop that overshoots the edge is clamped, not refused",
      resolveCrop(StillRect(x: 1800, y: 1000, width: 400, height: 400), pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 1800, y: 1000, width: 120, height: 80)))
check("a crop starting off the top-left is clamped to the origin",
      resolveCrop(StillRect(x: -50, y: -50, width: 100, height: 100), pointWidth: 1920, pointHeight: 1080),
      CropDecision.region(StillRect(x: 0, y: 0, width: 50, height: 50)))
check("a crop entirely off the display is refused",
      resolveCrop(StillRect(x: 2000, y: 0, width: 100, height: 100), pointWidth: 1920, pointHeight: 1080),
      CropDecision.outside)
check("a crop touching only the edge is refused (zero overlap)",
      resolveCrop(StillRect(x: 1920, y: 0, width: 100, height: 100), pointWidth: 1920, pointHeight: 1080),
      CropDecision.outside)

// ── pixel size ──────────────────────────────────────────────────────────────
check("2x: 640x360 points is 1280x720 pixels",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 640, height: 360), backingScale: 2).width, 1280)
check("rounds rather than truncates (1279.9999 points at 1x)",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 1279.9999, height: 1), backingScale: 1).width, 1280)
check("never below one pixel",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 0.1, height: 0.1), backingScale: 1).height, 1)
check("fractional scale (a scaled external display) rounds",
      framePixelSize(points: StillRect(x: 0, y: 0, width: 1000, height: 1000), backingScale: 1.5).width, 1500)

// ── cursor localisation ─────────────────────────────────────────────────────
// Main display 1920x1080 at the CG origin; a second display to its right; a
// third ABOVE it (negative CG y). Cocoa mouseLocation has its origin at the
// main display's bottom-left with y up.
let main = CGRect(x: 0, y: 0, width: 1920, height: 1080)
let right = CGRect(x: 1920, y: 0, width: 2560, height: 1440)
let above = CGRect(x: 0, y: -900, width: 1440, height: 900)
let mainH = 1080.0

func loc(_ x: Double, _ y: Double, on d: CGRect) -> String {
    guard let p = localizeCursor(mouseX: x, mouseY: y, mainDisplayHeight: mainH, display: d) else { return "absent" }
    return "\(p.x),\(p.y)"
}
check("main display: Cocoa y flips against the main height", loc(100, 1000, on: main), "100.0,80.0")
check("main display: bottom-left corner is local (0, 1079)", loc(0, 1, on: main), "0.0,1079.0")
check("pointer on the right display is ABSENT for the main one", loc(2000, 100, on: main), "absent")
check("right display: local to its own origin, still flipped against MAIN height",
      loc(2000, 100, on: right), "80.0,980.0")
check("right display is taller than main: Cocoa y can be negative there",
      loc(2000, -300, on: right), "80.0,1380.0")
check("display above main: negative CG y localises to positive local y",
      loc(700, 1500, on: above), "700.0,480.0")
check("display above main: a pointer on main is absent for it", loc(700, 500, on: above), "absent")
check("exactly on the far edge is outside (half-open, like CGRect.contains)",
      loc(1920, 500, on: main), "absent")

// ── shape names ─────────────────────────────────────────────────────────────
// Classification itself is STC-309's (`classifyCursor`, covered by
// decisions/main.swift); a still only needs the list it writes from to be the
// schema's, which still-decisions.test.ts checks against this line.
print("shapes " + cursorShapeNames.joined(separator: ","))
check("the default is in the list", cursorShapeNames.contains(defaultCursorShape), true)

// ── the document ────────────────────────────────────────────────────────────
let display = DisplayGeometry(id: 1, pointWidth: 1920, pointHeight: 1080,
                              pixelWidth: 3840, pixelHeight: 2160, originX: 0, originY: 0)
check("backingScale is pixels per point", display.backingScale, 2.0)
check("backingScale survives an unknown point size",
      DisplayGeometry(id: 1, pointWidth: 0, pointHeight: 0, pixelWidth: 10, pixelHeight: 10,
                      originX: 0, originY: 0).backingScale, 1.0)

func emit(_ label: String, _ doc: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys])
    print("shot-json \(label) " + String(data: data, encoding: .utf8)!)
}

// (a) a display crop with the pointer on the display
let a = shotDocument(kind: .displayCrop, capturedAtNs: 1_000_000_000, timebase: (numer: 125, denom: 3),
                     display: display, colorSpace: "kCGColorSpaceDisplayP3",
                     crop: StillRect(x: 100, y: 80, width: 640, height: 360), window: nil,
                     frame: StillFrameInfo(file: "frame.png", width: 1280, height: 720, alpha: false),
                     cursor: StillCursorSample(x: 420, y: 300, shape: "arrow"))
check("(a) display-crop carries crop and no window", a["window"] == nil && a["crop"] != nil, true)
check("(a) decoration is selected-area", (a["decoration"] as? [String: Any])?["mode"] as? String ?? "missing", "selected-area")
check("(a) capturedAtNs is a decimal string", a["capturedAtNs"] as? String ?? "missing", "1000000000")
emit("display-crop", a)

// (b) a whole-display shot, pointer elsewhere: no crop asked for, no cursor block
let b = shotDocument(kind: .displayCrop, capturedAtNs: 42, timebase: (numer: 1, denom: 1),
                     display: display, colorSpace: nil, crop: nil, window: nil,
                     frame: StillFrameInfo(file: "frame.png", width: 3840, height: 2160, alpha: false),
                     cursor: nil)
check("(b) no crop means the crop block IS the whole display",
      (b["crop"] as? [String: Any])?["width"] as? Double ?? -1, 1920.0)
check("(b) cursor elsewhere means NO cursor block, not a zeroed one", b["cursor"] == nil, true)
check("(b) no colour space means no key", (b["display"] as? [String: Any])?["colorSpace"] == nil, true)
emit("full-display", b)

// (c) a window with alpha
let c = shotDocument(kind: .window, capturedAtNs: 7, timebase: (numer: 125, denom: 3),
                     display: display, colorSpace: "kCGColorSpaceSRGB", crop: nil,
                     window: StillWindowInfo(id: 4711, app: "Finder", title: "Downloads",
                                             bounds: StillRect(x: 200, y: 120, width: 800, height: 600)),
                     frame: StillFrameInfo(file: "frame.png", width: 1600, height: 1200, alpha: true),
                     cursor: StillCursorSample(x: 500, y: 400, shape: "pointingHand"))
check("(c) window carries window and no crop", c["crop"] == nil && c["window"] != nil, true)
check("(c) decoration is window-only", (c["decoration"] as? [String: Any])?["mode"] as? String ?? "missing", "window-only")
emit("window", c)

// (d) a window whose pixels came back opaque: honest decoration, no title
let d = shotDocument(kind: .window, capturedAtNs: 7, timebase: (numer: 125, denom: 3),
                     display: display, colorSpace: nil, crop: nil,
                     window: StillWindowInfo(id: 9, app: nil, title: "",
                                             bounds: StillRect(x: 0, y: 0, width: 10, height: 10)),
                     frame: StillFrameInfo(file: "frame.png", width: 20, height: 20, alpha: false),
                     cursor: nil)
check("(d) an opaque window frame is selected-area, which parseShot accepts",
      (d["decoration"] as? [String: Any])?["mode"] as? String ?? "missing", "selected-area")
check("(d) an empty title is omitted, not written empty",
      (d["window"] as? [String: Any])?["title"] == nil, true)
emit("window-opaque", d)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
