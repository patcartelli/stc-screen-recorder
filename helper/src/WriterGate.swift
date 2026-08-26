import Foundation
import AVFoundation

/// Owns the asset-writer input for one session and decides, for every captured
/// frame, whether it may still be appended.
///
/// Extracted from CaptureSession for the same reason CaptureDecisions was: the
/// rule it enforces is a concurrency rule, and a concurrency rule that can only
/// be exercised through a live SCStream cannot be tested at all.
///
/// STC-254: the first append of a take lazily creates the video compressor and
/// therefore takes milliseconds. If teardown runs on another thread inside that
/// window, AVFoundation retains a track it has already released and the process
/// dies — seen on CI as SIGSEGV, and reproduced locally in one iteration.
final class WriterGate {
    enum Outcome {
        case appended
        case dropped
    }

    /// Held across the append itself, not just around the nil checks. Checking
    /// `finishing` under a lock and then appending outside it is the bug, not
    /// the fix: the window that kills the process is the append's own duration.
    /// The capture callback therefore blocks a concurrent stop for as long as
    /// one append takes, which is the trade being made deliberately.
    private let lock = NSLock()

    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var finishing = false

    func install(input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor) {
        lock.lock(); defer { lock.unlock() }
        self.input = input
        self.adaptor = adaptor
    }

    /// Appends one frame, or reports why it could not.
    func append(_ pixelBuffer: CVPixelBuffer, at time: CMTime) -> Outcome {
        lock.lock(); defer { lock.unlock() }
        guard !finishing, let input, let adaptor, input.isReadyForMoreMediaData else {
            return .dropped
        }
        return adaptor.append(pixelBuffer, withPresentationTime: time) ? .appended : .dropped
    }

    /// Closes the gate and marks the input finished. Returns false if the gate
    /// was already closed, so a second stop cannot mark a finished input again.
    ///
    /// Blocks until any in-flight append has returned, which is the guarantee
    /// the caller needs before it may finish the writer.
    @discardableResult
    func closeAndMarkFinished() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if finishing { return false }
        finishing = true
        input?.markAsFinished()
        return true
    }
}
