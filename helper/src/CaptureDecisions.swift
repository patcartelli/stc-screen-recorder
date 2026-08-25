import Foundation
import CoreGraphics

/// The decisions capture makes, extracted from the callbacks that make them.
///
/// These were embedded in `SCStream`/`CGEventTap` handlers, so exercising them
/// meant performing a real recording by hand. They are pure — the same inputs
/// always give the same answer — and the errors they guard against are the
/// quiet kind: a 41.667x unit mistake produces timestamps that still look
/// plausible, and a non-monotonic PTS aborts a recording at append time.

/// mach ticks → nanoseconds.
///
/// `SCStreamFrameInfo.displayTime` is mach ticks (41.667 ns each on Apple
/// Silicon, 1 ns on Intel) and MUST be converted. `CGEvent.timestamp` is
/// already nanoseconds on the same epoch and must NOT be. Mixing them up is a
/// 41.667x error that is invisible outside Apple Silicon (PHASE-0 §1).
@inline(__always)
func machToNs(_ ticks: UInt64, numer: UInt32, denom: UInt32) -> UInt64 {
    ticks &* UInt64(numer) / UInt64(denom)
}

enum FrameDecision: Equatable {
    /// Not a complete frame, or older than the session start. VFR emits
    /// nothing here — deliberately not a repeated frame (PHASE-0 §4).
    case skip
    /// PTS did not advance. AVAssetWriter requires strictly increasing
    /// presentation times; appending this would abort the recording.
    case nonMonotonic
    case accept(ptsNs: Int64)
}

func decideFrame(statusRaw: Int, displayTimeRaw: UInt64,
                 timebase: (numer: UInt32, denom: UInt32),
                 t0Ns: UInt64, lastPtsNs: Int64) -> FrameDecision {
    guard statusRaw == SCFrameStatusCompleteRaw else { return .skip }
    let dtNs = machToNs(displayTimeRaw, numer: timebase.numer, denom: timebase.denom)
    guard dtNs >= t0Ns else { return .skip }
    let ptsNs = Int64(dtNs - t0Ns)
    guard ptsNs > lastPtsNs else { return .nonMonotonic }
    return .accept(ptsNs: ptsNs)
}

/// `SCFrameStatus.complete`, as a raw value so this file needs no
/// ScreenCaptureKit import and can be compiled into a test binary.
let SCFrameStatusCompleteRaw = 0

enum CursorEventDecision: Equatable {
    /// The system disabled the tap; it must be re-enabled or input stops
    /// arriving silently for the rest of the recording.
    case reenableTap
    case ignore
    /// Earlier than the session start. events-1 requires t >= 0.
    case beforeStart
    case event(t: Int, kind: String, button: Int?)
}

func decideCursorEvent(type: CGEventType, timestampNs: UInt64, t0Ns: UInt64) -> CursorEventDecision {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { return .reenableTap }

    let kind: String
    var button: Int? = nil
    switch type {
    // A drag is a move: the press that started it is already recorded, and the
    // transform reconstructs "held" from the surrounding down/up pair.
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged: kind = "move"
    case .leftMouseDown:  kind = "down"; button = 0
    case .leftMouseUp:    kind = "up";   button = 0
    case .rightMouseDown: kind = "down"; button = 1
    case .rightMouseUp:   kind = "up";   button = 1
    default: return .ignore
    }
    guard timestampNs >= t0Ns else { return .beforeStart }
    return .event(t: Int(timestampNs - t0Ns), kind: kind, button: button)
}
