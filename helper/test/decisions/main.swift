// Pure-function tests for the capture decisions. Compiled together with the
// production source, same as the geometry tests: no XCTest here, so the
// "framework" is assertions plus a non-zero exit code.
import Foundation
import CoreGraphics

var failures = 0
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        print("FAIL \(label): got \(got), want \(want)")
        failures += 1
    }
}

// ── mach ticks → nanoseconds ────────────────────────────────────────────────
// The bug this guards against is invisible: displayTime is mach ticks and
// CGEvent.timestamp is already nanoseconds. Treating one as the other is a
// 41.667x error that still produces plausible-looking timestamps.
check("41.667 ns/tick (this machine): 24 ticks -> 1000 ns", machToNs(24, numer: 125, denom: 3), UInt64(1000))
check("Intel 1/1 is identity", machToNs(123_456_789, numer: 1, denom: 1), UInt64(123_456_789))
check("zero", machToNs(0, numer: 125, denom: 3), UInt64(0))
// A year of uptime at 24 MHz is ~7.6e14 ticks; x125 must not wrap.
let yearTicks: UInt64 = 24_000_000 * 31_536_000
check("no overflow at a year of uptime",
      machToNs(yearTicks, numer: 125, denom: 3) > 31_000_000_000_000_000, true)

// ── frame acceptance ────────────────────────────────────────────────────────
let tb = (numer: UInt32(125), denom: UInt32(3))
let t0: UInt64 = 1_000_000_000

check("incomplete frames produce no sample (VFR emits nothing, never a repeat)",
      decideFrame(statusRaw: 1, displayTimeRaw: 100_000_000, timebase: tb, t0Ns: t0, lastPtsNs: -1),
      FrameDecision.skip)
check("a frame timestamped before the session start is discarded",
      decideFrame(statusRaw: 0, displayTimeRaw: 0, timebase: tb, t0Ns: t0, lastPtsNs: -1),
      FrameDecision.skip)

// displayTime 24_000_000 ticks = 1e9 ns exactly = t0, so pts 0
check("the first frame at exactly t0 lands at pts 0",
      decideFrame(statusRaw: 0, displayTimeRaw: 24_000_000, timebase: tb, t0Ns: t0, lastPtsNs: -1),
      FrameDecision.accept(ptsNs: 0))
check("a later frame gets a positive session-relative pts",
      decideFrame(statusRaw: 0, displayTimeRaw: 24_240_000, timebase: tb, t0Ns: t0, lastPtsNs: 0),
      FrameDecision.accept(ptsNs: 10_000_000))

// AVAssetWriter requires strictly increasing PTS; equal or decreasing would
// throw at append time and abort the recording.
check("a repeated timestamp is rejected, not appended",
      decideFrame(statusRaw: 0, displayTimeRaw: 24_240_000, timebase: tb, t0Ns: t0, lastPtsNs: 10_000_000),
      FrameDecision.nonMonotonic)
check("a going-backwards timestamp is rejected",
      decideFrame(statusRaw: 0, displayTimeRaw: 24_120_000, timebase: tb, t0Ns: t0, lastPtsNs: 10_000_000),
      FrameDecision.nonMonotonic)

// ── cursor events ───────────────────────────────────────────────────────────
// CGEvent.timestamp is ALREADY nanoseconds on the same epoch — converting it
// would be the same 41.667x error in the other direction.
check("a move maps to move with no button",
      decideCursorEvent(type: .mouseMoved, timestampNs: t0 + 500, t0Ns: t0),
      CursorEventDecision.event(t: 500, kind: "move", button: nil))
check("a drag is a move, not its own kind — the press is already recorded",
      decideCursorEvent(type: .leftMouseDragged, timestampNs: t0 + 1, t0Ns: t0),
      CursorEventDecision.event(t: 1, kind: "move", button: nil))
check("left down carries button 0",
      decideCursorEvent(type: .leftMouseDown, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.event(t: 0, kind: "down", button: 0))
check("left up carries button 0",
      decideCursorEvent(type: .leftMouseUp, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.event(t: 0, kind: "up", button: 0))
check("right down carries button 1",
      decideCursorEvent(type: .rightMouseDown, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.event(t: 0, kind: "down", button: 1))
check("right up carries button 1",
      decideCursorEvent(type: .rightMouseUp, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.event(t: 0, kind: "up", button: 1))
// The two disable events are told apart: a timeout is starvation, which
// STC-309's sampler must never cause; user-input is what CoreGraphics reports
// back for tapEnable(false), the helper's own stop() included.
check("a tap disabled by timeout asks to be re-enabled, and says it was a timeout",
      decideCursorEvent(type: .tapDisabledByTimeout, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.reenableTap(reason: .timeout))
check("a tap disabled by user input asks to be re-enabled, and says so",
      decideCursorEvent(type: .tapDisabledByUserInput, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.reenableTap(reason: .userInput))
check("an event before the session start is discarded (schema requires t >= 0)",
      decideCursorEvent(type: .mouseMoved, timestampNs: t0 - 1, t0Ns: t0),
      CursorEventDecision.beforeStart)
check("an unhandled event type is ignored",
      decideCursorEvent(type: .keyDown, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.ignore)

// ── camera open store-vs-close race (STC-232) ───────────────────────────────
// Previously only exercisable by timing a live recording against a real
// camera; as a pure function of two booleans it needs no camera at all.
check("a normal open, no stop in flight, is stored",
      decideCameraOpen(opened: true, stoppingBegan: false),
      CameraOpenDecision.store)
check("an open that resolves AFTER stop() began must be closed immediately, not stored",
      decideCameraOpen(opened: true, stoppingBegan: true),
      CameraOpenDecision.closeImmediately)
check("a failed open with no stop in flight is just a failure to report",
      decideCameraOpen(opened: false, stoppingBegan: false),
      CameraOpenDecision.reportFailure)
check("a failed open is still just a failure even if a stop arrived — there is nothing to close",
      decideCameraOpen(opened: false, stoppingBegan: true),
      CameraOpenDecision.reportFailure)

// ── which camera to open (STC-286) ──────────────────────────────────────────
// Measured on this machine 2026-08-29: the helper opened "Elgato Virtual
// Camera" because it is `discovery.devices.first`, and a virtual camera with
// nothing behind it idles at ~1 fps. Three consecutive takes recorded 12 frames
// in 11 s next to a perfectly good display track, and nothing warned.
//
// transportType is the discriminator, measured rather than guessed:
//   Elgato Virtual Camera 'virt'   FaceTime HD 'bltn'
//   iPhone (Continuity)   'othr'   a USB camera 'usb '
// Name matching was rejected: "Camo", "OBS" and friends are not a closed set.
let virt = fourCC("virt"), bltn = fourCC("bltn")
let usb = fourCC("usb "), othr = fourCC("othr")

check("a real camera is preferred over a virtual one",
      pickCamera([("Elgato Virtual Camera", virt), ("FaceTime HD Camera", bltn)])?.name,
      Optional("FaceTime HD Camera"))
check("and the order it was discovered in does not rescue it",
      pickCamera([("FaceTime HD Camera", bltn), ("Elgato Virtual Camera", virt)])?.name,
      Optional("FaceTime HD Camera"))
// Someone with a Facecam wants the Facecam. Preferring "built-in" would take
// it away from them, which is why this is not a builtIn-first rule.
check("a USB camera beats the built-in",
      pickCamera([("FaceTime HD Camera", bltn), ("Elgato Facecam 4K", usb)])?.name,
      Optional("Elgato Facecam 4K"))
check("Continuity beats a virtual device but not a USB one",
      pickCamera([("Elgato Virtual Camera", virt), ("iPhone Camera", othr),
                  ("Elgato Facecam 4K", usb)])?.name,
      Optional("Elgato Facecam 4K"))
// A virtual camera is a legitimate setup for streamers. Refusing to record at
// all would be worse than recording it — but it must be a deliberate last
// resort, and the caller must be able to say so.
check("a virtual camera is still used when it is the only one",
      pickCamera([("Elgato Virtual Camera", virt)])?.name,
      Optional("Elgato Virtual Camera"))
check("and the caller is told it fell back",
      pickCamera([("Elgato Virtual Camera", virt)])?.isVirtual,
      Optional(true))
check("a real pick is not flagged as a fallback",
      pickCamera([("FaceTime HD Camera", bltn)])?.isVirtual,
      Optional(false))
check("no devices at all is nil, not a crash",
      pickCamera([]) == nil, true)

// ── which pointer is showing (STC-309) ──────────────────────────────────────
// The references are what NSCursor.arrow/.iBeam/.crosshair/.pointingHand look
// like on the machine doing the recording, measured at tap start; the numbers
// here are stand-ins with the SHAPE of real ones (points, hotspot, a hash).
let sigArrow = CursorSignature(width: 17, height: 23, hotX: 4, hotY: 4, hash: 0xA1)
let sigIBeam = CursorSignature(width: 9, height: 18, hotX: 4, hotY: 9, hash: 0xB2)
let sigCross = CursorSignature(width: 17, height: 17, hotX: 8, hotY: 8, hash: 0xC3)
let sigHand  = CursorSignature(width: 17, height: 21, hotX: 6, hotY: 1, hash: 0xD4)
let refs = [CursorReference(shape: "arrow", signature: sigArrow),
            CursorReference(shape: "ibeam", signature: sigIBeam),
            CursorReference(shape: "crosshair", signature: sigCross),
            CursorReference(shape: "pointingHand", signature: sigHand)]

check("the reference list covers exactly the schema's shapes",
      refs.map { $0.shape }, cursorShapeNames)
for r in refs {
    check("an exact match classifies as \(r.shape)", classifyCursor(r.signature, references: refs), r.shape)
}
check("a signature matching nothing is the arrow — the schema refuses unknown names",
      classifyCursor(CursorSignature(width: 32, height: 32, hotX: 16, hotY: 16, hash: 0xEE), references: refs),
      "arrow")
// A representation change moves the hash while size and hotspot hold. The
// geometry is unique among the references, so it still identifies the shape.
check("same geometry, different bytes, unique among references: geometry decides",
      classifyCursor(CursorSignature(width: 9, height: 18, hotX: 4, hotY: 9, hash: 0x99), references: refs),
      "ibeam")
// Two references that share a geometry can only be told apart by bytes.
let refsTwins = refs + [CursorReference(shape: "pointingHand",
                                        signature: CursorSignature(width: 9, height: 18, hotX: 4, hotY: 9, hash: 0xF0))]
check("shared geometry, exact bytes: the byte match wins",
      classifyCursor(CursorSignature(width: 9, height: 18, hotX: 4, hotY: 9, hash: 0xF0), references: refsTwins),
      "pointingHand")
check("shared geometry, no byte match: ambiguous, so the arrow",
      classifyCursor(CursorSignature(width: 9, height: 18, hotX: 4, hotY: 9, hash: 0x99), references: refsTwins),
      "arrow")
check("with no references at all everything is the arrow",
      classifyCursor(sigIBeam, references: []), "arrow")

// Emit only on change; nothing emitted yet reads as the arrow.
check("the first sample being the arrow emits nothing",
      decideCursorShape(sample: sigArrow, references: refs, previous: nil),
      CursorShapeDecision.unchanged)
check("the first sample being an I-beam emits it",
      decideCursorShape(sample: sigIBeam, references: refs, previous: nil),
      CursorShapeDecision.emit(shape: "ibeam"))
check("a repeated sample emits nothing",
      decideCursorShape(sample: sigIBeam, references: refs, previous: "ibeam"),
      CursorShapeDecision.unchanged)
check("a flip emits",
      decideCursorShape(sample: sigHand, references: refs, previous: "ibeam"),
      CursorShapeDecision.emit(shape: "pointingHand"))
check("and the flip back emits again",
      decideCursorShape(sample: sigIBeam, references: refs, previous: "pointingHand"),
      CursorShapeDecision.emit(shape: "ibeam"))
check("an unknown pointer after an I-beam emits the arrow, not nothing",
      decideCursorShape(sample: CursorSignature(width: 32, height: 32, hotX: 16, hotY: 16, hash: 0xEE),
                        references: refs, previous: "ibeam"),
      CursorShapeDecision.emit(shape: "arrow"))
check("an unknown pointer after an arrow is still the arrow, so nothing",
      decideCursorShape(sample: CursorSignature(width: 32, height: 32, hotX: 16, hotY: 16, hash: 0xEE),
                        references: refs, previous: nil),
      CursorShapeDecision.unchanged)

// FNV-1a 64, against the published test vectors.
check("fnv1a of nothing is the offset basis",
      [UInt8]().withUnsafeBytes { fnv1a($0) },
      UInt64(0xcbf29ce484222325))
check("fnv1a of \"a\"",
      Array("a".utf8).withUnsafeBytes { fnv1a($0) }, UInt64(0xaf63dc4c8601ec8c))
check("fnv1a of \"foobar\"",
      Array("foobar".utf8).withUnsafeBytes { fnv1a($0) }, UInt64(0x85944171f73967e8))

// Two clocks feed one array (CGEvent.timestamp for moves, the sampler's own
// reading for cursor events), so append order is not time order.
let unordered: [[String: Any]] = [["t": 5, "kind": "cursor", "shape": "ibeam"],
                                  ["t": 3, "kind": "move"],
                                  ["t": 5, "kind": "move"],
                                  ["t": 9, "kind": "move"]]
let ordered = orderedEvents(unordered)
check("events are written in time order", ordered.map { $0["t"] as? Int ?? -1 }, [3, 5, 5, 9])
check("ties keep append order (stable)", ordered.map { $0["kind"] as? String ?? "" }, ["move", "cursor", "move", "move"])
check("ordering an empty list is fine", orderedEvents([]).count, 0)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
