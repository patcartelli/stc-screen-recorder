// STC Screen Recorder — Phase 0 spike capture. Throwaway.
import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import IOKit
import IOKit.hid

// ─────────────────────────── config ───────────────────────────
let RECORD_SECONDS: Double = 12.0
let FPS: Int32 = 60
let FRAME_NS: Double = 1_000_000_000.0 / Double(FPS)

let outDir: URL = {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--outdir"), i + 1 < a.count { return URL(fileURLWithPath: a[i+1]) }
    return URL(fileURLWithPath: NSHomeDirectory() + "/dev/stc-screen-recorder/scratch/out")
}()

var TB = mach_timebase_info_data_t()
mach_timebase_info(&TB)
@inline(__always) func machToNs(_ t: UInt64) -> UInt64 {
    return t &* UInt64(TB.numer) / UInt64(TB.denom)
}

let logURL = outDir.appendingPathComponent("run.log")
var logHandle: FileHandle?
func L(_ s: String) {
    let line = String(format: "[%7.3f] %@\n", Double(machToNs(mach_absolute_time())) / 1e9, s)
    FileHandle.standardError.write(line.data(using: .utf8)!)
    logHandle?.write(line.data(using: .utf8)!)
}
func say(_ s: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
    p.arguments = ["-r", "220", s]
    try? p.run()
}

// ─────────────────────────── event tap ───────────────────────────
struct EvRec { var tNs: UInt64; var recvMach: UInt64; var x: Double; var y: Double; var type: Int32 }
let EV_CAP = 500_000
let evBuf = UnsafeMutablePointer<EvRec>.allocate(capacity: EV_CAP)
var evCount: Int = 0
var gTap: CFMachPort?
var gTapReenables: Int = 0
var gTapRunLoop: CFRunLoop?

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = gTap { CGEvent.tapEnable(tap: t, enable: true) }
        gTapReenables += 1
        return Unmanaged.passUnretained(event)
    }
    let now = mach_absolute_time()
    if evCount < EV_CAP {
        let loc = event.location
        evBuf[evCount] = EvRec(tNs: event.timestamp, recvMach: now,
                               x: loc.x, y: loc.y, type: Int32(type.rawValue))
        evCount += 1
    }
    return Unmanaged.passUnretained(event)
}

func startEventTap() -> Bool {
    let mask: CGEventMask =
        (1 << CGEventType.mouseMoved.rawValue) |
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.leftMouseUp.rawValue) |
        (1 << CGEventType.leftMouseDragged.rawValue)
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap,
                                      place: .headInsertEventTap,
                                      options: .listenOnly,
                                      eventsOfInterest: mask,
                                      callback: tapCallback,
                                      userInfo: nil) else { return false }
    gTap = tap
    let th = Thread {
        gTapRunLoop = CFRunLoopGetCurrent()
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        CFRunLoopRun()
    }
    th.name = "evtap"
    th.qualityOfService = .userInteractive
    th.start()
    return true
}

// ─────────────────────────── screen capture ───────────────────────────
struct FrameRec {
    var idx: Int; var kind: String; var status: Int
    var displayTimeRaw: UInt64; var displayTimeNs: UInt64
    var ptsRawNs: Int64; var ptsTimescale: Int32
    var recvMachRaw: UInt64; var timelineNs: UInt64; var driftNs: Int64
}

final class ScreenSink: NSObject, SCStreamOutput, SCStreamDelegate {
    var writer: AVAssetWriter?
    var input: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var frames: [FrameRec] = []
    var t0DisplayNs: UInt64 = 0
    var t0DisplayRaw: UInt64 = 0
    var t0RecvMach: UInt64 = 0
    var t0PtsNs: Int64 = 0
    var lastIdx: Int = -1
    var started = false
    var statusCounts: [Int: Int] = [:]
    var appended = 0, repeated = 0, dropped = 0
    let lock = NSLock()

    var codec: AVVideoCodecType = .h264
    func setup(width: Int, height: Int) throws {
        let url = outDir.appendingPathComponent("display.mp4")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let settings: [String: Any] = [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 50_000_000,
                AVVideoMaxKeyFrameIntervalKey: 45,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoAllowFrameReorderingKey: false
            ]
        ]
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        inp.expectsMediaDataInRealTime = true
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: nil)
        if w.canAdd(inp) { w.add(inp) }
        writer = w; input = inp; adaptor = ad
        w.startWriting()
        w.startSession(atSourceTime: .zero)
        L("screen writer ready \(width)x\(height)")
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        autoreleasepool {
            guard type == .screen else { return }
            let recv = mach_absolute_time()
            guard let arr = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let att = arr.first else { return }
            let status = (att[.status] as? Int) ?? -1
            lock.lock(); statusCounts[status, default: 0] += 1; lock.unlock()

            let dtRaw = (att[.displayTime] as? UInt64) ?? 0
            let pts = CMSampleBufferGetPresentationTimeStamp(sb)

            // SCFrameStatus.complete == 0
            guard status == 0, let pb = CMSampleBufferGetImageBuffer(sb) else {
                // idle/blank/suppressed/started: hold last frame, CFR fill happens on next real frame
                return
            }
            let dtNs = machToNs(dtRaw)

            lock.lock()
            if !started {
                started = true
                t0DisplayRaw = dtRaw; t0DisplayNs = dtNs; t0RecvMach = recv
                t0PtsNs = Int64(CMTimeGetSeconds(pts) * 1e9)
            }
            let rel = Double(dtNs &- t0DisplayNs)
            var idx = Int((rel / FRAME_NS).rounded())
            if idx <= lastIdx { idx = lastIdx + 1 }
            let prevIdx = lastIdx
            let prev: CVPixelBuffer? = nil
            lastIdx = idx
            lock.unlock()

            guard let inp = input, let ad = adaptor else { return }

            _ = prevIdx; _ = prev   // VFR: no repeat-fill. See FINDINGS §"CFR by repeat".

            guard inp.isReadyForMoreMediaData else { dropped += 1; return }
            let t = CMTime(value: Int64(idx) * 1000, timescale: 60000)
            if ad.append(pb, withPresentationTime: t) {
                appended += 1
                let tl = t0DisplayNs &+ UInt64(Double(idx) * FRAME_NS)
                let drift = Int64(dtNs) - Int64(tl)
                lock.lock()
                frames.append(FrameRec(idx: idx, kind: "real", status: status,
                                       displayTimeRaw: dtRaw, displayTimeNs: dtNs,
                                       ptsRawNs: Int64(CMTimeGetSeconds(pts) * 1e9),
                                       ptsTimescale: pts.timescale,
                                       recvMachRaw: recv, timelineNs: tl, driftNs: drift))
                lock.unlock()
            } else {
                dropped += 1
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        L("!! SCStream stopped with error: \(error)")
    }
}

// ─────────────────────────── camera + mic ───────────────────────────
final class AVSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    var camWriter: AVAssetWriter?, camInput: AVAssetWriterInput?
    var micWriter: AVAssetWriter?, micInput: AVAssetWriterInput?
    var camStarted = false, micStarted = false
    var camFirstPts: CMTime = .invalid, camFirstRecvMach: UInt64 = 0
    var micFirstPts: CMTime = .invalid, micFirstRecvMach: UInt64 = 0
    var camCount = 0, micCount = 0
    var camDeviceName = "none", micDeviceName = "none"
    var micFormat = "unknown"
    var enabled = false
    let q = DispatchQueue(label: "avsink")

    static let btTransport: Int32 = 0x626C7565   // 'blue'
    static var micNote = ""
    static func pickMic() -> AVCaptureDevice? {
        let all = AVCaptureDevice.devices(for: .audio)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--mic"), i + 1 < args.count {
            let want = args[i+1].lowercased()
            if let d = all.first(where: { $0.localizedName.lowercased().contains(want) }) {
                micNote = "chosen by --mic"; return d
            }
            micNote = "--mic '\(args[i+1])' matched nothing; falling back"
        }
        if let d = AVCaptureDevice.default(for: .audio) {
            if d.transportType != btTransport { return d }
            if let w = all.first(where: { $0.transportType != btTransport }) {
                micNote = "default input '\(d.localizedName)' is BLUETOOTH — using '\(w.localizedName)' instead "
                        + "(Bluetooth latency is far larger than gate 2's 16.7 ms budget)"
                return w
            }
            micNote = "ONLY a Bluetooth mic is available ('\(d.localizedName)') — gate 2 will not be trustworthy"
            return d
        }
        return all.first
    }
    func setup(camAuthorized: Bool, micAuthorized: Bool) {
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080

        if camAuthorized, let dev = AVCaptureDevice.default(for: .video) {
            camDeviceName = dev.localizedName
            if let inp = try? AVCaptureDeviceInput(device: dev), session.canAddInput(inp) {
                session.addInput(inp)
                let out = AVCaptureVideoDataOutput()
                out.alwaysDiscardsLateVideoFrames = true
                out.setSampleBufferDelegate(self, queue: q)
                if session.canAddOutput(out) { session.addOutput(out) }
                let url = outDir.appendingPathComponent("camera.mp4")
                try? FileManager.default.removeItem(at: url)
                camWriter = try? AVAssetWriter(outputURL: url, fileType: .mp4)
                let s: [String: Any] = [AVVideoCodecKey: AVVideoCodecType.h264,
                                        AVVideoWidthKey: 1920, AVVideoHeightKey: 1080,
                                        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]]
                let i = AVAssetWriterInput(mediaType: .video, outputSettings: s)
                i.expectsMediaDataInRealTime = true
                if camWriter?.canAdd(i) == true { camWriter?.add(i) }
                camInput = i
                enabled = true
            }
        }
        if micAuthorized, let dev = AVSink.pickMic() {
            micDeviceName = dev.localizedName
            if let inp = try? AVCaptureDeviceInput(device: dev), session.canAddInput(inp) {
                session.addInput(inp)
                let out = AVCaptureAudioDataOutput()
                out.audioSettings = [
                    AVFormatIDKey: kAudioFormatLinearPCM,
                    AVSampleRateKey: 48000,
                    AVNumberOfChannelsKey: 1,
                    AVLinearPCMBitDepthKey: 16,
                    AVLinearPCMIsFloatKey: false,
                    AVLinearPCMIsBigEndianKey: false,
                    AVLinearPCMIsNonInterleaved: false]
                out.setSampleBufferDelegate(self, queue: q)
                if session.canAddOutput(out) { session.addOutput(out) }
                let url = outDir.appendingPathComponent("mic.wav")
                try? FileManager.default.removeItem(at: url)
                try? FileManager.default.removeItem(at: outDir.appendingPathComponent("mic.m4a"))
                micWriter = try? AVAssetWriter(outputURL: url, fileType: .wav)
                let s: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM,
                                        AVNumberOfChannelsKey: 1,
                                        AVSampleRateKey: 48000,
                                        AVLinearPCMBitDepthKey: 16,
                                        AVLinearPCMIsFloatKey: false,
                                        AVLinearPCMIsBigEndianKey: false,
                                        AVLinearPCMIsNonInterleaved: false]
                let i = AVAssetWriterInput(mediaType: .audio, outputSettings: s)
                i.expectsMediaDataInRealTime = true
                if micWriter?.canAdd(i) == true { micWriter?.add(i) }
                micInput = i
                enabled = true
            }
        }
        session.commitConfiguration()
        L("AV camera=\(camDeviceName) mic=\(micDeviceName) enabled=\(enabled)")
        if !AVSink.micNote.isEmpty { L("MIC: \(AVSink.micNote)") }
    }

    func start() { if enabled { camWriter?.startWriting(); micWriter?.startWriting(); session.startRunning() } }
    func stop()  { if enabled { session.stopRunning() } }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from conn: AVCaptureConnection) {
        autoreleasepool {
            let recv = mach_absolute_time()
            let pts = CMSampleBufferGetPresentationTimeStamp(sb)
            if output is AVCaptureVideoDataOutput {
                guard let w = camWriter, let i = camInput else { return }
                if !camStarted { camStarted = true; camFirstPts = pts; camFirstRecvMach = recv; w.startSession(atSourceTime: pts) }
                if i.isReadyForMoreMediaData, w.status == .writing { i.append(sb); camCount += 1 }
            } else {
                guard let w = micWriter, let i = micInput else { return }
                if !micStarted {
                    micStarted = true; micFirstPts = pts; micFirstRecvMach = recv
                    if let fd = CMSampleBufferGetFormatDescription(sb),
                       let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                        micFormat = "sr=\(asbd.mSampleRate) ch=\(asbd.mChannelsPerFrame) bits=\(asbd.mBitsPerChannel) fmt=\(asbd.mFormatID) flags=\(asbd.mFormatFlags)"
                        L("mic input format: \(micFormat)")
                    }
                    w.startSession(atSourceTime: pts)
                }
                if i.isReadyForMoreMediaData, w.status == .writing { i.append(sb); micCount += 1 }
            }
        }
    }
}

// ─────────────────────────── json helpers ───────────────────────────
func writeJSON(_ obj: Any, _ name: String) {
    let url = outDir.appendingPathComponent(name)
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
        try? d.write(to: url)
        L("wrote \(name) (\(d.count) bytes)")
    } else { L("!! failed to serialize \(name)") }
}

// ─────────────────────────── orchestration ───────────────────────────
final class Runner {
    let screen = ScreenSink()
    let av = AVSink()
    var stream: SCStream?
    var display: SCDisplay?
    var pxW = 0, pxH = 0, scale: Double = 1
    var capW = 0, capH = 0
    var codecName = "h264"
    var tapOK = false
    var camAuth = false, micAuth = false
    var startMach: UInt64 = 0
    var startDate: Date = Date()
    var notes: [String] = []
    var cueTimes: [Double] = []
    var captureRunning = false
    var finished = false
    var sigSources: [DispatchSourceSignal] = []

    func installSignalHandlers() {
        for sig in [SIGINT, SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            // background queue on purpose: must still fire when the main thread is blocked
            let src = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global(qos: .userInitiated))
            src.setEventHandler { [weak self] in
                guard let self = self else { exit(130) }
                L("!! signal \(sig) — releasing capture devices before exit")
                self.av.stop()          // stopRunning() releases the audio/video device cleanly
                if let t = gTap { CGEvent.tapEnable(tap: t, enable: false) }
                self.stream?.stopCapture { _ in }
                usleep(300_000)
                logHandle?.closeFile()
                exit(130)
            }
            src.resume()
            sigSources.append(src)
        }
    }

    func note(_ s: String) { notes.append(s); L("NOTE: " + s) }

    func run() {
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        logHandle = try? FileHandle(forWritingTo: logURL)

        installSignalHandlers()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + RECORD_SECONDS + 45) {
            if !self.finished {
                L("!! HARD WATCHDOG: still not finished; the main thread is blocked. Exiting.")
                logHandle?.closeFile()
                exit(3)
            }
        }
        L("=== STC spike-capture ===")
        L("timebase numer=\(TB.numer) denom=\(TB.denom)  (1 tick = \(Double(TB.numer)/Double(TB.denom)) ns)")
        L("bundle=\(Bundle.main.bundleIdentifier ?? "nil") path=\(Bundle.main.bundlePath)")
        L("outDir=\(outDir.path)")

        // ---- permission preflight ----
        let preflight = CGPreflightScreenCaptureAccess()
        L("CGPreflightScreenCaptureAccess=\(preflight)")

        let sem = DispatchSemaphore(value: 0)
        var content: SCShareableContent?
        var scErr: Error?
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { c, e in
            content = c; scErr = e; sem.signal()
        }
        let waited = sem.wait(timeout: .now() + 4.0)
        if waited == .timedOut {
            note("SCShareableContent HUNG >4s — screen recording TCC almost certainly not granted (preflight said \(preflight))")
            _ = CGRequestScreenCaptureAccess()
            L("Requested screen capture access. GRANT IT, then relaunch.")
            finishEarly(reason: "screen-recording-timeout")
            return
        }
        guard let content = content, let disp = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            note("SCShareableContent returned no displays. err=\(String(describing: scErr)) preflight=\(preflight)")
            _ = CGRequestScreenCaptureAccess()
            finishEarly(reason: "no-displays")
            return
        }
        display = disp
        L("SCShareableContent OK in \(content.displays.count) display(s), \(content.windows.count) window(s)")

        let bounds = CGDisplayBounds(disp.displayID)
        let mode = CGDisplayCopyDisplayMode(disp.displayID)
        let pixW = mode?.pixelWidth ?? disp.width
        let pixH = mode?.pixelHeight ?? disp.height
        scale = Double(pixW) / Double(disp.width)
        pxW = pixW; pxH = pixH
        L("display id=\(disp.displayID) pts=\(disp.width)x\(disp.height) px=\(pixW)x\(pixH) scale=\(scale) bounds=\(bounds)")

        // ---- camera / mic ----
        let cs = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .video) { ok in self.camAuth = ok; cs.signal() }
        if cs.wait(timeout: .now() + 20) == .timedOut { note("camera permission prompt timed out") }
        let ms = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { ok in self.micAuth = ok; ms.signal() }
        if ms.wait(timeout: .now() + 20) == .timedOut { note("mic permission prompt timed out") }
        L("camAuth=\(camAuth) micAuth=\(micAuth)")
        if !camAuth { note("CAMERA DENIED — gate 2 cannot be measured") }
        if !micAuth { note("MIC DENIED — gate 2 cannot be measured") }

        // ---- event tap ----
        tapOK = startEventTap()
        if !tapOK {
            note("CGEvent.tapCreate returned nil — Input Monitoring not granted")
            let granted = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
            L("IOHIDRequestAccess(listen) -> \(granted)")
            tapOK = startEventTap()
            if !tapOK { note("event tap still nil after IOHIDRequestAccess — grant Input Monitoring and relaunch") }
        }
        L("eventTap=\(tapOK)")

        if CommandLine.arguments.contains("--probe") {
            L("PROBE: screenRecording=OK camera=\(camAuth) mic=\(micAuth) eventTap=\(tapOK)")
            probeMode = true
            emitAnchors(aborted: true, reason: "probe")
            logHandle?.closeFile()
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return
        }

        // ---- writers ----
        // Capture size. Native 6016x3384 falls off the H.264 hardware fast path (0.81 -> 0.25 Gpx/s),
        // so cap at 3840x2160 unless explicitly overridden. See FINDINGS "encoder cliff".
        let args = CommandLine.arguments
        func argInt(_ k: String) -> Int? {
            if let i = args.firstIndex(of: k), i+1 < args.count { return Int(args[i+1]) }
            return nil
        }
        if args.contains("--native") { capW = pxW; capH = pxH }
        else if let w = argInt("--width"), let h = argInt("--height") { capW = w; capH = h }
        else if pxW > 3840 {
            let f = min(3840.0/Double(pxW), 2160.0/Double(pxH))
            capW = (Int(Double(pxW)*f)/2)*2; capH = (Int(Double(pxH)*f)/2)*2
        } else { capW = pxW; capH = pxH }
        if args.contains("--hevc") { codecName = "hevc" }
        L("capture size \(capW)x\(capH) (display native \(pxW)x\(pxH)) codec=\(codecName)")

        screen.codec = (codecName == "hevc") ? .hevc : .h264
        do { try screen.setup(width: capW, height: capH) } catch { note("screen writer setup failed: \(error)"); finishEarly(reason: "writer"); return }

        // Camera/mic are optional. AVCaptureDevice enumeration can hang indefinitely when CoreAudio is
        // wedged (e.g. after a Bluetooth device was yanked), so it runs off-main with a timeout and is
        // abandoned on stall — screen + events still record, which is all gate 1 needs.
        if CommandLine.arguments.contains("--no-av") {
            note("--no-av: skipping camera and mic entirely")
        } else {
            let avSem = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .userInitiated).async {
                autoreleasepool { self.av.setup(camAuthorized: self.camAuth, micAuthorized: self.micAuth) }
                avSem.signal()
            }
            if avSem.wait(timeout: .now() + 8) == .timedOut {
                av.enabled = false      // start() becomes a no-op; the stuck thread is abandoned
                note("AV SETUP TIMED OUT after 8s — CoreAudio/AVFoundation device enumeration is stalled. "
                   + "Continuing WITHOUT camera and mic. Gate 1 is still measurable; gate 2 is not. "
                   + "Fix: disconnect the Bluetooth audio device, or `sudo killall coreaudiod`.")
            }
        }

        // ---- SCK stream ----

        let cfg = SCStreamConfiguration()
        cfg.width = capW
        cfg.height = capH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: FPS)
        cfg.queueDepth = 8
        cfg.showsCursor = false
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        cfg.scalesToFit = false
        if cfg.responds(to: NSSelectorFromString("setCaptureResolution:")) {
            cfg.setValue(3, forKey: "captureResolution")  // SCCaptureResolutionType.best (macOS 14+, KVC on 13.3 SDK)
            L("captureResolution=best via KVC")
        } else { note("captureResolution unavailable; relying on explicit width/height") }

        let filter = SCContentFilter(display: disp, excludingWindows: [])
        let s = SCStream(filter: filter, configuration: cfg, delegate: screen)
        do {
            try s.addStreamOutput(screen, type: .screen, sampleHandlerQueue: DispatchQueue(label: "sck", qos: .userInteractive))
        } catch { note("addStreamOutput failed: \(error)"); finishEarly(reason: "addoutput"); return }
        stream = s

        // ---- anchors taken as close to t=0 as possible ----
        startMach = mach_absolute_time()
        startDate = Date()

        L(">>> starting capture; recording \(RECORD_SECONDS)s")

        // Watchdogs. A hung startCapture previously left the process running forever with 0-byte outputs.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            if !self.captureRunning {
                self.note("startCapture completion did not fire within 8s — ScreenCaptureKit stalled")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + RECORD_SECONDS + 25) {
            if !self.finished {
                self.note("WATCHDOG: capture never completed; forcing shutdown so output is not lost")
                self.finish()
            }
        }

        s.startCapture { err in
            if let err = err {
                self.note("startCapture failed: \(err)")
                self.finishEarly(reason: "startCapture")
                return
            }
            self.captureRunning = true
            L(">>> CAPTURE RUNNING")
            // Start camera/mic only once screen capture is live.
            self.av.start()
            self.scheduleCues()
            DispatchQueue.main.asyncAfter(deadline: .now() + RECORD_SECONDS) { self.finish() }
        }
    }

    func scheduleCues() {
        // Deliberately one-word: spoken cues land in the mic track, and a long phrase talks over
        // the very transient it is asking for.
        let cues: [(Double, String)] = [
            (0.3, "go"),
            (1.5, "click"),
            (4.2, "clap"),
            (7.0, "drag"),
            (9.8, "click"),
            (11.5, "stop")
        ]
        cueTimes = cues.map { $0.0 }
        for (t, msg) in cues {
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { L("CUE: \(msg)"); say(msg) }
        }
    }

    func finishEarly(reason: String) {
        note("ABORTED EARLY: \(reason)")
        probeMode = true          // route to anchors-aborted.json; never clobber a good run
        emitAnchors(aborted: true, reason: reason)
        logHandle?.closeFile()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    var probeMode = false
    func emitAnchors(aborted: Bool, reason: String) {
        var a: [String: Any] = [:]
        a["aborted"] = aborted
        a["abortReason"] = reason
        a["machTimebaseNumer"] = TB.numer
        a["machTimebaseDenom"] = TB.denom
        a["nsPerMachTick"] = Double(TB.numer) / Double(TB.denom)
        a["startMachRaw"] = startMach
        a["startMachNs"] = machToNs(startMach)
        a["startUnixEpochSec"] = startDate.timeIntervalSince1970
        a["recordSeconds"] = RECORD_SECONDS
        a["fps"] = FPS
        a["capturedWidth"] = capW
        a["capturedHeight"] = capH
        a["codec"] = codecName
        a["displayPixelWidth"] = pxW
        a["displayPixelHeight"] = pxH
        a["displayPointWidth"] = display?.width ?? 0
        a["displayPointHeight"] = display?.height ?? 0
        a["displayBackingScale"] = scale
        if let d = display {
            let b = CGDisplayBounds(d.displayID)
            a["displayBounds"] = ["x": b.origin.x, "y": b.origin.y, "w": b.size.width, "h": b.size.height]
            a["displayID"] = d.displayID
        }
        a["eventTapEnabled"] = tapOK
        a["eventTapReenables"] = gTapReenables
        a["eventCount"] = evCount
        a["cameraAuthorized"] = camAuth
        a["micAuthorized"] = micAuth
        a["cameraDevice"] = av.camDeviceName
        a["micDevice"] = av.micDeviceName
        a["screenFirstDisplayTimeRaw"] = screen.t0DisplayRaw
        a["screenFirstDisplayTimeNs"] = screen.t0DisplayNs
        a["screenFirstRecvMachRaw"] = screen.t0RecvMach
        a["screenFirstPtsNs"] = screen.t0PtsNs
        a["screenFramesReal"] = screen.appended
        a["screenFramesRepeat"] = screen.repeated
        a["screenFramesDropped"] = screen.dropped
        a["screenStatusCounts"] = screen.statusCounts.map { ["status": $0.key, "count": $0.value] }
        a["cameraFirstPtsRaw"] = av.camFirstPts.isValid ? av.camFirstPts.value : 0
        a["cameraFirstPtsTimescale"] = av.camFirstPts.isValid ? av.camFirstPts.timescale : 0
        a["cameraFirstPtsNs"] = av.camFirstPts.isValid ? Int64(CMTimeGetSeconds(av.camFirstPts) * 1e9) : 0
        a["cameraFirstRecvMachRaw"] = av.camFirstRecvMach
        a["cameraSampleCount"] = av.camCount
        a["micFirstPtsRaw"] = av.micFirstPts.isValid ? av.micFirstPts.value : 0
        a["micFirstPtsTimescale"] = av.micFirstPts.isValid ? av.micFirstPts.timescale : 0
        a["micFirstPtsNs"] = av.micFirstPts.isValid ? Int64(CMTimeGetSeconds(av.micFirstPts) * 1e9) : 0
        a["micFirstRecvMachRaw"] = av.micFirstRecvMach
        a["micSampleCount"] = av.micCount
        a["micInputFormat"] = av.micFormat
        a["micSelectionNote"] = AVSink.micNote
        a["captureRunning"] = captureRunning
        a["micFile"] = "mic.wav"
        a["cueTimes"] = cueTimes
        a["notes"] = notes
        writeJSON(a, probeMode ? (reason == "probe" ? "anchors-probe.json" : "anchors-aborted.json") : "anchors.json")
    }

    func finish() {
        if finished { return }
        finished = true
        L(">>> stopping")
        stream?.stopCapture { _ in }
        av.stop()
        if let t = gTap { CGEvent.tapEnable(tap: t, enable: false) }
        if let rl = gTapRunLoop { CFRunLoopStop(rl) }

        let g = DispatchGroup()
        screen.input?.markAsFinished()
        if let w = screen.writer, w.status == .writing { g.enter(); w.finishWriting { L("display.mp4 status=\(w.status.rawValue) err=\(String(describing: w.error))"); g.leave() } }
        av.camInput?.markAsFinished()
        if let w = av.camWriter, w.status == .writing { g.enter(); w.finishWriting { L("camera.mp4 status=\(w.status.rawValue) err=\(String(describing: w.error))"); g.leave() } }
        av.micInput?.markAsFinished()
        if let w = av.micWriter, w.status == .writing { g.enter(); w.finishWriting { L("mic.wav status=\(w.status.rawValue) err=\(String(describing: w.error))"); g.leave() } }
        _ = g.wait(timeout: .now() + 20)

        // events.json
        var evs: [[String: Any]] = []
        evs.reserveCapacity(evCount)
        let names: [Int32: String] = [1: "leftMouseDown", 2: "leftMouseUp", 5: "mouseMoved", 6: "leftMouseDragged"]
        for i in 0..<evCount {
            let e = evBuf[i]
            evs.append(["tNs": e.tNs, "recvMachRaw": e.recvMach, "recvMachNs": machToNs(e.recvMach),
                        "x": e.x, "y": e.y, "type": e.type, "typeName": names[e.type] ?? "t\(e.type)"])
        }
        writeJSON(evs, "events.json")

        // display-frames.json
        let sorted = screen.frames.sorted { $0.idx < $1.idx }
        let fr: [[String: Any]] = sorted.map {
            ["frameIndex": $0.idx, "kind": $0.kind, "status": $0.status,
             "displayTimeRaw": $0.displayTimeRaw, "displayTimeNs": $0.displayTimeNs,
             "ptsRawNs": $0.ptsRawNs, "ptsTimescale": $0.ptsTimescale,
             "recvMachRaw": $0.recvMachRaw, "timelineNs": $0.timelineNs, "driftNs": $0.driftNs]
        }
        writeJSON(fr, "display-frames.json")
        emitAnchors(aborted: false, reason: "")

        L("=== DONE  frames real=\(screen.appended) repeat=\(screen.repeated) dropped=\(screen.dropped) events=\(evCount) cam=\(av.camCount) mic=\(av.micCount) ===")
        logHandle?.closeFile()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }
}

// ─────────────────────────── main ───────────────────────────
final class AppDelegate: NSObject, NSApplicationDelegate {
    let runner = Runner()
    func applicationDidFinishLaunching(_ n: Notification) {
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool { DispatchQueue.main.async { self.runner.run() } }
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
