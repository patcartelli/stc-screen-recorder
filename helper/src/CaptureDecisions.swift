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

enum CameraOpenDecision: Equatable {
    /// Store the opened camera so `stop()` can close it as part of the take.
    case store
    /// `stop()` had already begun by the time the open resolved: nothing else
    /// will ever call stop() on this instance, so it must be closed
    /// immediately rather than stored and forgotten (HIGH 1 — a camera left
    /// running for the rest of the process's life, LED included).
    case closeImmediately
    /// The open itself failed — there is no camera to store or close, only
    /// a failure to report.
    case reportFailure
}

/// The decision `startCameraAsync` makes once the camera's async open
/// resolves (Capture.swift). Extracted because the race it resolves — stop()
/// arriving before, during, or after the open — was previously only
/// exercisable by timing a live recording against a real device; as a pure
/// function it is testable with two booleans (helper/test/decisions/main.swift).
func decideCameraOpen(opened: Bool, stoppingBegan: Bool) -> CameraOpenDecision {
    guard opened else { return .reportFailure }
    return stoppingBegan ? .closeImmediately : .store
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


// ── which camera to open (STC-286) ──────────────────────────────────────────

/// A FourCC as the Int32 `AVCaptureDevice.transportType` reports.
func fourCC(_ s: String) -> Int32 {
    var v: Int32 = 0
    for b in s.utf8.prefix(4) { v = (v << 8) | Int32(b) }
    return v
}

/// `'virt'` — a software camera with no capture hardware behind it.
let kTransportVirtual = fourCC("virt")
/// `'usb '` — a plugged-in camera, which is what someone who plugged one in wants.
let kTransportUSB = fourCC("usb ")

struct CameraChoice: Equatable {
    let name: String
    /// True only when every candidate was virtual and one had to be taken anyway.
    let isVirtual: Bool
}

/**
 Picks the camera to record from, given each candidate's name and transportType.

 `AVCaptureDevice.DiscoverySession(...).devices.first` is not a choice, it is
 whatever AVFoundation returned first — and on 2026-08-29 that was
 "Elgato Virtual Camera". A virtual camera with nothing feeding it idles at
 about 1 fps, so three consecutive takes recorded 12 frames in 11 seconds
 beside a perfectly good display track, and the app reported success.

 Ranked by transportType rather than by name: "Camo", "OBS", "NDI" and friends
 are not a closed set, and a name test fails silently on the next one. USB
 first because someone who plugged a camera in meant to use it; built-in and
 Continuity next; virtual last and only if it is all there is — refusing to
 record at all would be worse, and a virtual camera is a legitimate setup for
 streamers. When it IS the only option the caller is told, so it can warn
 instead of quietly shipping a 1 fps PiP.

 Pure, so it is tested without a camera — the same reason decideCameraOpen is.
 */
func pickCamera(_ devices: [(name: String, transportType: Int32)]) -> CameraChoice? {
    guard !devices.isEmpty else { return nil }
    // Stable: equal ranks keep discovery order, so this only ever moves a
    // device that is genuinely worse, never shuffles equals.
    func rank(_ t: Int32) -> Int {
        if t == kTransportVirtual { return 2 }
        if t == kTransportUSB { return 0 }
        return 1
    }
    let best = devices.enumerated().min { a, b in
        let ra = rank(a.element.transportType), rb = rank(b.element.transportType)
        return ra == rb ? a.offset < b.offset : ra < rb
    }!.element
    return CameraChoice(name: best.name, isVirtual: best.transportType == kTransportVirtual)
}
