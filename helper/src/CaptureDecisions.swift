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

/// Why the system says a tap was disabled. Two different events, two
/// different stories: a TIMEOUT means the tap's thread did not answer in
/// time (starvation — the thing STC-309's sampler must never cause), while
/// USER INPUT is what CoreGraphics reports back for a `tapEnable(false)` —
/// including the helper's own, in `stop()`. Counting them as one number
/// made the second look like the first.
enum TapDisableReason: String, Equatable {
    case timeout
    case userInput
}

enum CursorEventDecision: Equatable {
    /// The system disabled the tap; during a recording it must be re-enabled
    /// or input stops arriving silently for the rest of the take. After
    /// `stop()` has disabled it on purpose, the caller must NOT re-enable.
    case reenableTap(reason: TapDisableReason)
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
    if type == .tapDisabledByTimeout { return .reenableTap(reason: .timeout) }
    if type == .tapDisabledByUserInput { return .reenableTap(reason: .userInput) }

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


// ── which pointer is showing (STC-309) ──────────────────────────────────────

/// The shapes the helper may write into events.json.
///
/// MUST equal the `shape` enum in schema/events-2.schema.json, which in turn
/// equals what transform/src/cursor-art.ts can draw. Three lists in three
/// languages; helper/test/cursor-shape-names.test.ts holds this one to the
/// schema the way cursor-art.test.ts holds the schema to the artwork. A name
/// the compositor cannot draw must never reach the file, so anything not in
/// this list classifies as the arrow.
let cursorShapeNames = ["arrow", "ibeam", "crosshair", "pointingHand"]

/// What the compositor shows before the first cursor event (events-2), so a
/// take that never leaves the arrow emits nothing and the default holds.
let defaultCursorShape = "arrow"

/// A pointer reduced to what tells the built-ins apart.
///
/// Computed the same way for the live pointer and for each reference
/// (CursorShape.swift), in the same process, at the same pointer-size setting
/// and backing scale — so those cancel out instead of needing a table of
/// measured values that drifts the first time either changes.
struct CursorSignature: Equatable {
    /// Image size in points, as NSImage.size reports it.
    let width: Double
    let height: Double
    /// Hotspot in points, from NSCursor.hotSpot.
    let hotX: Double
    let hotY: Double
    /// FNV-1a over the bitmap's bytes. Geometry decides first; this breaks ties.
    let hash: UInt64

    func sameGeometry(as o: CursorSignature) -> Bool {
        width == o.width && height == o.height && hotX == o.hotX && hotY == o.hotY
    }
}

/// One of `cursorShapeNames`, as it looks on this machine right now.
struct CursorReference: Equatable {
    let shape: String
    let signature: CursorSignature
}

enum CursorShapeDecision: Equatable {
    /// Same shape as the last sample (or the arrow, for the first one).
    case unchanged
    /// The pointer changed shape; append `{t, kind: "cursor", shape}`.
    case emit(shape: String)
}

/// 64-bit FNV-1a. Not cryptographic, and does not need to be: it decides
/// whether two ~4 KB pointer bitmaps in one process are the same bytes.
func fnv1a(_ bytes: UnsafeRawBufferPointer) -> UInt64 {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for b in bytes {
        h ^= UInt64(b)
        h = h &* 0x0000_0100_0000_01b3
    }
    return h
}

/// Which of the references a sample is.
///
/// Order matters and is the mapping rule the ticket asked for:
///   1. exact match (geometry AND bytes) — the normal case, since sample and
///      references come from the same process at the same settings;
///   2. a UNIQUE geometry match — survives a representation change (a
///      different rep chosen for the live pointer, say) that moves the hash
///      while size and hotspot hold;
///   3. otherwise the arrow. Several built-ins sharing a geometry with no byte
///      match is ambiguous, and a wrong shape is worse than the default.
func classifyCursor(_ s: CursorSignature, references: [CursorReference]) -> String {
    if let exact = references.first(where: { $0.signature == s }) { return exact.shape }
    let geometric = references.filter { $0.signature.sameGeometry(as: s) }
    if geometric.count == 1 { return geometric[0].shape }
    return defaultCursorShape
}

/// Emit only on change: the file holds a compact reference to which pointer
/// is showing from t onward, never a bitmap and never one entry per tick.
/// `previous == nil` means "nothing emitted yet", which the compositor reads
/// as the arrow, so the first sample being an arrow produces no event.
func decideCursorShape(sample: CursorSignature, references: [CursorReference],
                       previous: String?) -> CursorShapeDecision {
    let shape = classifyCursor(sample, references: references)
    return shape == (previous ?? defaultCursorShape) ? .unchanged : .emit(shape: shape)
}

/// events.json in time order, stable on ties.
///
/// Appending order is not time order once two clocks feed one array: a
/// move carries CGEvent.timestamp (when the event was generated) and a cursor
/// event carries the sampler's own reading of the same mach clock (when the
/// pointer was seen), and a move can be DELIVERED after a sampler tick that
/// observed later than the move was generated. The transform sorts for
/// itself (cursor.ts), so this is about the file being honest, not about
/// correctness downstream — and about real-events.test.ts's monotonic check
/// meaning what it says.
func orderedEvents(_ events: [[String: Any]]) -> [[String: Any]] {
    events.enumerated().sorted { a, b in
        let ta = a.element["t"] as? Int ?? 0
        let tb = b.element["t"] as? Int ?? 0
        return ta != tb ? ta < tb : a.offset < b.offset
    }.map { $0.element }
}
