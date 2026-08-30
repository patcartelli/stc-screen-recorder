import Foundation
import AVFoundation

enum CameraError: Error, CustomStringConvertible {
    case noDevice
    case notAuthorized(AVAuthorizationStatus)
    case deviceInputFailed(Error)
    case sessionRefusedInput
    case writerFailed(Error?)

    var description: String {
        switch self {
        case .noDevice: return "no camera device is available"
        case .notAuthorized(let s): return "camera access is \(s.rawValue), not authorized"
        case .deviceInputFailed(let e): return "failed to create a capture input for the camera device: \(e)"
        case .sessionRefusedInput: return "the capture session refused the camera input"
        case .writerFailed(let e): return "camera writer failed: \(String(describing: e))"
        }
    }

    var code: String {
        switch self {
        case .noDevice: return "camera-no-device"
        case .notAuthorized: return "camera-not-authorized"
        case .deviceInputFailed: return "camera-device-input-failed"
        case .sessionRefusedInput: return "camera-input-refused"
        case .writerFailed: return "camera-writer-failed"
        }
    }
}

/// Camera capture for one session, writing camera.mp4 beside display.mp4.
///
/// PTS is used AS-IS. CMSampleBufferGetPresentationTimeStamp is already mach
/// host time and already latency-compensated (phase 0 measured 91.5 ms and
/// 115.8 ms on two runs of the same hardware). Session-relative time is
/// `pts_ns - t0Ns`, with no *timebase* conversion — the same rule as
/// CGEvent.timestamp. Converting the display-track's mach-tick timebase here
/// would desync the PiP silently. The PTS's own `CMTime` still needs its
/// scale normalized to nanoseconds before `.value` means nanoseconds; that is
/// done with `CMTimeConvertScale`, which is exact integer rescaling, not a
/// unit conversion — no `Double` involved (see `ptsNs(_:)` below).
final class CameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let dir: URL
    private let t0Ns: UInt64
    private let queue = DispatchQueue(label: "stc.capture.camera")

    private var session: AVCaptureSession?
    private var writer: AVAssetWriter?
    private let gate = WriterGate()
    private var deviceName = ""

    private let lock = NSLock()
    /// Last pts that passed the monotonic-ordering check, appended or not.
    /// Kept separate from `lastPtsNs` below: the writer must never be handed
    /// a non-increasing timestamp regardless of what the gate ends up doing
    /// with it, so this guards the ordering of everything offered to
    /// `gate.append`, not just what anchors.camera ends up describing.
    private var monotonicGuardPtsNs: Int64 = -1
    /// first/last/deltas describe only frames the gate actually APPENDED
    /// (see `captureOutput` below) — anchors.camera must not claim a track
    /// wider than camera.mp4 actually contains, which it would if the gate
    /// dropped the first or last received frame (e.g. during teardown).
    private var firstPtsNs: Int64 = -1
    private var lastPtsNs: Int64 = -1
    private var deltas: [Int64] = []
    private var appended = 0

    static let width = 1280
    static let height = 720

    init(dir: URL, t0Ns: UInt64) {
        self.dir = dir
        self.t0Ns = t0Ns
    }

    func start() -> Result<String, Error> {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        guard status == .authorized else { return .failure(CameraError.notAuthorized(status)) }

        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
            mediaType: .video, position: .unspecified)
        // NOT `.devices.first` — that is not a choice, it is whatever
        // AVFoundation returned first, and on 2026-08-29 that was
        // "Elgato Virtual Camera": ~1 fps with nothing behind it, so three
        // takes recorded 12 frames in 11 s beside a good display track and the
        // app reported success (STC-286). pickCamera ranks by transportType.
        let candidates = discovery.devices.map { (name: $0.localizedName, transportType: $0.transportType) }
        guard let choice = pickCamera(candidates),
              let device = discovery.devices.first(where: { $0.localizedName == choice.name })
        else { return .failure(CameraError.noDevice) }
        if choice.isVirtual {
            // Every candidate was virtual. Recording it beats refusing, but the
            // user must not discover a 1 fps PiP after the fact.
            // IO.send, not IO.stat: this must not be droppable. The lossy
            // channel exists so stats cannot back-pressure capture, and a
            // warning the user needs before they trust a take is not a stat.
            IO.send("warning", ["code": "virtual-camera-only",
                                "device": choice.name,
                                "detail": "the only camera available is a virtual device, which "
                                        + "may deliver very few frames; connect a physical camera "
                                        + "for a usable picture-in-picture"])
        }
        // Guarded by `lock`, same as the frame counters below: this runs on
        // the open queue (CaptureSession.startCameraAsync's background
        // queue) while `track()` reads it from the stop path, which can run
        // concurrently on a different queue.
        lock.lock(); deviceName = device.localizedName; lock.unlock()

        let s = AVCaptureSession()
        s.beginConfiguration()
        s.sessionPreset = .hd1280x720
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            s.commitConfiguration()
            return .failure(CameraError.deviceInputFailed(error))
        }
        guard s.canAddInput(input) else {
            s.commitConfiguration()
            return .failure(CameraError.sessionRefusedInput)
        }
        s.addInput(input)

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        // Dropping a late camera frame is correct: the PiP holds the previous
        // one, exactly as the display track does across a VFR stall.
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard s.canAddOutput(output) else {
            s.commitConfiguration()
            return .failure(CameraError.sessionRefusedInput)
        }
        s.addOutput(output)
        s.commitConfiguration()

        do { try setupWriter() } catch { return .failure(error) }

        session = s
        s.startRunning()
        return .success(deviceName)
    }

    private func setupWriter() throws {
        let url = dir.appendingPathComponent("camera.mp4")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mp4)
        w.movieTimeScale = 90_000
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Self.width,
            AVVideoHeightKey: Self.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ])
        inp.expectsMediaDataInRealTime = true
        inp.mediaTimeScale = 1_000_000_000
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp,
                                                      sourcePixelBufferAttributes: nil)
        guard w.canAdd(inp) else { throw CameraError.writerFailed(nil) }
        w.add(inp)
        guard w.startWriting() else { throw CameraError.writerFailed(w.error) }
        w.startSession(atSourceTime: .zero)
        writer = w
        gate.install(input: inp, adaptor: ad)
    }

    /// Exact PTS in nanoseconds, as pure integer arithmetic — no `Double`.
    /// `CMTimeConvertScale` rescales the `CMTime`'s existing timescale to
    /// 1_000_000_000 (often a no-op: capture buffers commonly already carry
    /// a nanosecond timescale), and the result's `.value` IS the nanosecond
    /// count. `.roundHalfAwayFromZero` only matters on the rare timescale
    /// that doesn't divide evenly into 1e9.
    static func ptsNs(_ pts: CMTime) -> Int64 {
        CMTimeConvertScale(pts, timescale: 1_000_000_000, method: .roundHalfAwayFromZero).value
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        autoreleasepool {
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
            // Already mach host time, already latency-compensated. Do not convert
            // the timebase — only rescale the CMTime to a nanosecond timescale,
            // exactly, in integer arithmetic (see Self.ptsNs).
            let ptsNs = Self.ptsNs(CMSampleBufferGetPresentationTimeStamp(sb))
            let rel = ptsNs - Int64(t0Ns)
            guard rel >= 0 else { return }          // arrived before the session began

            lock.lock()
            if monotonicGuardPtsNs >= 0, rel <= monotonicGuardPtsNs {
                lock.unlock(); return               // non-monotonic: drop, never offered to the gate
            }
            monotonicGuardPtsNs = rel
            lock.unlock()

            let outcome = gate.append(pb, at: CMTime(value: rel, timescale: 1_000_000_000))
            guard outcome == .appended else { return }

            // Only record what actually landed in camera.mp4 — a frame the
            // gate dropped (teardown racing the last append) must not widen
            // anchors.camera past the real track.
            lock.lock()
            if lastPtsNs >= 0 { deltas.append(rel - lastPtsNs) }
            if firstPtsNs < 0 { firstPtsNs = rel }
            lastPtsNs = rel
            appended += 1
            lock.unlock()
        }
    }

    /// Stops and reports what was captured. Answers exactly once, and is bounded:
    /// neither stopRunning nor finishWriting promises to call back.
    /// How long the camera teardown gets before `stop` answers anyway.
    ///
    /// Strictly SHORTER than `CaptureSession.stopTimeoutSeconds`, and that
    /// ordering is load-bearing rather than incidental: CaptureSession.stop()
    /// waits on a DispatchGroup this teardown is entered into, so if this
    /// backstop were the later one the display side would give up first and
    /// answer `<reason>-timeout` with a stopWarning for a camera that was about
    /// to report normally. Asserted in helper/test/stop-bounds.test.ts.
    static let stopTimeoutSeconds: Double = 10

    func stop(completion: @escaping (CameraTrack?) -> Void) {
        let answered = NSLock()
        var done = false
        let finish: (CameraTrack?) -> Void = { track in
            answered.lock()
            if done { answered.unlock(); return }
            done = true
            answered.unlock()
            completion(track)
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + Self.stopTimeoutSeconds) {
            finish(self.track())
        }

        session?.stopRunning()
        gate.closeAndMarkFinished()
        guard let w = writer else { finish(track()); return }
        w.finishWriting { finish(self.track()) }
    }

    private func track() -> CameraTrack? {
        lock.lock(); defer { lock.unlock() }
        guard appended > 0, firstPtsNs >= 0, lastPtsNs >= firstPtsNs else { return nil }
        return CameraTrack(present: true, device: deviceName,
                           width: Self.width, height: Self.height,
                           firstFramePtsNs: Int(firstPtsNs),
                           lastFramePtsNs: Int(lastPtsNs),
                           frameIntervalNs: Int(medianDelta()))
    }

    /// Median, not mean: a single long stall would drag a mean upward and
    /// stretch the PiP's track end past where frames actually stopped.
    private func medianDelta() -> Int64 {
        if deltas.isEmpty { return 16_666_667 }
        let s = deltas.sorted()
        return s[s.count / 2]
    }
}
