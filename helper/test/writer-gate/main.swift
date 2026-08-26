import Foundation
import AVFoundation
import CoreVideo

// STC-254 regression harness.
//
// The defect is a use-after-free inside AVFoundation, so a failing run does not
// print a failed assertion — it dies by signal. That is the point: the test
// asserts the process survives a first append racing teardown. `swift` cannot
// catch it and neither could a `try`, which is why this runs out of process.

let W = 1280, H = 720
var failures: [String] = []

func check(_ cond: Bool, _ what: String) {
    if !cond { failures.append(what) }
}

func makeBuffer() -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, W, H,
                        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                        [kCVPixelBufferIOSurfacePropertiesKey: [String: Any]()] as CFDictionary,
                        &pb)
    return pb!
}

/// A writer configured exactly as CaptureSession.setupWriter() configures it.
/// The settings matter: the crash is in compressor creation, which is driven by
/// the compression properties below.
/// Reports an environment failure and exits.
///
/// Deliberately NOT `precondition` or `try!`. Those trap, and a trap here
/// arrives as EXC_BREAKPOINT/SIGTRAP — the same exception type and signal as
/// the STC-254 use-after-free this harness exists to detect. A CI runner that
/// simply could not spare an encoder would have produced a crash that looks
/// exactly like the regression coming back. Measured: under contention 5 of 6
/// concurrent harness processes fail here, while the one that gets resources
/// completes 300 iterations cleanly.
func environmentFailure(_ what: String) -> Never {
    print("ENVIRONMENT: \(what)")
    print("This is the machine declining to provide an asset writer, NOT a")
    print("WriterGate regression. The race assertions never ran.")
    exit(2)
}

/// A directory of this process's own.
///
/// The harness used fixed names directly in NSTemporaryDirectory(), which two
/// concurrent harness processes happily fight over: the loser's startWriting()
/// fails with -11823 "Cannot Save — The requested file name is already in use."
/// Combined with the old `precondition`, that surfaced as EXC_BREAKPOINT —
/// indistinguishable at a glance from the STC-254 crash this harness detects.
let workDir: URL = {
    let d = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("stc-writer-gate-\(ProcessInfo.processInfo.processIdentifier)")
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}()

func makeWriter(_ name: String) -> (AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor) {
    let url = workDir.appendingPathComponent(name)
    try? FileManager.default.removeItem(at: url)
    let w: AVAssetWriter
    do { w = try AVAssetWriter(outputURL: url, fileType: .mp4) }
    catch { environmentFailure("AVAssetWriter(outputURL:) threw: \(error)") }
    w.movieTimeScale = 90_000
    let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: W, AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: 50_000_000,
            AVVideoMaxKeyFrameIntervalKey: 45,
            AVVideoExpectedSourceFrameRateKey: 60,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: false,
        ] as [String: Any],
    ])
    inp.expectsMediaDataInRealTime = true
    inp.mediaTimeScale = 1_000_000_000
    let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: nil)
    if !w.canAdd(inp) { environmentFailure("writer refused the video input") }
    w.add(inp)
    if !w.startWriting() {
        environmentFailure("startWriting() returned false — status \(w.status.rawValue), " +
                           "error \(String(describing: w.error))")
    }
    w.startSession(atSourceTime: .zero)
    return (w, inp, ad)
}

// 1. A closed gate drops, and says so, rather than appending into a finished input.
do {
    let (w, inp, ad) = makeWriter("gate-closed.mp4")
    let gate = WriterGate()
    gate.install(input: inp, adaptor: ad)
    check(gate.closeAndMarkFinished(), "first close should report it closed the gate")
    check(!gate.closeAndMarkFinished(), "second close must not re-mark a finished input")
    check(gate.append(makeBuffer(), at: .zero) == .dropped, "append after close must drop")
    w.cancelWriting()
}

// 2. A live gate appends.
do {
    let (w, inp, ad) = makeWriter("gate-live.mp4")
    let gate = WriterGate()
    gate.install(input: inp, adaptor: ad)
    check(gate.append(makeBuffer(), at: .zero) == .appended, "append on a live gate should succeed")
    gate.closeAndMarkFinished()
    w.cancelWriting()
}

// 3. The regression: the first append racing teardown must not kill the process.
// The delay sweep walks the teardown across the compressor-creation window;
// unguarded, this dies within the first few iterations.
let iterations = 120
for i in 0..<iterations {
    let (w, inp, ad) = makeWriter("gate-race-\(i).mp4")
    let gate = WriterGate()
    gate.install(input: inp, adaptor: ad)
    let pb = makeBuffer()

    let delay = UInt32(i % 40) * 25   // 0..975 us
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
        if delay > 0 { usleep(delay) }
        // Exactly what CaptureSession.stop() does from stopCapture's completion.
        gate.closeAndMarkFinished()
        w.finishWriting { done.signal() }
    }

    _ = gate.append(pb, at: CMTime(value: 0, timescale: 1_000_000_000))
    _ = done.wait(timeout: .now() + 5)
    try? FileManager.default.removeItem(at: w.outputURL)
}

try? FileManager.default.removeItem(at: workDir)

if failures.isEmpty {
    print("ALL PASS")
} else {
    for f in failures { print("FAIL: \(f)") }
    exit(1)
}
