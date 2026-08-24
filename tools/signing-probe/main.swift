// Minimal TCC probe for the signing experiment.
//
// ScreenCaptureKit ONLY. Deliberately no AVFoundation: PHASE-0 §2a found that
// taking the default audio input blind stalled capture, and force-killing a
// process holding a Bluetooth mic wedged CoreAudio system-wide — a hazard this
// probe has no reason to go near. It also skips the event tap: the question is
// only whether a cert-signed bundle keeps its Screen Recording grant across a
// rebuild, so every other permission is noise.
//
// Must be a BUNDLE launched via `open`. PHASE-0 §6: exec'ing a bare binary
// makes it inherit the launching terminal's TCC identity, so a terminal-run
// probe measures the terminal's grants, not the app's.
import Foundation
import ScreenCaptureKit
import CoreGraphics
import AppKit

let args = CommandLine.arguments
guard let i = args.firstIndex(of: "--out"), i + 1 < args.count else {
    FileHandle.standardError.write("usage: (in a bundle) --out <result.json>\n".data(using: .utf8)!)
    exit(2)
}
let outURL = URL(fileURLWithPath: args[i + 1])

// Bumped on each rebuild during the signing experiment. Two purposes: it stamps
// every result file with the build that produced it (so runs can never be
// confused), and it guarantees the rebuild actually emits different code —
// swiftc is deterministic and `codesign --timestamp=none` adds no entropy, so
// an unchanged source rebuilds to an identical CDHash and would make the whole
// experiment vacuous: TCC would be re-checking code it had already approved.
let PROBE_BUILD = 3

func writeResult(_ o: [String: Any]) {
    var out = o
    out["probeBuild"] = PROBE_BUILD
    out["bundleId"] = Bundle.main.bundleIdentifier ?? "none"
    out["bundlePath"] = Bundle.main.bundlePath
    if let d = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
        try? d.write(to: outURL)
    }
}

// Hard watchdog. PHASE-0 measured SCShareableContent failing in ~10 ms and never
// hanging, but this runs on the user's machine — it will not be the thing that
// sits there forever.
DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
    writeResult(["verdict": "timeout", "granted": false])
    exit(3)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

DispatchQueue.main.async {
    let preflight = CGPreflightScreenCaptureAccess()
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, err in
        let n = content?.displays.count ?? 0
        var o: [String: Any] = [
            "verdict": n > 0 ? "granted" : "denied",
            "granted": n > 0,
            "preflight": preflight,
            "displays": n,
        ]
        if let err { o["error"] = String(describing: err) }
        writeResult(o)
        exit(0)
    }
}
app.run()
