import Foundation
import ScreenCaptureKit
import CoreGraphics
// AVFoundation here is AVAssetWriter only — a file writer, no capture devices.
// PHASE-0 §2a's hazard was AVCaptureDevice taking the default audio input;
// phase 1 has no camera or mic, and nothing below opens a device.
import AVFoundation

/// Display + cursor capture for one session.
///
/// VFR by construction (PHASE-0 §4): a complete frame becomes exactly one
/// sample at its own displayTime; idle/blank frames produce nothing. The
/// rejected alternative — repeat-filling to a CFR grid during capture — spent
/// 82% of a loaded encoder on duplicates and dropped 60% of real content.
///
/// Every time written here is session-relative integer nanoseconds, so
/// display.mp4's sample table and events.json share one origin and the
/// transform can consume both without a correction term.
final class CaptureSession: NSObject, SCStreamOutput, SCStreamDelegate {
    let dir: URL
    let t0Ns: UInt64

    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?

    private var displayID: CGDirectDisplayID = 0
    private var pointW = 0, pointH = 0, pixelW = 0, pixelH = 0
    private var originX = 0.0, originY = 0.0
    private var captureW = 0, captureH = 0

    private let lock = NSLock()
    private var events: [[String: Any]] = []
    private var framesAppended = 0
    private var framesDropped = 0
    private var framesNonMonotonic = 0
    private var lastPtsNs: Int64 = -1
    private var firstFramePtsNs: Int64 = -1
    private var tapReenables = 0

    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var tapRunLoop: CFRunLoop?

    init(dir: URL, t0Ns: UInt64) {
        self.dir = dir
        self.t0Ns = t0Ns
    }

    // MARK: - start

    func start(displayId: CGDirectDisplayID?, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, err in
            guard let self else { return }
            guard let content, !content.displays.isEmpty else {
                // PHASE-0 §6: this is the ungranted path and it fails in ~10 ms
                // with -3801 rather than hanging. Report it as a permission
                // problem, which is what it almost always is.
                completion(.failure(CaptureError.noDisplays(underlying: err)))
                return
            }
            let display = displayId.flatMap { id in content.displays.first { $0.displayID == id } }
                ?? content.displays[0]
            self.begin(display: display, completion: completion)
        }
    }

    private func begin(display: SCDisplay, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        displayID = display.displayID
        pointW = display.width
        pointH = display.height
        let bounds = CGDisplayBounds(displayID)
        originX = Double(bounds.origin.x)
        originY = Double(bounds.origin.y)
        if let mode = CGDisplayCopyDisplayMode(displayID) {
            pixelW = mode.pixelWidth
            pixelH = mode.pixelHeight
        } else {
            pixelW = pointW; pixelH = pointH
        }
        (captureW, captureH) = captureSize(pixelW, pixelH)

        do {
            try setupWriter()
            try startStream(display: display) { [weak self] err in
                guard let self else { return }
                if let err {
                    completion(.failure(CaptureError.streamFailed(err)))
                } else {
                    self.startEventTap()
                    completion(.success(self.describe()))
                }
            }
        } catch {
            completion(.failure(error))
        }
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("display.mp4")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // The start-to-first-frame gap becomes an empty edit whose duration is
        // quantised to the MOVIE timescale. At the 600 Hz default that is 1.67 ms
        // of granularity on a value a reader must recover exactly; 90 kHz cuts
        // the worst-case recovery error to ~5.5 us.
        w.movieTimeScale = 90_000
        // PHASE-0 §8, verified settings. AllowFrameReordering=false matters:
        // no B-frames means decode order equals presentation order, which is
        // what lets a sink map a decoded frame back to an index without a sort.
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: captureW,
            AVVideoHeightKey: captureH,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 50_000_000,
                AVVideoMaxKeyFrameIntervalKey: 45,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ])
        inp.expectsMediaDataInRealTime = true
        // Sample times survive as exact integer nanoseconds, so the demuxed
        // PTS grid is the transform's frame grid with no rescaling.
        inp.mediaTimeScale = 1_000_000_000
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: nil)
        guard w.canAdd(inp) else { throw CaptureError.writerRejectedInput }
        w.add(inp)
        guard w.startWriting() else { throw CaptureError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w; input = inp; adaptor = ad
    }

    /// Never block waiting on startCapture's completion. This runs on
    /// ScreenCaptureKit's own callback queue, and startCapture dispatches its
    /// completion to that same queue — so a semaphore wait here deadlocks
    /// against itself and only unwedges when the timeout fires. That cost a
    /// flat 10 s on every start, which AVAssetWriter then baked into the file
    /// as a 10 s empty edit.
    private func startStream(display: SCDisplay, completion: @escaping (Error?) -> Void) throws {
        let cfg = SCStreamConfiguration()
        cfg.width = captureW
        cfg.height = captureH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        cfg.queueDepth = 8
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.scalesToFit = false
        // The transform composites the cursor from events.json, so the captured
        // pixels must not already contain one — otherwise every export shows two.
        cfg.showsCursor = false
        // macOS 14+, absent from the 13.3 SDK headers but present at runtime
        // (PHASE-0 §7). Explicit width/height governs output size regardless.
        if cfg.responds(to: Selector(("setCaptureResolution:"))) {
            cfg.setValue(3, forKey: "captureResolution")
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen,
                              sampleHandlerQueue: DispatchQueue(label: "stc.capture.screen"))
        stream = s
        s.startCapture { completion($0) }
    }

    // MARK: - frames

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        autoreleasepool {
            guard type == .screen,
                  let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false)
                            as? [[SCStreamFrameInfo: Any]],
                  let att = arr.first,
                  let statusRaw = att[.status] as? Int,
                  statusRaw == SCFrameStatus.complete.rawValue,
                  let dtRaw = att[.displayTime] as? UInt64,
                  let pb = CMSampleBufferGetImageBuffer(sb)
            else { return }   // idle/blank/suppressed: VFR emits nothing, not a repeat

            // displayTime is mach ticks (41.667 ns here) and MUST be converted;
            // it is also the scheduled VBL presentation time, ~7 ms ahead of
            // delivery — which is the right reference for "what the user saw".
            let dtNs = Clock.toNs(dtRaw)
            guard dtNs >= t0Ns else { return }
            let ptsNs = Int64(dtNs - t0Ns)

            lock.lock()
            if ptsNs <= lastPtsNs {
                framesNonMonotonic += 1
                lock.unlock()
                return
            }
            lastPtsNs = ptsNs
            if firstFramePtsNs < 0 { firstFramePtsNs = ptsNs }
            lock.unlock()

            guard let input, let adaptor, input.isReadyForMoreMediaData else {
                lock.lock(); framesDropped += 1; lock.unlock()
                return
            }
            let ok = adaptor.append(pb, withPresentationTime: CMTime(value: ptsNs, timescale: 1_000_000_000))
            lock.lock()
            if ok { framesAppended += 1 } else { framesDropped += 1 }
            lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        IO.send("warning", ["code": "stream-stopped", "detail": "\(error)"])
    }

    // MARK: - event tap

    /// Runs on its own thread and run loop. If the tap's run loop is starved
    /// the system disables it (`tapDisabledByTimeout`), so it must not share a
    /// run loop with anything that can block — including command dispatch.
    private func startEventTap() {
        let mask: CGEventMask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDragged.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else { return Unmanaged.passUnretained(event) }
            let me = Unmanaged<CaptureSession>.fromOpaque(userInfo).takeUnretainedValue()
            me.handleTapEvent(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }

        let t = Thread { [weak self] in
            guard let self else { return }
            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap,
                options: .listenOnly, eventsOfInterest: mask,
                callback: callback,
                userInfo: Unmanaged.passUnretained(self).toOpaque())
            else {
                IO.send("warning", ["code": "event-tap-unavailable",
                                    "detail": "CGEvent.tapCreate returned nil — Input Monitoring not granted; recording video only"])
                return
            }
            self.tap = tap
            let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            self.tapSource = src
            self.tapRunLoop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            CFRunLoopRun()
        }
        t.name = "event-tap"
        t.start()
    }

    private func handleTapEvent(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            lock.lock(); tapReenables += 1; lock.unlock()
            return
        }
        let kind: String
        var button: Int? = nil
        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged: kind = "move"
        case .leftMouseDown:  kind = "down"; button = 0
        case .leftMouseUp:    kind = "up";   button = 0
        case .rightMouseDown: kind = "down"; button = 1
        case .rightMouseUp:   kind = "up";   button = 1
        default: return
        }
        // CGEvent.timestamp is ALREADY nanoseconds on the same epoch as the
        // converted displayTime — converting it would be a 41.667x error.
        let ts = event.timestamp
        guard ts >= t0Ns else { return }
        let loc = event.location
        var e: [String: Any] = ["t": Int(ts - t0Ns), "kind": kind,
                                "x": loc.x, "y": loc.y]
        if let button { e["button"] = button }
        lock.lock()
        events.append(e)
        lock.unlock()
    }

    // MARK: - stats and stop

    func stats() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["frames": framesAppended, "dropped": framesDropped,
                "nonMonotonic": framesNonMonotonic, "events": events.count,
                "tapReenables": tapReenables]
    }

    func describe() -> [String: Any] {
        ["display": displayID, "capture": ["width": captureW, "height": captureH],
         "source": ["pixelWidth": pixelW, "pixelHeight": pixelH]]
    }

    /// Tears down capture and writes events.json and anchors.json.
    func stop(reason: String, completion: @escaping ([String: Any]) -> Void) {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let tapRunLoop { CFRunLoopStop(tapRunLoop) }

        let finishUp: () -> Void = { [weak self] in
            guard let self else { return }
            let s = self.stats()
            self.writeSidecars(reason: reason)
            completion(s)
        }

        guard let stream else { finishUp(); return }
        stream.stopCapture { [weak self] _ in
            guard let self else { return }
            self.input?.markAsFinished()
            guard let writer = self.writer else { finishUp(); return }
            writer.finishWriting { finishUp() }
        }
    }

    private func writeSidecars(reason: String) {
        lock.lock()
        let evs = events
        lock.unlock()

        write(["version": 1, "events": evs], to: "events.json")
        write([
            "version": 1,
            "timebase": ["numer": Int(Clock.timebase.numer), "denom": Int(Clock.timebase.denom)],
            // String on purpose: boot-relative ns crosses 2^53 at ~104 days of
            // uptime, and a JSON number would round.
            "t0Ns": String(t0Ns),
            "display": ["id": Int(displayID), "pointWidth": pointW, "pointHeight": pointH,
                        "pixelWidth": pixelW, "pixelHeight": pixelH,
                        "backingScale": pointW > 0 ? Double(pixelW) / Double(pointW) : 1.0,
                        "originX": originX, "originY": originY],
            // Exact, from the helper's own clock. The same offset survives in the
            // file only as a timescale-quantised empty edit, so this is what a
            // reader checks its recovered value against.
            "capture": ["width": captureW, "height": captureH, "codec": "h264",
                        "firstFrameNs": max(0, Int(firstFramePtsNs))],
            "files": ["display": "display.mp4"],
            "stop": ["t": Int(Clock.nowNs() - t0Ns), "reason": reason],
        ], to: "anchors.json")
    }

    private func write(_ o: Any, to name: String) {
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else {
            IO.send("error", ["code": "sidecar-encode-failed", "file": name]); return
        }
        try? d.write(to: dir.appendingPathComponent(name))
    }
}

enum CaptureError: Error, CustomStringConvertible {
    case noDisplays(underlying: Error?)
    case writerRejectedInput
    case writerFailed(Error?)
    case streamFailed(Error)

    var description: String {
        switch self {
        case .noDisplays(let e):
            return "no displays available — Screen Recording permission is the usual cause (\(e.map { "\($0)" } ?? "no error"))"
        case .writerRejectedInput: return "AVAssetWriter rejected the video input"
        case .writerFailed(let e): return "AVAssetWriter failed to start: \(e.map { "\($0)" } ?? "unknown")"
        case .streamFailed(let e): return "SCStream failed to start: \(e)"
        }
    }
    var code: String {
        switch self {
        case .noDisplays: return "no-displays"
        case .writerRejectedInput: return "writer-rejected-input"
        case .writerFailed: return "writer-failed"
        case .streamFailed: return "stream-failed"
        }
    }
}
