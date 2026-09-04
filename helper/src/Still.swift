import Foundation
import AppKit
import ScreenCaptureKit
import ImageIO
import ObjectiveC

/// One frame, no stream (STC-289).
///
/// `capture-still` hands back exactly one frame at full display resolution
/// through `SCScreenshotManager`, never through an `SCStream`: no ring buffer,
/// no writer, no telemetry tap, and none of the recording lifecycle — a still
/// that had to allocate a recording would inherit every failure mode of one for
/// no benefit, and a still taken MID-recording (the whole point of grabbing one
/// during a demo) must not touch the running stream. Nothing here reads or
/// writes `App.state`, and the only thing shared with `CaptureSession` is the
/// process.
///
/// Two content filters, not one. A display filter for region and full-screen
/// shots — the v1 "full display is the only primitive" rule, the region being
/// `sourceRect`. A window filter (`SCContentFilter(desktopIndependentWindow:)`)
/// for window shots, which is the only way to get a window's real rounded
/// corners with transparency behind them: a crop out of a display capture is
/// always an opaque rectangle with the desktop baked in.
///
/// ## The API is reached through the Objective-C runtime, on purpose
///
/// `SCScreenshotManager` is macOS 14+ and the helper builds against the 13.3
/// SDK (`helper/build.sh`; no Xcode.app on the machine that ships this), where
/// the class does not exist in any header. The runtime has it — this is the same
/// situation `captureResolution` is in, already handled by KVC in Capture.swift.
/// `ScreenshotAPI` looks the class up by name and calls the one class method
/// through its IMP, so the file compiles against 13.3 AND against CI's SDK 15.
/// The cost is stated plainly: a misspelt selector is not a compile error, it is
/// `still-unsupported` at runtime — which is why `ScreenshotAPI.available` is
/// checked first and why `still.grant.test.ts` is the test that proves the call.
///
/// Every request is answered exactly once, within `timeoutSeconds`, by whichever
/// path gets there first (the `start`/`stop` rule): SCShareableContent and the
/// screenshot completion are both callback APIs, and this codebase's question
/// for each is what happens when it stays silent.
enum ScreenshotAPI {
    static let className = "SCScreenshotManager"
    /// `+[SCScreenshotManager captureImageWithFilter:configuration:completionHandler:]`
    /// — Swift's `captureImage(contentFilter:configuration:completionHandler:)`.
    static let selectorName = "captureImageWithFilter:configuration:completionHandler:"

    private typealias CaptureImageIMP = @convention(c) (
        AnyObject, Selector, AnyObject, AnyObject,
        @escaping @convention(block) (CGImage?, NSError?) -> Void
    ) -> Void

    /// True when the running OS has the class AND the method. Both are checked:
    /// a class that exists without the selector (a future rename) must read as
    /// unsupported, not crash on an unrecognised-selector trap.
    static var available: Bool {
        guard let cls = NSClassFromString(className) else { return false }
        return class_getClassMethod(cls, NSSelectorFromString(selectorName)) != nil
    }

    /// Returns false — without calling `completion` — when the API is absent.
    static func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration,
                             completion: @escaping (CGImage?, Error?) -> Void) -> Bool {
        guard let cls = NSClassFromString(className) else { return false }
        let sel = NSSelectorFromString(selectorName)
        guard let method = class_getClassMethod(cls, sel) else { return false }
        let fn = unsafeBitCast(method_getImplementation(method), to: CaptureImageIMP.self)
        let block: @convention(block) (CGImage?, NSError?) -> Void = { image, error in
            completion(image, error)
        }
        fn(cls as AnyObject, sel, filter, configuration, block)
        return true
    }
}

/// Sets a 14+ `SCStreamConfiguration` property the 13.3 headers do not declare.
/// Returns whether the running OS took it, so a caller can say which knobs
/// were actually applied rather than assume.
@discardableResult
private func setIfSupported(_ cfg: SCStreamConfiguration, _ key: String, _ value: Any) -> Bool {
    let setter = "set" + key.prefix(1).uppercased() + key.dropFirst() + ":"
    guard cfg.responds(to: Selector(setter)) else { return false }
    cfg.setValue(value, forKey: key)
    return true
}

enum StillError: Error, CustomStringConvertible {
    case unsupported
    case noDisplays(underlying: Error?)
    case noSuchDisplay(UInt32)
    case noSuchWindow(UInt32)
    case cropOutsideDisplay
    case captureFailed(Error?)
    case writeFailed(String)
    case timedOut(lastStep: String)

    var code: String {
        switch self {
        case .unsupported:        return "still-unsupported"
        case .noDisplays:         return "no-displays"
        case .noSuchDisplay:      return "no-such-display"
        case .noSuchWindow:       return "no-such-window"
        case .cropOutsideDisplay: return "crop-outside-display"
        case .captureFailed:      return "capture-failed"
        case .writeFailed:        return "write-failed"
        case .timedOut:           return "still-timeout"
        }
    }

    var description: String {
        switch self {
        case .unsupported:
            return "\(ScreenshotAPI.className) is not available — macOS 14 or newer is required for stills"
        case .noDisplays(let e):
            return "no displays available — Screen Recording permission is the usual cause (\(e.map { "\($0)" } ?? "no error"))"
        case .noSuchDisplay(let id): return "no display with id \(id)"
        case .noSuchWindow(let id): return "no on-screen window with id \(id)"
        case .cropOutsideDisplay: return "the crop does not overlap the display"
        case .captureFailed(let e): return "screenshot failed: \(e.map { "\($0)" } ?? "no image and no error")"
        case .writeFailed(let why): return "could not write the shot: \(why)"
        case .timedOut(let step):
            return "still did not complete within \(Int(StillCapture.timeoutSeconds)) s (last step: \(step))"
        }
    }
}

/// The AppKit side of the cursor sample: which built-in pointer is showing.
///
/// `NSCursor.currentSystem` is documented to return the current cursor
/// "regardless of which application set it"; whether that holds from a
/// background process is what STC-309's probe measures, and the same answer
/// applies here. Until it is measured this samples the shape and falls back
/// to the arrow, which is what every v1 take shows anyway. The position is
/// the part a still cannot do without, and it comes from `NSEvent.mouseLocation`.
enum StillCursor {
    static func builtIn(_ name: String) -> NSCursor? {
        switch name {
        case "arrow":        return .arrow
        case "ibeam":        return .iBeam
        case "crosshair":    return .crosshair
        case "pointingHand": return .pointingHand
        default:             return nil
        }
    }

    /// One representation's bytes. Sample and references go through the same
    /// call in the same process, so which representation is chosen cancels out.
    static func bytes(_ c: NSCursor) -> Data? { c.image.tiffRepresentation }

    static func currentShape() -> String {
        let sample = NSCursor.currentSystem.flatMap(bytes)
        let references = stillCursorShapes.compactMap { name -> (shape: String, bytes: Data)? in
            guard let c = builtIn(name), let b = bytes(c) else { return nil }
            return (shape: name, bytes: b)
        }
        return classifyStillCursor(sample: sample, references: references)
    }
}

/// One `capture-still` request, start to answer.
final class StillCapture {
    /// How long a still may take before it is answered with `still-timeout`.
    /// Covers the WHOLE request: content enumeration, the screenshot, the PNG
    /// encode and shot.json. Asserted against the client's request timeout in
    /// `helper/test/still-bounds.test.ts`. Ten seconds is fifty times the
    /// ticket's latency target; anything near it is a wedged machine, not a
    /// slow capture, and the answer names the step it was on.
    static let timeoutSeconds: Double = 10

    let request: StillRequest
    let dir: URL
    private let startNs: UInt64

    private let lock = NSLock()
    private var completion: ((Result<[String: Any], StillError>) -> Void)?
    private var step = "queued"
    /// Milliseconds since `run`, per checkpoint. Reported in the reply so the
    /// STC-301 latency gate watches a number, and so a slow still says WHERE
    /// it was slow — content enumeration and PNG encoding are both outside
    /// the capture the ticket's 200 ms is about.
    private var timing: [String: Double] = [:]

    init(request: StillRequest, dir: URL) {
        self.request = request
        self.dir = dir
        self.startNs = Clock.nowNs()
    }

    private func mark(_ name: String) {
        let ms = Double(Clock.nowNs() &- startNs) / 1e6
        lock.lock(); timing[name] = ms; lock.unlock()
    }

    private func at(_ s: String) {
        lock.lock(); step = s; lock.unlock()
    }

    /// Call-once, like `finishStart`. The backstop, the content callback, the
    /// screenshot completion and the writer all answer through here.
    private func finish(_ result: Result<[String: Any], StillError>) {
        lock.lock()
        let c = completion
        completion = nil
        lock.unlock()
        c?(result)
    }

    func run(completion: @escaping (Result<[String: Any], StillError>) -> Void) {
        lock.lock(); self.completion = completion; lock.unlock()

        // Armed before the first callback API, so it covers the whole request
        // (the STC-258 lesson: a backstop armed after content enumeration
        // bounds only the part after it answers).
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.timeoutSeconds) { [weak self] in
            guard let self else { return }
            self.lock.lock(); let s = self.step; self.lock.unlock()
            self.finish(.failure(.timedOut(lastStep: s)))
        }

        guard ScreenshotAPI.available else { finish(.failure(.unsupported)); return }

        at("content")
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, err in
            guard let self else { return }
            self.mark("contentMs")
            guard let content, !content.displays.isEmpty else {
                self.finish(.failure(.noDisplays(underlying: err)))
                return
            }
            // Off ScreenCaptureKit's callback queue: a recording may be live
            // and that queue is its, not ours.
            DispatchQueue.global(qos: .userInitiated).async { self.capture(content: content) }
        }
    }

    private func capture(content: SCShareableContent) {
        at("configure")
        let cfg = SCStreamConfiguration()
        let filter: SCContentFilter
        let geometry: DisplayGeometry
        var crop: StillRect? = nil
        var window: StillWindowInfo? = nil
        let pixelSize: (width: Int, height: Int)

        switch request.kind {
        case .displayCrop:
            let display: SCDisplay
            if let id = request.displayId {
                // A wrong display is a wrong answer, not a fallback: `start`
                // falls back to the first display because a recording can be
                // stopped; a still is over before anyone could notice.
                guard let d = content.displays.first(where: { $0.displayID == id }) else {
                    finish(.failure(.noSuchDisplay(id))); return
                }
                display = d
            } else {
                display = content.displays[0]
            }
            geometry = displayGeometry(id: display.displayID,
                                       pointWidth: display.width, pointHeight: display.height)
            guard case .region(let region) = resolveCrop(request.crop, pointWidth: geometry.pointWidth,
                                                         pointHeight: geometry.pointHeight) else {
                finish(.failure(.cropOutsideDisplay)); return
            }
            crop = region
            filter = SCContentFilter(display: display, excludingWindows: [])
            // Display-local points, which is what sourceRect takes for a
            // display filter. The whole display when no crop was asked for.
            cfg.sourceRect = region.cgRect
            pixelSize = framePixelSize(points: region, backingScale: geometry.backingScale)

        case .window:
            guard let id = request.windowId,
                  let win = content.windows.first(where: { $0.windowID == id }) else {
                finish(.failure(.noSuchWindow(request.windowId ?? 0))); return
            }
            // The window's display is the one under its centre; a window
            // straddling two displays is attributed to whichever holds more of
            // its middle, and its bounds are expressed in THAT display's points.
            let mid = CGPoint(x: win.frame.midX, y: win.frame.midY)
            let display = content.displays.first { CGDisplayBounds($0.displayID).contains(mid) }
                ?? content.displays[0]
            geometry = displayGeometry(id: display.displayID,
                                       pointWidth: display.width, pointHeight: display.height)
            let bounds = StillRect(x: Double(win.frame.minX) - geometry.originX,
                                   y: Double(win.frame.minY) - geometry.originY,
                                   width: Double(win.frame.width), height: Double(win.frame.height))
            window = StillWindowInfo(id: Int(win.windowID),
                                     app: win.owningApplication?.applicationName,
                                     title: win.title, bounds: bounds)
            filter = SCContentFilter(desktopIndependentWindow: win)
            pixelSize = framePixelSize(points: bounds, backingScale: geometry.backingScale)
            // Alpha end to end: no desktop behind the window and no compositor
            // shadow — the shadow is synthesised at render time (STC-291).
            // Both are 14+ knobs; on a 14+ OS they exist, and the reply says
            // whether they were taken.
            let shadows = setIfSupported(cfg, "ignoreShadowsSingleWindow", true)
            let nonOpaque = setIfSupported(cfg, "shouldBeOpaque", false)
            lock.lock()
            timing["ignoreShadows"] = shadows ? 1 : 0
            timing["nonOpaque"] = nonOpaque ? 1 : 0
            lock.unlock()
        }

        cfg.width = pixelSize.width
        cfg.height = pixelSize.height
        cfg.scalesToFit = false
        // The pointer is a sample in shot.json, drawn at render time if at all;
        // the pixels must not already contain one.
        cfg.showsCursor = false
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        // SCCaptureResolutionType.best (1): full backing resolution. Explicit
        // width/height already ask for it; this says so where the API listens.
        setIfSupported(cfg, "captureResolution", 1)

        // As close to the frame as the API allows: sampled on this thread
        // immediately before the screenshot is requested, position first.
        let cursor = sampleCursor(display: geometry)

        at("capture")
        let capturedAtNs = Clock.nowNs()
        let issued = ScreenshotAPI.captureImage(filter: filter, configuration: cfg) { [weak self] image, error in
            guard let self else { return }
            self.mark("captureMs")
            guard let image else { self.finish(.failure(.captureFailed(error))); return }
            DispatchQueue.global(qos: .userInitiated).async {
                self.write(image: image, capturedAtNs: capturedAtNs, geometry: geometry,
                           crop: crop, window: window, cursor: cursor)
            }
        }
        if !issued { finish(.failure(.unsupported)) }
    }

    private func sampleCursor(display: DisplayGeometry) -> StillCursorSample? {
        let loc = NSEvent.mouseLocation
        let mainHeight = Double(CGDisplayBounds(CGMainDisplayID()).height)
        let bounds = CGRect(x: display.originX, y: display.originY,
                            width: Double(display.pointWidth), height: Double(display.pointHeight))
        guard let p = localizeCursor(mouseX: Double(loc.x), mouseY: Double(loc.y),
                                     mainDisplayHeight: mainHeight, display: bounds) else { return nil }
        return StillCursorSample(x: p.x, y: p.y, shape: StillCursor.currentShape())
    }

    private static func hasAlpha(_ image: CGImage) -> Bool {
        switch image.alphaInfo {
        case CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast: return false
        default: return true
        }
    }

    private func write(image: CGImage, capturedAtNs: UInt64, geometry: DisplayGeometry,
                       crop: StillRect?, window: StillWindowInfo?, cursor: StillCursorSample?) {
        at("write")
        let url = dir.appendingPathComponent(request.file)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            finish(.failure(.writeFailed("could not create \(request.file)"))); return
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else {
            try? FileManager.default.removeItem(at: url)
            finish(.failure(.writeFailed("PNG encode of \(request.file) failed"))); return
        }
        mark("writeMs")

        let alpha = Self.hasAlpha(image)
        let frame = StillFrameInfo(file: request.file, width: image.width, height: image.height,
                                   alpha: request.kind == .window && alpha)
        let colorSpace = image.colorSpace?.name.map { $0 as String }
        let doc = shotDocument(kind: request.kind, capturedAtNs: capturedAtNs,
                               timebase: (Int(Clock.timebase.numer), Int(Clock.timebase.denom)),
                               display: geometry, colorSpace: colorSpace,
                               crop: crop, window: window, frame: frame, cursor: cursor)
        guard let data = try? JSONSerialization.data(withJSONObject: doc, options: [.sortedKeys, .prettyPrinted]) else {
            finish(.failure(.writeFailed("shot.json could not be encoded"))); return
        }
        do { try data.write(to: dir.appendingPathComponent("shot.json")) }
        catch { finish(.failure(.writeFailed("shot.json: \(error)"))); return }
        mark("totalMs")

        lock.lock(); let t = timing; lock.unlock()
        var reply: [String: Any] = ["dir": dir.path, "file": request.file, "shot": doc, "timing": t]
        if request.kind == .window && !alpha {
            // Honest rather than promised: the document says selected-area and
            // the reply says why, instead of a window-only mode over pixels
            // that cannot support it.
            reply["alphaWarning"] = "the window capture came back without an alpha channel; "
                + "decoration is selected-area, not window-only"
        }
        finish(.success(reply))
    }
}

/// `windows`: the on-screen windows a window shot can name, for the picker
/// (STC-290) and for `still.grant.test.ts`. Layer 0 only — menus, the Dock and
/// overlays live on other layers and are not what "capture that window" means.
/// Bounded like a still; answers exactly once.
enum WindowList {
    static func enumerate(completion: @escaping (Result<[String: Any], StillError>) -> Void) {
        let lock = NSLock()
        var pending: ((Result<[String: Any], StillError>) -> Void)? = completion
        let answer: (Result<[String: Any], StillError>) -> Void = { r in
            lock.lock(); let c = pending; pending = nil; lock.unlock()
            c?(r)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + StillCapture.timeoutSeconds) {
            answer(.failure(.timedOut(lastStep: "windows")))
        }
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, err in
            guard let content, !content.displays.isEmpty else {
                answer(.failure(.noDisplays(underlying: err))); return
            }
            let displays = content.displays.map { ($0.displayID, CGDisplayBounds($0.displayID)) }
            var out: [[String: Any]] = []
            for w in content.windows where w.windowLayer == 0 && w.frame.width > 0 && w.frame.height > 0 {
                let mid = CGPoint(x: w.frame.midX, y: w.frame.midY)
                var o: [String: Any] = [
                    "id": Int(w.windowID),
                    "x": Double(w.frame.minX), "y": Double(w.frame.minY),
                    "width": Double(w.frame.width), "height": Double(w.frame.height),
                ]
                if let app = w.owningApplication {
                    o["app"] = app.applicationName
                    o["pid"] = Int(app.processID)
                }
                if let t = w.title, !t.isEmpty { o["title"] = t }
                if let d = displays.first(where: { $0.1.contains(mid) }) { o["displayId"] = Int(d.0) }
                out.append(o)
            }
            answer(.success(["windows": out,
                             "displays": content.displays.map { ["id": Int($0.displayID),
                                                                  "pointWidth": $0.width,
                                                                  "pointHeight": $0.height] }]))
        }
    }
}
