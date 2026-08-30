import Foundation
import AVFoundation
import CoreVideo
import VideoToolbox

// STC-254 regression harness.
//
// The defect is a use-after-free inside AVFoundation, so a failing run does not
// print a failed assertion — it dies by signal. That is the point: the test
// asserts the process survives a first append racing teardown. `swift` cannot
// catch it and neither could a `try`, which is why this runs out of process.

/// Written to stderr and streamed live by the test runner, so it survives a
/// timeout that kills this process. Anything only printed at the end is lost
/// exactly when a stall makes it valuable.
func diag(_ m: String) {
    FileHandle.standardError.write(("[writer-gate] " + m + "\n").data(using: .utf8)!)
}

/// What this process is doing right now, for the deadline watchdog to name.
///
/// Written from whichever thread is making progress and read from the watchdog
/// thread, so it is locked. A watchdog that fires without saying what it
/// interrupted reports the same nothing the runner's kill already reports.
final class Progress {
    private let lock = NSLock()
    private var current = "startup"
    func set(_ s: String) { lock.lock(); current = s; lock.unlock() }
    func now() -> String { lock.lock(); defer { lock.unlock() }; return current }
}
let progress = Progress()

/// How long this process has, handed down by the runner (see
/// `_swift-harness.ts`), never chosen here.
///
/// The runner will kill this process at HARNESS_RUN_MS and report only "did not
/// finish within" — the unexplained stall that all five STC-259 sightings were.
/// The deadline below is deliberately EARLIER than that kill, so the harness
/// always gets to say what it was doing instead.
///
/// Refused rather than defaulted. A bound a process picks for itself is a bound
/// nobody compares against the one that will actually kill it, and the whole
/// point here is that the two are compared — `gate-run.mjs` refuses an
/// undeclared bound for the same reason.
let harnessDeadlineMs: Int = {
    let raw = ProcessInfo.processInfo.environment["STC_HARNESS_DEADLINE_MS"]
    guard let raw, let ms = Int(raw), ms > 0 else {
        FileHandle.standardError.write(("""
        [writer-gate] STC_HARNESS_DEADLINE_MS is unset or unusable (\(raw ?? "nil")).
        This harness will not run without knowing when its runner will kill it.
        Run it through helper/test/writer-gate.test.ts, or set it by hand.

        """).data(using: .utf8)!)
        // Not an ENVIRONMENT failure: this is our wiring, not the machine, and
        // it must NOT be retried as though another attempt could help.
        exit(3)
    }
    return ms
}()

let harnessStart = DispatchTime.now().uptimeNanoseconds
let harnessDeadlineNs = harnessStart + UInt64(harnessDeadlineMs) * 1_000_000

/// Milliseconds left before this process must have explained itself.
func budgetRemainingMs() -> Int {
    let now = DispatchTime.now().uptimeNanoseconds
    return now >= harnessDeadlineNs ? 0 : Int((harnessDeadlineNs - now) / 1_000_000)
}

/// Fires an environment failure if the process is still alive at the deadline.
///
/// Every other bound in this file is tighter and names one specific call. This
/// one is the backstop that makes the runner's mute kill unreachable, and it is
/// the only thing covering the regions that CANNOT be individually bounded —
/// above all the race loop's 120 inline appends, whose whole point is that the
/// append runs on this thread while teardown runs on another. Wrapping those in
/// `bounded` would move the append onto a third thread and change the very race
/// the harness exists to reproduce, so they are left alone and this covers them.
func startDeadlineWatchdog() {
    let t = Thread {
        let ms = budgetRemainingMs()
        if ms > 0 { Thread.sleep(forTimeInterval: Double(ms) / 1000.0) }
        environmentFailure("the harness spent its whole \(harnessDeadlineMs) ms budget " +
                           "without finishing; it was at: \(progress.now())")
    }
    t.name = "stc.writer-gate.deadline"
    t.start()
}

/// Carries a bounded call's result back from the thread it ran on.
final class Box<T> { var value: T? }

/// Runs `body` on another thread and gives up waiting after `ms`.
///
/// STC-259: any FIRST touch of a paravirtualized H.264 encoder can block
/// forever on a contended CI host. Blocking calls into VideoToolbox cannot be
/// cancelled, so this does not try — it abandons the wait and leaves the thread
/// wedged, which is safe because the very next thing is process exit.
///
/// The bound must stay well clear of runSwiftHarness's 45 s outer bound. Set
/// them close and the outer one wins the race, this message is never printed,
/// and the run reads as an unexplained stall — the failure mode of all five
/// STC-259 sightings, and of three separate bounds added to this harness.
/// That clearance is no longer arithmetic to be kept in step by hand: the wait
/// is CLAMPED to the budget remaining before the deadline, so a specific
/// message always beats the generic watchdog, which in turn always beats the
/// runner's kill.
func bounded<T>(_ what: String, ms: Int, _ body: @escaping () -> T) -> T {
    progress.set(what)
    let budget = min(ms, budgetRemainingMs())
    if budget <= 0 {
        environmentFailure("\(what) never got to start — the harness's " +
                           "\(harnessDeadlineMs) ms budget was already spent")
    }
    let box = Box<T>()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global().async { box.value = body(); done.signal() }
    if done.wait(timeout: .now() + .milliseconds(budget)) == .timedOut {
        environmentFailure("\(what) did not answer within \(budget) ms — it is still blocked")
    }
    return box.value!
}

/// Set by the test to prove `bounded` actually fires. The real trigger is a
/// contended CI host, which cannot be summoned on demand.
let injectedFault = ProcessInfo.processInfo.environment["STC_WG_FAULT"]

/// Appends one line per process start, when the test asks for it.
///
/// The runner retries this harness when the machine declines an encoder, and a
/// retry nobody can count is a retry nobody has verified. Reading the count off
/// the machine beats trusting the loop that produced it.
func recordAttempt() {
    guard let path = ProcessInfo.processInfo.environment["STC_WG_ATTEMPT_LOG"] else { return }
    let line = "start \(ProcessInfo.processInfo.processIdentifier)\n"
    if let fh = FileHandle(forWritingAtPath: path) {
        fh.seekToEndOfFile()
        fh.write(line.data(using: .utf8)!)
        try? fh.close()
    } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
}

/// How long any single encoder query gets before it is called wedged.
///
/// A healthy query answers in milliseconds — 68 ms measured on this machine —
/// so 15 s is slack, not tolerance. It also has to stay well under the runner's
/// HARNESS_RUN_MS, which the test asserts against the value printed below
/// rather than trusting these two numbers to be kept in step by hand.
///
/// The override exists so the fault test can fire this bound in a second
/// instead of fifteen; it must never be set in a real run.
let encoderQueryBoundMs =
    Int(ProcessInfo.processInfo.environment["STC_WG_ENCODER_BOUND_MS"] ?? "") ?? 15_000

/// How long the FIRST append of a take gets before it is called wedged.
///
/// STC-259 step 2. The two queries above ask whether an encoder exists and
/// whether one can be acquired; this is the third and last first touch, and it
/// is the one both original STC-254 crash reports pointed at:
/// `AVAssetWriterInputPixelBufferAdaptor.append` creates the video compressor
/// lazily, and where no encoder can be had it does not fail — it blocks. Until
/// now it was the only first touch this harness left unbounded, so a run wedged
/// there printed "phase 2: live-gate append" and then nothing.
///
/// Same slack as a query, and for the same reason: a healthy first append is
/// milliseconds. Separately overridable so the fault test can fire this bound
/// without also shortening the queries it is not testing.
let appendBoundMs =
    Int(ProcessInfo.processInfo.environment["STC_WG_APPEND_BOUND_MS"] ?? "") ?? encoderQueryBoundMs

/// Reports what VideoToolbox will actually give us before we ask AVFoundation
/// for a writer.
///
/// STC-259: this harness stalls on some CI runners, and on one such run the
/// Electron export failed on the same machine with "no usable H.264 encoder".
/// An AVAssetWriter's first append creates the compressor lazily, and if no
/// encoder can be had it does not fail — it blocks. So the inventory is taken
/// FIRST, and printed whether or not anything goes wrong: a stalling run that
/// reports a healthy encoder kills that hypothesis just as usefully as one that
/// reports none confirms it.
func reportEncoders() {
    if injectedFault == "encoder-query-hang" {
        diag("FAULT INJECTED: acting as if VTCopyVideoEncoderList never returns")
        Thread.sleep(forTimeInterval: 600)
        return
    }
    var listCF: CFArray?
    let status = VTCopyVideoEncoderList(nil, &listCF)
    guard status == noErr, let list = listCF as? [[CFString: Any]] else {
        diag("VTCopyVideoEncoderList failed with status \(status) — NO encoder inventory")
        return
    }
    var h264 = 0
    for enc in list {
        let codec = enc[kVTVideoEncoderList_CodecType] as? Int ?? 0
        guard codec == Int(kCMVideoCodecType_H264) else { continue }
        h264 += 1
        let name = enc[kVTVideoEncoderList_EncoderName] as? String ?? "?"
        let hw = enc[kVTVideoEncoderList_IsHardwareAccelerated] as? Bool ?? false
        diag("h264 encoder: \(name) hardware=\(hw)")
    }
    diag("encoders total=\(list.count) h264=\(h264)")
    if h264 == 0 {
        diag("NO H.264 ENCODER — an AVAssetWriter append will block rather than fail here")
    }
}

/// Asks whether an encoder can actually be OBTAINED, not merely whether one is
/// listed.
///
/// The inventory answers "does an H.264 encoder exist on this machine". The
/// stall is about "can this process have one right now", and those are
/// different questions. CI reports its hardware encoder as
/// `paravirtualized:Apple Video Encoder` — a passthrough to a host shared with
/// other tenants, which can be listed and still be unavailable in the moment.
///
/// Timed, because a slow acquisition is the interesting middle case: if this
/// takes seconds rather than milliseconds, contention is real even when it
/// eventually succeeds.
func probeEncoderAcquisition() {
    let t0 = DispatchTime.now().uptimeNanoseconds
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(W), height: Int32(H),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: nil,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: nil,
        refcon: nil,
        compressionSessionOut: &session)
    let ms = Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6

    guard status == noErr, let s = session else {
        diag(String(format: "COULD NOT ACQUIRE an H.264 encoder session: status %d after %.1f ms", status, ms))
        diag("an AVAssetWriter append will block rather than fail in this state")
        return
    }
    var hwCF: CFTypeRef?
    VTSessionCopyProperty(s,
        key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
        allocator: kCFAllocatorDefault, valueOut: &hwCF)
    let hw = (hwCF as? Bool) ?? false
    diag(String(format: "acquired an H.264 encoder session in %.1f ms (hardware=%@)", ms, hw ? "true" : "false"))
    VTCompressionSessionInvalidate(s)
}

let W = 1280, H = 720
var failures: [String] = []

/// `gate.append`, with a hang injectable in front of it.
///
/// The real trigger is a contended host refusing this process a compressor,
/// which cannot be summoned on demand — so, exactly as `reportEncoders` does
/// for the inventory, the fault stands in for VideoToolbox. What is under test
/// is the bound and the watchdog behind it, not AVFoundation.
func appendMaybeHanging(_ gate: WriterGate, _ pb: CVPixelBuffer, at t: CMTime,
                        fault: String) -> WriterGate.Outcome {
    // `!fault.isEmpty` first: the race loop passes "" for every iteration it is
    // not injecting into, and STC_WG_FAULT="" would otherwise match all of them.
    if !fault.isEmpty, injectedFault == fault {
        diag("FAULT INJECTED (\(fault)): acting as if the append never returns")
        Thread.sleep(forTimeInterval: 600)
    }
    return gate.append(pb, at: t)
}

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
    // stderr FIRST. It is unbuffered and the runner streams it live, so this
    // survives even if the exit below never completes. stdout is block-buffered
    // when piped, which is the normal case here.
    diag("ENVIRONMENT: \(what)")
    print("ENVIRONMENT: \(what)")
    print("This is the machine declining to provide what the harness needs, NOT a")
    print("WriterGate regression. The race assertions did not complete.")
    // `_exit`, not `exit`. This is reachable with a thread still wedged inside
    // VideoToolbox, and `exit` runs atexit handlers that could want a lock that
    // thread is holding — turning a legible failure back into the silent stall
    // it exists to replace. `_exit` skips them, so stdout is flushed by hand.
    fflush(stdout)
    _exit(2)
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

// FIRST line out, before any VideoToolbox call. On CI run 33096447275 this
// harness stalled and produced ZERO output — not even the encoder inventory,
// which used to be the first thing printed. That leaves two candidates that
// look identical from outside: the swiftc compile hung, or the binary started
// and VTCopyVideoEncoderList blocked before anything could be written.
//
// The second is not far-fetched: CI's H.264 encoder is `paravirtualized`, a
// passthrough to a shared host, and the diagnostic added to detect encoder
// trouble would then be the thing hanging on encoder trouble. This line tells
// the two apart at a glance.
diag("harness started (pid \(ProcessInfo.processInfo.processIdentifier))")
recordAttempt()
// Started before the first bounded call, so nothing below this line can stall
// without something naming it. Everything after this point is covered: the
// specific bounds where a specific message is possible, this where it is not.
startDeadlineWatchdog()

// On stdout, because the test reads them back and checks them against the
// runner's own bounds. A constant nobody compares is a constant that drifts.
for line in ["encoder query bound \(encoderQueryBoundMs) ms",
             "first append bound \(appendBoundMs) ms",
             "harness deadline \(harnessDeadlineMs) ms"] {
    print(line)
    diag(line)
}

// Both are first touches of the encoder, and the fifth STC-259 sighting caught
// the inventory blocking forever.
bounded("the encoder query VTCopyVideoEncoderList", ms: encoderQueryBoundMs, reportEncoders)
diag("encoder inventory done")
bounded("the encoder query VTCompressionSessionCreate", ms: encoderQueryBoundMs, probeEncoderAcquisition)
diag("phase 1: closed-gate assertions")
progress.set("phase 1: closed-gate assertions")

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

diag("phase 2: live-gate append")

// 2. A live gate appends. This is the take's FIRST real append and therefore
// the process's last unbounded first touch of the encoder (STC-259 step 2):
// the compressor is created lazily right here. Bounded on another thread, which
// costs nothing because nothing races it — unlike phase 3 below, where moving
// the append off this thread would change the race under test.
do {
    let (w, inp, ad) = makeWriter("gate-live.mp4")
    let gate = WriterGate()
    gate.install(input: inp, adaptor: ad)
    let pb = makeBuffer()
    let outcome = bounded("the first AVAssetWriter append", ms: appendBoundMs) {
        appendMaybeHanging(gate, pb, at: .zero, fault: "first-append-hang")
    }
    check(outcome == .appended, "append on a live gate should succeed")
    gate.closeAndMarkFinished()
    w.cancelWriting()
}

// 3. The regression: the first append racing teardown must not kill the process.
// The delay sweep walks the teardown across the compressor-creation window;
// unguarded, this dies within the first few iterations.
diag("phase 3: race loop, 120 iterations")
let iterations = 120
for i in 0..<iterations {
    if i % 20 == 0 { diag("race iteration \(i)") }
    // Every iteration, not every twentieth: this is what the watchdog reports,
    // and "somewhere in a 120-iteration loop" is the vagueness it exists to
    // replace. Setting a string under a lock 120 times is free next to an
    // encode.
    progress.set("phase 3: race iteration \(i) of \(iterations)")
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

    // Deliberately inline and deliberately UNBOUNDED. The race is between this
    // thread and the teardown dispatched above; putting a `bounded` here would
    // add a third thread and a dispatch of unknown latency between them, which
    // is the one edit that could quietly stop this harness from reproducing
    // STC-254 while still passing. The deadline watchdog covers it instead, and
    // names the iteration.
    _ = appendMaybeHanging(gate, pb, at: CMTime(value: 0, timescale: 1_000_000_000),
                           fault: i == 0 ? "race-append-hang" : "")
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
