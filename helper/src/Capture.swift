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
    /// Optional subsystem: nil unless `start` was asked for a camera AND it
    /// actually opened. A missing/denied/busy camera leaves this nil and the
    /// take display-only — see the warning path in `start`.
    ///
    /// Guarded by `lock`, same as `events` and the frame counters below —
    /// NOT a bare `var`. The camera opens on a background queue (see
    /// `startCameraAsync`) while `stop()` can arrive on a different queue at
    /// any time, including before the camera has finished opening. Without a
    /// lock, `stop()` can observe `camera == nil`, skip teardown entirely, and
    /// then have the background open assign into `camera` afterward — nothing
    /// ever stops that instance, so the AVCaptureSession (and its LED) runs
    /// for the rest of the process's life. `stoppingBegan` closes the other
    /// half of the race: it tells a camera that finishes opening AFTER stop()
    /// has already run that it must stop itself immediately rather than be
    /// stored.
    private var camera: CameraCapture?
    private var cameraTrack: CameraTrack?
    /// Set once, in `begin`, from `start`'s own argument. `writeSidecars` reads
    /// it to decide whether anchors.json's `camera` block is written at all
    /// (STC-303) — camera==nil is ambiguous between "never asked" and "asked,
    /// got nothing", and only this flag tells the two apart.
    private var wantCamera = false
    private var stoppingBegan = false
    /// Guards RE-ENTRY into `stop()` itself (STC-305). `App.start`'s success
    /// handler can call `stop()` a second time on a session whose teardown is
    /// already in flight — a stray success racing a `stop` that arrived while
    /// `startStream()` had already assigned a real `stream` but before
    /// `startCapture`'s own completion had fired. Both `stream.stopCapture`
    /// and `writer.finishWriting` are only safe to invoke once per session:
    /// `WriterGate.closeAndMarkFinished()` already refuses a second
    /// `markAsFinished`, but its caller never checked that return value, so a
    /// second `stop()` reaching `finishWriting` a second time was the exact
    /// AVAssetWriter teardown race this codebase already fixed once (STC-254),
    /// reachable again through a second call site. `stopStarted` /
    /// `stopCompletions` / `stopStats` make every caller past the first
    /// coalesce onto the ONE real teardown instead of starting another.
    private var stopStarted = false
    private var stopCompletions: [([String: Any]) -> Void] = []
    private var stopStats: [String: Any]?
    /// The input and adaptor live behind the gate, not here: every access to
    /// them is either an append or a teardown, and those two must not overlap
    /// (STC-254). Holding them as plain properties is what allowed the overlap.
    private let gate = WriterGate()

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
    /// Every disable the tap reported, by reason, and separately those that
    /// arrived after stop() had disabled it on purpose (which are expected
    /// and are neither counted as re-enables nor acted on).
    private var tapDisables: [String: Int] = [:]
    private var tapDisablesAfterStop = 0
    private var cursorEvents = 0
    private var cursorSampler: CursorSampler?
    private var cursorRunLoop: CFRunLoop?

    /// How often the system pointer is sampled for shape changes (STC-309).
    ///
    /// MEASURED 2026-09-03 with the `cursor-probe` command on real hardware:
    /// a sample costs 1.04 ms on average and 41 ms at worst (599 samples), so
    /// it is NOT microseconds and does NOT run on the tap's thread — a 41 ms
    /// stall on the run loop that answers WindowServer is how a tap gets
    /// disabled (`tapDisabledByTimeout`). The sampler has its own thread
    /// (`startCursorSampler`); ordering against the moves is restored at
    /// write time by `orderedEvents`. At 30 Hz that is ~3% of one core, and a
    /// hover is seen up to 33 ms late, two output frames at 60 fps. Do not
    /// chase it lower without a measurement showing that lag is visible.
    static let cursorSampleIntervalSeconds: Double = 1.0 / 30

    /// `STC_NO_CURSOR_SAMPLER=1`: see startCursorSampler.
    static let cursorSamplerDisabledForDiagnosis: Bool =
        ProcessInfo.processInfo.environment["STC_NO_CURSOR_SAMPLER"].map { !$0.isEmpty && $0 != "0" } ?? false

    /// A start must be answered exactly once, by whichever path gets there
    /// first. SCStream can fail through `didStopWithError` INSTEAD of through
    /// startCapture's completion (seen as -3805 "application connection being
    /// interrupted"), and with only the completion wired the request hung
    /// forever. A protocol where some requests are never answered is worse than
    /// one that answers with an error.
    private var startCompletion: ((Result<[String: Any], Error>) -> Void)?
    /// How long a `start` may take before it is answered with `start-timeout`.
    /// Covers the WHOLE request — content enumeration included (STC-258).
    /// `helper/test/capture.test.ts` bounds its own waits above this; if this
    /// value grows, those bounds must grow with it or the test races the
    /// backstop instead of observing it.
    static let startTimeoutSeconds: Double = 15

    /// How long teardown gets before `stop` answers anyway.
    ///
    /// STC-259 step 3 asked whether the append needs a bound of its own, the
    /// way the writer-gate harness now bounds its first one. It does not, and
    /// one could not be built there: `WriterGate` holds its lock ACROSS the
    /// append precisely so teardown cannot race it (that is the STC-254 fix),
    /// so abandoning a wedged append would leave that lock held forever and
    /// `closeAndMarkFinished()` below would still never return. The wedge
    /// reaches the lock whatever the append does. THIS is the bound that
    /// contains it — a wedged first append costs a take its finalised mp4 and
    /// answers `<reason>-timeout` with a `stopWarning`, but it cannot leave the
    /// parent holding a recording it is unable to end.
    ///
    /// Read by `helper/test/stop-bounds.test.ts`, which asserts the whole chain
    /// this sits in. Growing it means growing the client's request timeout too.
    static let stopTimeoutSeconds: Double = 20

    private let startLock = NSLock()

    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var tapRunLoop: CFRunLoop?

    init(dir: URL, t0Ns: UInt64) {
        self.dir = dir
        self.t0Ns = t0Ns
    }

    // MARK: - start

    func start(displayId: CGDirectDisplayID?, camera wantCamera: Bool,
               completion: @escaping (Result<[String: Any], Error>) -> Void) {
        // The backstop is armed HERE, before the first callback API is called,
        // so it covers the whole request rather than only the part after
        // SCShareableContent answers (STC-258).
        //
        // `getExcludingDesktopWindows` is a callback API, and this codebase's
        // rule is to ask what happens when one stays silent: with the backstop
        // armed inside begin() it never ran, so a content enumeration that
        // never called back left `start` unanswered forever. It also meant the
        // request's real bound was "content latency + 15 s" rather than 15 s,
        // which is what made capture.test.ts flaky under load.
        startLock.lock(); startCompletion = completion; startLock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.startTimeoutSeconds) { [weak self] in
            self?.finishStart(.failure(CaptureError.startTimedOut))
        }

        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, err in
            guard let self else { return }
            guard let content, !content.displays.isEmpty else {
                // PHASE-0 §6: this is the ungranted path and it fails in ~10 ms
                // with -3801 rather than hanging. Report it as a permission
                // problem, which is what it almost always is.
                //
                // Answers through finishStart, not the completion directly:
                // the backstop is already armed, so a direct call here would be
                // a second answer to the same request.
                self.finishStart(.failure(CaptureError.noDisplays(underlying: err)))
                return
            }
            let display = displayId.flatMap { id in content.displays.first { $0.displayID == id } }
                ?? content.displays[0]
            self.begin(display: display, camera: wantCamera)
        }
    }

    /// Takes no completion: `start` owns it and every path below answers through
    /// `finishStart`, which is call-once. Handing this a second reference to the
    /// same completion is how a request gets answered twice.
    private func begin(display: SCDisplay, camera wantCamera: Bool) {
        // Recorded before anything can fail below: writeSidecars must know
        // whether a camera was ever asked for, independent of whether this
        // particular start succeeds at opening one.
        self.wantCamera = wantCamera

        // CaptureDecisions.swift hardcodes this so it can be compiled without
        // ScreenCaptureKit. If the framework ever renumbers, refuse to start
        // rather than silently discarding every frame as "not complete".
        //
        // NOT a precondition: this is the capture helper, and the whole protocol
        // rests on it answering every request. Trapping turns a diagnosable
        // "start failed, here is why" into the parent seeing SIGTRAP and having
        // to guess. It cost a CI failure to notice.
        guard SCFrameStatus.complete.rawValue == SCFrameStatusCompleteRaw else {
            finishStart(.failure(CaptureError.frameStatusMismatch(
                actual: SCFrameStatus.complete.rawValue)))
            return
        }
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

        // No backstop is armed here: start() armed one covering this whole
        // request before it called SCShareableContent (STC-258). Arming a
        // second one would answer the same request twice.

        do {
            try setupWriter()
            try startStream(display: display) { [weak self] err in
                guard let self else { return }
                if let err {
                    self.finishStart(.failure(CaptureError.streamFailed(err)))
                } else {
                    self.startEventTap()
                    self.startCursorSampler()
                    // Optional subsystem: it must not sit on the critical path. PHASE-0
                    // recorded camera/mic setup blocking startup once already, and
                    // `AVCaptureSession.startRunning()` is documented as blocking — a
                    // slow or USB camera would otherwise delay every `started` reply
                    // by however long the device takes to open. So the open itself now
                    // runs on a background queue (`startCameraAsync`) and `finishStart`
                    // below does NOT wait for it. Consequence: the device name cannot
                    // be part of THIS reply, because the reply may go out first — it is
                    // reported later as its own event (`camera-started` / `warning`),
                    // success and failure both, whenever the open actually resolves.
                    if wantCamera {
                        self.startCameraAsync()
                    }
                    self.finishStart(.success(self.describe()))
                }
            }
        } catch {
            finishStart(.failure(error))
        }
    }

    /// Call-once. Later callers are no-ops, so a stream that fails after a
    /// successful start reports as a warning rather than a second response.
    private func finishStart(_ result: Result<[String: Any], Error>) {
        startLock.lock()
        let c = startCompletion
        startCompletion = nil
        startLock.unlock()
        c?(result)
    }

    /// Opens the camera off the critical path (MEDIUM 3): `start` already
    /// answered by the time this runs, so a slow or USB device never delays
    /// `started`. Success and failure are both reported as their own event
    /// once the open actually resolves — never folded into `started`.
    ///
    /// Races `stop()` (HIGH 1): if a stop has already begun by the time this
    /// finishes, the camera must not be stored — nothing would ever stop it.
    /// `stoppingBegan` and the decision of whether to store or immediately
    /// close are made under `lock` so the two paths cannot both believe they
    /// own the camera.
    private func startCameraAsync() {
        let dir = self.dir
        let t0Ns = self.t0Ns
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }

            // Re-check immediately before opening the device (MINOR, cheap):
            // a stop that arrived during the dispatch latency above must not
            // be followed by opening the camera and lighting its LED after
            // the take has already ended. This narrows the race; it does not
            // close it — stop() can still arrive during cam.start() itself,
            // which is why the post-open check below exists too.
            self.lock.lock()
            let stoppingAlready = self.stoppingBegan
            self.lock.unlock()
            if stoppingAlready { return }

            let cam = CameraCapture(dir: dir, t0Ns: t0Ns)
            let result = cam.start()
            let opened: Bool
            if case .success = result { opened = true } else { opened = false }

            // The store-vs-close race (HIGH 1) is decided by a pure function
            // (CaptureDecisions.swift) so it is testable without a live
            // camera — see helper/test/decisions/main.swift.
            self.lock.lock()
            let decision = decideCameraOpen(opened: opened, stoppingBegan: self.stoppingBegan)
            if decision == .store { self.camera = cam }
            self.lock.unlock()

            switch decision {
            case .store:
                if case .success(let name) = result {
                    // Reliable, not lossy (MEDIUM 4): describe() deliberately
                    // omits the camera, so this event is the ONLY signal that
                    // the camera is live. IO.stat is the drop-oldest ring and
                    // discards precisely under the load this most needs to
                    // survive; IO.send never drops.
                    IO.send("camera-started", ["device": name])
                }
            case .closeImmediately:
                // stop() already ran and found no camera to close, because
                // this one had not opened yet. Close it now — this take's
                // sidecars are likely already written, so the track is
                // discarded, but the AVCaptureSession must not be left
                // running for the rest of the process's life.
                cam.stop { _ in }
            case .reportFailure:
                if case .failure(let e) = result {
                    let ce = e as? CameraError
                    IO.send("warning", ["code": ce?.code ?? "camera-failed",
                                        "detail": ce.map { $0.description } ?? "\(e)"])
                }
            }
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
        writer = w
        gate.install(input: inp, adaptor: ad)
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
                  let dtRaw = att[.displayTime] as? UInt64,
                  let pb = CMSampleBufferGetImageBuffer(sb)
            else { return }

            // The decision itself lives in CaptureDecisions.swift so it can be
            // tested without a live stream. displayTime is mach ticks and is
            // converted there; it is the scheduled VBL presentation time, ~7 ms
            // ahead of delivery, which is the right reference for what the user saw.
            lock.lock()
            let decision = decideFrame(statusRaw: statusRaw, displayTimeRaw: dtRaw,
                                       timebase: (Clock.timebase.numer, Clock.timebase.denom),
                                       t0Ns: t0Ns, lastPtsNs: lastPtsNs)
            let ptsNs: Int64
            switch decision {
            case .skip:
                lock.unlock(); return       // idle/blank/suppressed: VFR emits nothing
            case .nonMonotonic:
                framesNonMonotonic += 1; lock.unlock(); return
            case .accept(let pts):
                ptsNs = pts
                lastPtsNs = pts
                if firstFramePtsNs < 0 { firstFramePtsNs = pts }
            }
            lock.unlock()

            // The gate decides whether this frame may still be written, and
            // holds its own lock across the append so a concurrent stop cannot
            // tear the track down mid-append. A frame that arrives during
            // teardown is dropped, not written into a closing writer.
            let outcome = gate.append(pb, at: CMTime(value: ptsNs, timescale: 1_000_000_000))
            lock.lock()
            if outcome == .appended { framesAppended += 1 } else { framesDropped += 1 }
            lock.unlock()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        // If the start is still pending this IS its answer — the stream died on
        // the way up rather than reporting through startCapture's completion.
        finishStart(.failure(CaptureError.streamFailed(error)))
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
            // Runs until stop() calls CFRunLoopStop. Unbounded by design: this
            // is the tap's own thread, and a run loop that returned early would
            // silently stop delivering input for the rest of the recording.
            CFRunLoopRun()
        }
        t.name = "event-tap"
        t.start()
    }

    /// STC-309: samples the pointer's SHAPE on a thread of its own.
    ///
    /// The first draft put the timer on the tap's run loop so one thread would
    /// own the order of everything appended to `events`. The probe then
    /// measured a sample at 1 ms typical and 41 ms worst — enough to hold up
    /// the tap's answer to WindowServer — so the sampler lives here instead,
    /// and `orderedEvents` restores time order when the file is written.
    /// Nothing else runs on this loop, so a slow sample costs nobody but the
    /// sampler. Mirrors the tap thread: a plain Thread, its own CFRunLoop,
    /// stopped by `stop()`.
    ///
    /// The references are measured now, on this machine, at its current
    /// pointer size and scale — never a baked-in table.
    private func startCursorSampler() {
        // DIAGNOSTIC control, not a feature: a take that differs from a normal
        // one ONLY by having no sampler, so a fault seen with it running can
        // be compared against one without. Read once at launch, like
        // --stats-interval-ms. Announced so a take recorded this way can
        // never pass for one where the pointer simply never changed.
        if Self.cursorSamplerDisabledForDiagnosis {
            IO.send("warning", ["code": "cursor-sampler-disabled",
                                "detail": "STC_NO_CURSOR_SAMPLER is set; this take will carry no cursor-shape events"])
            return
        }
        let t = Thread { [weak self] in
            guard let self else { return }
            let (refs, missing) = CursorShape.references()
            if !missing.isEmpty {
                let names = missing.joined(separator: ", ")
                IO.send("warning", ["code": "cursor-references-incomplete",
                                    "detail": "no bitmap for \(names); those shapes will be written as arrow",
                                    "missing": missing])
            }
            let sampler = CursorSampler(references: refs) { [weak self] shape, observedNs in
                self?.recordCursorShape(shape, observedNs: observedNs)
            }
            let rl: CFRunLoop = CFRunLoopGetCurrent()
            sampler.schedule(on: rl, intervalSeconds: Self.cursorSampleIntervalSeconds)
            // Published under `lock` in the same critical section stop() reads
            // it in, with `stoppingBegan` as the tie-break: a stop that lands
            // before this thread gets here would otherwise find no loop to
            // stop, and the sampler would run for the rest of the process's
            // life — the same shape as the camera's HIGH 1 race.
            self.lock.lock()
            if self.stoppingBegan {
                self.lock.unlock()
                sampler.invalidate()
                return
            }
            self.cursorSampler = sampler
            self.cursorRunLoop = rl
            self.lock.unlock()
            // Unbounded by design, like the tap's: stop() ends it.
            CFRunLoopRun()
            // Nothing runs this loop again, so no tick can follow; invalidating
            // here, on the loop's own thread, just releases the timer.
            sampler.invalidate()
        }
        t.name = "cursor-sampler"
        t.start()
    }

    private func handleTapEvent(type: CGEventType, event: CGEvent) {
        // CGEvent.timestamp is ALREADY nanoseconds on the same epoch as the
        // converted displayTime — converting it would be a 41.667x error in the
        // other direction. The mapping lives in CaptureDecisions.swift.
        switch decideCursorEvent(type: type, timestampNs: event.timestamp, t0Ns: t0Ns) {
        case .reenableTap(let reason):
            // stop() disables the tap itself, and CoreGraphics reports that
            // back here as a user-input disable. Re-enabling it would undo the
            // stop, and counting it made every take look as if the tap had
            // been starved once. So: after stop began, note it and do nothing.
            lock.lock()
            let stopping = stoppingBegan
            if stopping {
                tapDisablesAfterStop += 1
            } else {
                tapReenables += 1
                tapDisables[reason.rawValue, default: 0] += 1
            }
            lock.unlock()
            if !stopping, let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        case .ignore, .beforeStart:
            return
        case .event(let t, let kind, let button):
            let loc = event.location
            var e: [String: Any] = ["t": t, "kind": kind, "x": loc.x, "y": loc.y]
            if let button { e["button"] = button }
            lock.lock()
            events.append(e)
            lock.unlock()
        }
    }

    /// A pointer-shape change, from the sampler on the tap thread (STC-309).
    /// `observedNs` is the helper's own clock — the same mach epoch
    /// `CGEvent.timestamp` is on — so `t` shares the moves' origin exactly.
    private func recordCursorShape(_ shape: String, observedNs: UInt64) {
        // Mirrors decideCursorEvent's .beforeStart: the schema requires t >= 0.
        guard observedNs >= t0Ns else { return }
        lock.lock()
        events.append(["t": Int(observedNs - t0Ns), "kind": "cursor", "shape": shape])
        cursorEvents += 1
        lock.unlock()
    }

    // MARK: - stats and stop

    func stats() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        // `events` counts everything in the file, cursor events included;
        // `cursorEvents` is the shape changes alone, so the app can show the
        // two side by side and a take with no pointer motion still reads as
        // such.
        return ["frames": framesAppended, "dropped": framesDropped,
                "nonMonotonic": framesNonMonotonic, "events": events.count,
                "cursorEvents": cursorEvents,
                "tapReenables": tapReenables,
                // Which kind, so a re-enable can be read as starvation or not.
                "tapDisabled": ["timeout": tapDisables["timeout"] ?? 0,
                                "userInput": tapDisables["userInput"] ?? 0,
                                "afterStop": tapDisablesAfterStop]]
    }

    /// No camera field here on purpose: the camera opens asynchronously (see
    /// `startCameraAsync`), so at the moment this is called for the `started`
    /// reply, whether it has resolved yet is not something the caller should
    /// be able to depend on. Its outcome is reported separately, once known.
    func describe() -> [String: Any] {
        ["display": displayID, "capture": ["width": captureW, "height": captureH],
         "source": ["pixelWidth": pixelW, "pixelHeight": pixelH]]
    }

    /// Tears down capture and writes events.json and anchors.json.
    ///
    /// Answers exactly once, by whichever path gets there first. `start` was
    /// given this guarantee in increment 2 and `stop` was not — and it is
    /// arguably more important here: neither `stopCapture` nor `finishWriting`
    /// promises to call back, and when they do not the parent is left holding a
    /// recording it cannot end. Seen on a CI runner as
    /// `request "stop" (seq 2) timed out after 30000ms`.
    ///
    /// On timeout the sidecars are still written. A take whose display.mp4 was
    /// never finalised is worth more with its events and anchors than without:
    /// the video may still be readable, and if it is not, the sidecars say what
    /// was attempted.
    func stop(reason: String, completion: @escaping ([String: Any]) -> Void) {
        // Re-entry (STC-305): a second call while the first is already
        // tearing down is coalesced onto it rather than starting a second
        // teardown of the same stream/writer. A second call that arrives
        // AFTER the first has already finished is answered immediately with
        // what was already recorded — the take is not re-stopped, and its
        // reason is not rewritten by a later, incidental caller.
        lock.lock()
        if let stats = stopStats {
            lock.unlock()
            completion(stats)
            return
        }
        if stopStarted {
            stopCompletions.append(completion)
            lock.unlock()
            return
        }
        stopStarted = true
        // Set BEFORE reading `camera`: this is the other half of the HIGH 1
        // race. A camera that finishes opening after this point checks the
        // flag (in `startCameraAsync`) and closes itself instead of being
        // stored, so it is not simply skipped and left running. The cursor
        // sampler's run loop is read in the same section for the same reason
        // (startCursorSampler) — still under the one lock acquisition the
        // STC-305 re-entry guard above already holds. And it is set BEFORE
        // the tap is disabled below, so the disable CoreGraphics reports back
        // (handleTapEvent) is seen as ours and not re-enabled or counted.
        stoppingBegan = true
        let cam = camera
        let cursorRL = cursorRunLoop
        lock.unlock()

        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let tapRunLoop { CFRunLoopStop(tapRunLoop) }
        if let cursorRL { CFRunLoopStop(cursorRL) }

        let answerLock = NSLock()
        var answered = false
        let finishUp: (String) -> Void = { [weak self] actualReason in
            answerLock.lock()
            if answered { answerLock.unlock(); return }
            answered = true
            answerLock.unlock()
            guard let self else { return }
            var s = self.stats()
            if actualReason != reason { s["stopWarning"] = "writer did not finalise in time" }
            self.writeSidecars(reason: actualReason)
            self.lock.lock()
            self.stopStats = s
            let extra = self.stopCompletions
            self.stopCompletions = []
            self.lock.unlock()
            completion(s)
            for c in extra { c(s) }
        }

        // HIGH 2 — bound arithmetic. The client (app/src/helper-client.ts,
        // HelperClient's defaultTimeoutMs) gives every request, `stop`
        // included, a flat 30 s timeout. This backstop bounds the
        // display-teardown path at `stopTimeoutSeconds` (unchanged from before
        // the camera existed): stream.stopCapture -> gate.closeAndMarkFinished
        // -> writer.finishWriting. CameraCapture.stop() carries its own,
        // shorter, backstop around session.stopRunning() ->
        // gate.closeAndMarkFinished -> writer.finishWriting and answers exactly
        // once. Both numbers and the client's are asserted as one chain in
        // helper/test/stop-bounds.test.ts rather than kept in step by comment.
        //
        // Both teardowns are entered into the DispatchGroup below before
        // either is awaited, and `cam.stop` is dispatched onto a background
        // queue rather than called inline — AVCaptureSession.stopRunning()
        // is a DOCUMENTED BLOCKING call, so calling it inline here would
        // execute synchronously on whatever queue reaches this line, which
        // for every real caller is the main queue (App.stop runs commands
        // dispatched by IO.readCommands's DispatchQueue.main.async, and
        // calls session.stop inline). A blocking call on the main queue
        // would (a) delay stream.stopCapture from even starting until the
        // camera had fully released, defeating the concurrency this
        // DispatchGroup exists to provide, and (b) stall `status`, `quit`,
        // and the display-reconfiguration watcher for however long the
        // camera takes to close. Dispatching it means the two teardowns
        // genuinely overlap and neither can block command dispatch, so the
        // worst case stays max(20 s, 10 s) = 20 s, comfortably under the
        // client's 30 s bound — and unlike the two backstops racing on
        // shared main-queue time, they now race on entirely separate queues.
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.stopTimeoutSeconds) {
            finishUp("\(reason)-timeout")
        }

        let group = DispatchGroup()

        if let cam {
            group.enter()
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                cam.stop { track in
                    self?.lock.lock()
                    self?.cameraTrack = track
                    self?.camera = nil
                    self?.lock.unlock()
                    group.leave()
                }
            }
        }

        group.enter()
        if let stream {
            stream.stopCapture { [weak self] _ in
                guard let self else { group.leave(); return }
                // Returns only once any in-flight append has finished, so the
                // finishWriting below cannot race one (STC-254).
                self.gate.closeAndMarkFinished()
                guard let writer = self.writer else { group.leave(); return }
                writer.finishWriting { group.leave() }
            }
        } else {
            group.leave()
        }

        group.notify(queue: .global()) {
            finishUp(reason)
        }
    }

    private func writeSidecars(reason: String) {
        lock.lock()
        let evs = events
        let camTrack = cameraTrack
        lock.unlock()

        // events-2 since STC-309: v1 plus `{t, kind: "cursor", shape}`. The
        // loader accepts both; fixtures/basic was already v2. Time-ordered on
        // the way out because two clocks feed `events` (see orderedEvents).
        write(["version": 2, "events": orderedEvents(evs)] as [String: Any], to: "events.json")
        // Exact, from the helper's own clock. The same offset survives in the
        // file only as a timescale-quantised empty edit, so this is what a
        // reader checks its recovered value against.
        let doc = anchorsDocument(
            timebase: (Int(Clock.timebase.numer), Int(Clock.timebase.denom)),
            t0Ns: t0Ns,
            display: DisplayGeometry(id: Int(displayID), pointWidth: pointW, pointHeight: pointH,
                                     pixelWidth: pixelW, pixelHeight: pixelH,
                                     originX: originX, originY: originY),
            capture: CaptureGeometryDoc(width: captureW, height: captureH,
                                        firstFrameNs: Int(firstFramePtsNs)),
            camera: camTrack,
            requested: wantCamera,
            stopReason: reason,
            stopTNs: Int(Clock.nowNs() - t0Ns))
        write(doc, to: "anchors.json")
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
    case startTimedOut
    case frameStatusMismatch(actual: Int)

    var description: String {
        switch self {
        case .noDisplays(let e):
            return "no displays available — Screen Recording permission is the usual cause (\(e.map { "\($0)" } ?? "no error"))"
        case .writerRejectedInput: return "AVAssetWriter rejected the video input"
        case .writerFailed(let e): return "AVAssetWriter failed to start: \(e.map { "\($0)" } ?? "unknown")"
        case .streamFailed(let e): return "SCStream failed to start: \(e)"
        case .startTimedOut: return "capture did not start within 15s and reported no error"
        case .frameStatusMismatch(let actual):
            return "SCFrameStatus.complete is \(actual), not \(SCFrameStatusCompleteRaw) — "
                 + "CaptureDecisions.swift must be updated or every frame will be discarded"
        }
    }
    var code: String {
        switch self {
        case .noDisplays: return "no-displays"
        case .writerRejectedInput: return "writer-rejected-input"
        case .writerFailed: return "writer-failed"
        case .streamFailed: return "stream-failed"
        case .startTimedOut: return "start-timeout"
        case .frameStatusMismatch: return "frame-status-mismatch"
        }
    }
}
