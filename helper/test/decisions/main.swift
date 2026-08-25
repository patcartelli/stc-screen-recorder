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
check("a tap disabled by timeout asks to be re-enabled",
      decideCursorEvent(type: .tapDisabledByTimeout, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.reenableTap)
check("a tap disabled by user input asks to be re-enabled",
      decideCursorEvent(type: .tapDisabledByUserInput, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.reenableTap)
check("an event before the session start is discarded (schema requires t >= 0)",
      decideCursorEvent(type: .mouseMoved, timestampNs: t0 - 1, t0Ns: t0),
      CursorEventDecision.beforeStart)
check("an unhandled event type is ignored",
      decideCursorEvent(type: .keyDown, timestampNs: t0, t0Ns: t0),
      CursorEventDecision.ignore)

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
