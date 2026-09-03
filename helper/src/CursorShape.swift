import Foundation
import AppKit

/// The AppKit side of STC-309: reading which pointer the system is showing and
/// reducing it to a `CursorSignature`. Everything that DECIDES — which shape a
/// signature is, whether that is a change worth an event — lives in
/// CaptureDecisions.swift, which has no AppKit dependency and is exercised by
/// helper/test/decisions/main.swift without a pointer in sight.
///
/// The mechanism is `NSCursor.currentSystem`, documented to return the current
/// cursor "regardless of which application set it". The helper is a background
/// process with no window, so whether that holds for it was the open question
/// (STC-309 increment 0); the `cursor-probe` command below is the measurement,
/// and it runs THIS code on the same kind of thread the recording uses, so it
/// answers for the production path rather than for a stand-in.
///
/// The fallback if `currentSystem` turns out blind — `CGDisplayCopyCursorForDisplay`
/// via dlsym, absent from the 13.3 headers — is deliberately NOT here. It is
/// private API, and the ticket names it as a last resort to be reached for
/// only once the probe has shown the public one does not see other apps'
/// pointers.
enum CursorShape {
    /// The built-in for one of `cursorShapeNames`, or nil for a name AppKit
    /// has no cursor for. `cursorShapeNames` is the list (CaptureDecisions.swift,
    /// held equal to the schema by a test); this is only the lookup.
    static func builtIn(named name: String) -> NSCursor? {
        switch name {
        case "arrow":        return .arrow
        case "ibeam":        return .iBeam
        case "crosshair":    return .crosshair
        case "pointingHand": return .pointingHand
        default:             return nil
        }
    }

    /// Reduces a cursor to its signature; nil when its image has no bitmap.
    ///
    /// The bytes hashed are the CGImage's backing store — row padding included,
    /// which is fine because sample and reference go through the same call.
    /// `cgImage(forProposedRect:context:hints:)` picks one representation for
    /// a multi-rep NSImage; with no context it is the same choice every call
    /// in one process, which is all the comparison needs.
    static func signature(of cursor: NSCursor) -> CursorSignature? {
        let image = cursor.image
        let hot = cursor.hotSpot
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
              let data = cg.dataProvider?.data,
              let base = CFDataGetBytePtr(data)
        else { return nil }
        let hash = fnv1a(UnsafeRawBufferPointer(start: base, count: CFDataGetLength(data)))
        return CursorSignature(width: Double(image.size.width), height: Double(image.size.height),
                               hotX: Double(hot.x), hotY: Double(hot.y), hash: hash)
    }

    /// The signature plus the things a human reading a probe transcript wants
    /// beside it: pixel size and the scale that implies. Probe only.
    static func describe(_ cursor: NSCursor) -> [String: Any] {
        var o: [String: Any] = [:]
        if let s = signature(of: cursor) {
            o["width"] = s.width; o["height"] = s.height
            o["hotX"] = s.hotX; o["hotY"] = s.hotY
            o["hash"] = String(s.hash, radix: 16)
        } else {
            o["signature"] = "none"
        }
        if let cg = cursor.image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            o["pixelWidth"] = cg.width
            o["pixelHeight"] = cg.height
            if cursor.image.size.width > 0 {
                o["scale"] = Double(cg.width) / Double(cursor.image.size.width)
            }
        }
        o["reps"] = cursor.image.representations.count
        return o
    }

    /// What each of the schema's shapes looks like on this machine, right now.
    /// Measured at tap start rather than baked in: the pointer-size
    /// accessibility setting and the display's backing scale both change the
    /// bytes, and both are the same for the live pointer and for these.
    /// `missing` names any shape AppKit could not give a bitmap for — those
    /// can never be emitted, and the caller should say so once.
    static func references() -> (refs: [CursorReference], missing: [String]) {
        var refs: [CursorReference] = []
        var missing: [String] = []
        for name in cursorShapeNames {
            if let c = builtIn(named: name), let s = signature(of: c) {
                refs.append(CursorReference(shape: name, signature: s))
            } else {
                missing.append(name)
            }
        }
        return (refs, missing)
    }
}

/// Samples the system pointer on a run loop and reports shape changes.
///
/// One instance per recording, scheduled on the TAP's own run loop
/// (Capture.startEventTap): one thread then owns the order of everything that
/// goes into `events`, and the tap callback stays untouched. The cost of that
/// is that this callback must be cheap — a starved tap is disabled by the
/// system (`tapDisabledByTimeout`, counted by `tapReenables`) — which is why
/// the probe measures the per-sample time rather than assuming it.
///
/// Why a timer and not a hook on mouseMoved: the pointer changes on hover
/// without the mouse moving (a page finishing its load under a still cursor,
/// a field gaining focus), and a hook would miss every one of those.
final class CursorSampler {
    private let references: [CursorReference]
    private var previous: String? = nil
    private var previousSignature: CursorSignature? = nil
    private var timer: CFRunLoopTimer?
    private let onChange: (_ shape: String, _ observedNs: UInt64) -> Void
    /// Probe hook, nil in production: called whenever the SIGNATURE changes,
    /// mapped or not, so a transcript shows what unknown pointers looked like.
    private let trace: ((_ signature: CursorSignature?, _ shape: String?, _ observedNs: UInt64) -> Void)?

    // Counters: read by the probe after the loop has stopped, written only on
    // the sampling thread. Not locked on purpose; nothing reads them live.
    private(set) var samples = 0
    private(set) var nilSamples = 0
    private(set) var sampleNsMax: UInt64 = 0
    private(set) var sampleNsTotal: UInt64 = 0

    init(references: [CursorReference],
         onChange: @escaping (_ shape: String, _ observedNs: UInt64) -> Void,
         trace: ((_ signature: CursorSignature?, _ shape: String?, _ observedNs: UInt64) -> Void)? = nil) {
        self.references = references
        self.onChange = onChange
        self.trace = trace
    }

    /// Installs the timer on `runLoop`. Call from any thread; the timer fires
    /// on whichever thread runs that loop.
    func schedule(on runLoop: CFRunLoop, intervalSeconds: Double) {
        let t = CFRunLoopTimerCreateWithHandler(
            kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + intervalSeconds, intervalSeconds, 0, 0
        ) { [weak self] _ in self?.tick() }
        timer = t
        CFRunLoopAddTimer(runLoop, t, .commonModes)
    }

    /// Safe from any thread (CFRunLoopTimerInvalidate is), and idempotent.
    func invalidate() {
        if let t = timer { CFRunLoopTimerInvalidate(t) }
        timer = nil
    }

    /// One sample. The time is taken BEFORE the read so `t` says when the
    /// pointer was seen, not when the hash finished.
    func tick() {
        let observedNs = Clock.nowNs()
        // nil is nil: a missing pointer is counted, never read as an arrow.
        let sample = NSCursor.currentSystem.flatMap { CursorShape.signature(of: $0) }
        let cost = Clock.nowNs() &- observedNs
        samples += 1
        sampleNsTotal &+= cost
        if cost > sampleNsMax { sampleNsMax = cost }

        guard let sample else {
            nilSamples += 1
            if previousSignature != nil { trace?(nil, nil, observedNs); previousSignature = nil }
            return
        }
        let decision = decideCursorShape(sample: sample, references: references, previous: previous)
        if let trace, sample != previousSignature {
            trace(sample, classifyCursor(sample, references: references), observedNs)
        }
        previousSignature = sample
        if case .emit(let shape) = decision {
            previous = shape
            onChange(shape, observedNs)
        }
    }
}

/// `cursor-probe`: STC-309 increment 0, as a helper command so it runs the
/// production code in the production process shape (a background process,
/// NSApplication with the accessory policy, sampling off the main thread) and
/// under whatever TCC identity launched it — tools/test-host `--cursor-probe`
/// for the honest one.
///
/// It answers, in one JSON reply: what the four references look like here;
/// every signature change seen while it ran, mapped shape beside it; what the
/// sampler would have emitted; and what a sample costs the thread it runs on.
/// `onMain` moves the timer to the main run loop for the case where AppKit
/// refuses `currentSystem` off-main — compare the two transcripts.
enum CursorProbe {
    static func run(ms: Int, intervalSeconds: Double, onMain: Bool,
                    completion: @escaping ([String: Any]) -> Void) {
        let startNs = Clock.nowNs()
        let (refs, missing) = CursorShape.references()
        let lock = NSLock()
        var changes: [[String: Any]] = []
        var emitted: [[String: Any]] = []
        let ms = max(100, ms)

        let sampler = CursorSampler(
            references: refs,
            onChange: { shape, atNs in
                lock.lock()
                emitted.append(["tMs": Double(atNs &- startNs) / 1e6, "shape": shape])
                lock.unlock()
            },
            trace: { sig, shape, atNs in
                var o: [String: Any] = ["tMs": Double(atNs &- startNs) / 1e6]
                if let sig {
                    o["shape"] = shape ?? "?"
                    o["width"] = sig.width; o["height"] = sig.height
                    o["hotX"] = sig.hotX; o["hotY"] = sig.hotY
                    o["hash"] = String(sig.hash, radix: 16)
                    // Pixel size and scale come from a second read; the
                    // pointer can change between the two, which only matters
                    // for a human reading the table, so it is named as such.
                    if let cur = NSCursor.currentSystem {
                        let d = CursorShape.describe(cur)
                        o["pixelWidth"] = d["pixelWidth"]; o["pixelHeight"] = d["pixelHeight"]
                        o["scale"] = d["scale"]; o["reps"] = d["reps"]
                    }
                } else {
                    o["shape"] = "nil-sample"
                }
                lock.lock(); changes.append(o); lock.unlock()
            })

        let finish = {
            sampler.invalidate()
            lock.lock()
            let ch = changes, em = emitted
            lock.unlock()
            var refsOut: [[String: Any]] = []
            for name in cursorShapeNames {
                var o: [String: Any] = ["shape": name]
                if let c = CursorShape.builtIn(named: name) { o.merge(CursorShape.describe(c)) { a, _ in a } }
                refsOut.append(o)
            }
            completion([
                "thread": onMain ? "main" : "sampler",
                "intervalMs": intervalSeconds * 1000,
                "ranMs": Double(Clock.nowNs() &- startNs) / 1e6,
                "references": refsOut,
                "missingReferences": missing,
                "samples": sampler.samples,
                "nilSamples": sampler.nilSamples,
                "sampleUsMax": Double(sampler.sampleNsMax) / 1e3,
                "sampleUsMean": sampler.samples > 0 ? Double(sampler.sampleNsTotal) / Double(sampler.samples) / 1e3 : 0,
                "changes": ch,
                "emitted": em,
            ])
        }

        if onMain {
            sampler.schedule(on: CFRunLoopGetMain(), intervalSeconds: intervalSeconds)
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ms)) { finish() }
            return
        }
        // The same arrangement as the tap thread: a plain Thread running its
        // own CFRunLoop, stopped by a one-shot timer on that loop.
        let t = Thread {
            let rl = CFRunLoopGetCurrent()
            sampler.schedule(on: rl, intervalSeconds: intervalSeconds)
            let end = CFRunLoopTimerCreateWithHandler(
                kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + Double(ms) / 1000, 0, 0, 0
            ) { _ in CFRunLoopStop(rl) }
            CFRunLoopAddTimer(rl, end, .commonModes)
            CFRunLoopRun()
            finish()
        }
        t.name = "cursor-probe"
        t.start()
    }
}
