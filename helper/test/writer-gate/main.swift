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
func makeWriter(_ name: String) -> (AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor) {
    let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent(name)
    try? FileManager.default.removeItem(at: url)
    let w = try! AVAssetWriter(outputURL: url, fileType: .mp4)
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
    precondition(w.canAdd(inp))
    w.add(inp)
    precondition(w.startWriting())
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

if failures.isEmpty {
    print("ALL PASS")
} else {
    for f in failures { print("FAIL: \(f)") }
    exit(1)
}
