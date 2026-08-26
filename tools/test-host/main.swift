// Test host: a signed bundle that (a) probes Screen Recording state and
// (b) drives the helper through a scripted capture session.
//
// It exists because of PHASE-0 §6: exec'ing a bare binary makes it inherit the
// launching terminal's TCC identity, so a terminal-run helper measures the
// terminal's grants rather than its own. Spawning the helper from a signed
// bundle is both the only honest way to test capture AND the exact arrangement
// Electron will use in increment 3 — so this doubles as an early check on the
// TCC-inheritance assumption the whole architecture rests on.
//
// CFBundleIdentifier is LOAD-BEARING. The Screen Recording grant is keyed to
// `identifier "com.studiocartelli.stcsigningprobe" and certificate root = H"…"`,
// so renaming the identifier silently discards the grant and costs a manual
// re-approval. The stale-sounding name is deliberate; see build.sh.
import Foundation
import ScreenCaptureKit
import CoreGraphics
import AppKit
import AVFoundation
import IOKit.hid

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

guard let outPath = arg("--out") else {
    FileHandle.standardError.write("usage: --out <result.json> [--probe | --helper <bin> --dir <sessionDir> --ms <n>]\n".data(using: .utf8)!)
    exit(2)
}
let outURL = URL(fileURLWithPath: outPath)

func writeResult(_ o: [String: Any]) {
    var out = o
    out["bundleId"] = Bundle.main.bundleIdentifier ?? "none"
    if let d = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) {
        try? d.write(to: outURL)
    }
}

// Never sit there forever on someone's machine.
let watchdogSec = Double(arg("--timeout") ?? "") ?? 60
DispatchQueue.global().asyncAfter(deadline: .now() + watchdogSec) {
    writeResult(["verdict": "timeout", "granted": false])
    exit(3)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// MARK: - probe mode (unchanged: the signing experiment's measuring stick)

func runProbe() {
    let preflight = CGPreflightScreenCaptureAccess()
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, err in
        let n = content?.displays.count ?? 0
        // Input Monitoring is a SEPARATE grant from Screen Recording. Without it
        // CGEvent.tapCreate can still hand back a port that never delivers, so
        // an empty events.json looks identical to "nobody moved the mouse".
        let hidAccess = IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)
        let hidName = hidAccess == kIOHIDAccessTypeGranted ? "granted"
                    : hidAccess == kIOHIDAccessTypeDenied ? "denied" : "unknown"
        // Camera is a SEPARATE grant from Screen Recording and from Input
        // Monitoring. authorizationStatus does not prompt; it reports.
        let camAuth: String
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:    camAuth = "authorized"
        case .denied:        camAuth = "denied"
        case .restricted:    camAuth = "restricted"
        case .notDetermined: camAuth = "notDetermined"
        @unknown default:    camAuth = "unknown"
        }
        let cams = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
            mediaType: .video, position: .unspecified).devices.map { $0.localizedName }

        var o: [String: Any] = ["verdict": n > 0 ? "granted" : "denied", "granted": n > 0,
                                "preflight": preflight, "displays": n,
                                "inputMonitoring": hidName,
                                "cameraAuth": camAuth, "cameraDevices": cams]
        if let err { o["error"] = String(describing: err) }
        writeResult(o)
        exit(0)
    }
}

// MARK: - session mode

/// Drives the helper through start -> record -> stop and records everything it
/// said. Assertions live in the test suite, not here: this writes a transcript,
/// it does not decide whether the transcript is good.
func runSession(helper: String, dir: String, recordMs: Int) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: helper)
    // No fd3: Process cannot hand a child an arbitrary descriptor without
    // posix_spawn file actions, and the helper's documented fallback puts both
    // channels on stdout. The fd3 split is covered thoroughly by ipc.test.ts;
    // what this mode needs to prove is that capture works under an inherited
    // TCC identity.
    p.arguments = ["--stats-interval-ms", "500"]
    let inPipe = Pipe(), outPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = outPipe
    p.standardError = FileHandle.nullDevice

    let lock = NSLock()
    var lines: [[String: Any]] = []
    var buf = Data()

    outPipe.fileHandleForReading.readabilityHandler = { fh in
        let d = fh.availableData
        if d.isEmpty { return }
        lock.lock()
        buf.append(d)
        while let nl = buf.firstIndex(of: 0x0A) {
            let lineData = buf[buf.startIndex..<nl]
            buf = buf[buf.index(after: nl)...]
            if let o = try? JSONSerialization.jsonObject(with: Data(lineData)) as? [String: Any] {
                lines.append(o)
            }
        }
        lock.unlock()
    }

    func seen(_ test: ([String: Any]) -> Bool) -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        return lines.first(where: test)
    }
    func waitFor(_ label: String, _ test: @escaping ([String: Any]) -> Bool, timeout: Double = 20) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let m = seen(test) { return m }
            usleep(20_000)
        }
        return nil
    }
    func send(_ o: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: o) else { return }
        inPipe.fileHandleForWriting.write(d + Data("\n".utf8))
    }

    do { try p.run() } catch {
        writeResult(["verdict": "spawn-failed", "error": "\(error)"]); exit(4)
    }

    guard waitFor("ready", { $0["ev"] as? String == "ready" }) != nil else {
        writeResult(["verdict": "no-ready"]); p.terminate(); exit(5)
    }

    send(["cmd": "start", "dir": dir, "seq": 1])
    let startOutcome = waitFor("start", { ($0["seq"] as? Int) == 1 }, timeout: 30)

    if startOutcome?["ev"] as? String == "started" {
        usleep(useconds_t(recordMs * 1000))
        send(["cmd": "stop", "seq": 2])
        _ = waitFor("stop", { ($0["seq"] as? Int) == 2 }, timeout: 30)
    }

    send(["cmd": "quit", "seq": 3])
    _ = waitFor("bye", { $0["ev"] as? String == "bye" }, timeout: 5)
    p.terminate()

    lock.lock()
    let transcript = lines
    lock.unlock()
    writeResult([
        "verdict": startOutcome?["ev"] as? String == "started" ? "recorded" : "start-failed",
        "startOutcome": startOutcome ?? [:],
        "transcript": transcript,
        "dir": dir,
    ])
    exit(0)
}

DispatchQueue.main.async {
    if args.contains("--probe") { runProbe(); return }
    guard let helper = arg("--helper"), let dir = arg("--dir") else {
        writeResult(["verdict": "bad-args", "detail": "session mode needs --helper and --dir"])
        exit(2)
    }
    DispatchQueue.global().async {
        runSession(helper: helper, dir: dir, recordMs: Int(arg("--ms") ?? "3000") ?? 3000)
    }
}
app.run()
