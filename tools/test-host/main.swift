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
    FileHandle.standardError.write("usage: --out <result.json> [--probe | --camera-request | --camera-probe --helper <bin> | --cursor-probe --helper <bin> [--ms <n>] [--on-main] | --helper <bin> --dir <sessionDir> --ms <n> [--camera]]\n".data(using: .utf8)!)
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

// MARK: - camera-request mode

/// Calls AVCaptureDevice.requestAccess(for: .video) exactly once. This is the
/// ONLY way to make this bundle appear in System Settings > Privacy & Security
/// > Camera: that pane lists only apps that have already requested access, and
/// nothing else in this repo ever calls requestAccess — camera-probe and the
/// helper deliberately only READ authorizationStatus (see runProbe above and
/// helper's own probe), which never prompts and never registers the bundle.
/// requestAccess raises the system prompt but does NOT open the device or
/// light the camera LED, so running this mode does not itself constitute
/// "using the camera" — it only asks for permission to, later, elsewhere.
func runCameraRequest() {
    AVCaptureDevice.requestAccess(for: .video) { granted in
        writeResult(["verdict": granted ? "granted" : "denied", "granted": granted])
        exit(0)
    }
}

// MARK: - session mode

/// Drives the helper through start -> record -> stop and records everything it
/// said. Assertions live in the test suite, not here: this writes a transcript,
/// it does not decide whether the transcript is good.
func runSession(helper: String, dir: String, recordMs: Int, camera: Bool) {
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

    var startCmd: [String: Any] = ["cmd": "start", "dir": dir, "seq": 1]
    if camera { startCmd["camera"] = true }
    send(startCmd)
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

// MARK: - camera-probe mode

/// Launches the helper as a child of THIS bundle and asks it what camera
/// authorization it sees. The answer is the whole point: a bare CLI binary
/// inherits the launching bundle's TCC identity, and that is what ships.
/// Reuses runSession's pipe-reading pattern (readabilityHandler + line buffer)
/// rather than inventing a new one.
func runCameraProbe(helper: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: helper)
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
    func waitFor(_ test: @escaping ([String: Any]) -> Bool, timeout: Double) -> [String: Any]? {
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

    guard waitFor({ $0["ev"] as? String == "ready" }, timeout: 10) != nil else {
        writeResult(["helperAuth": "no-ready", "helperDevices": [String]()])
        p.terminate(); exit(5)
    }

    send(["cmd": "camera-probe", "seq": 1])
    // Match on seq alone, like runSession does — an error reply (or any other
    // unsolicited event) still answers seq 1 and must not be discarded. Matching
    // on ev == "camera-probe" too would make a real reply indistinguishable from
    // no reply at all, collapsing both into "timeout": the exact diagnostic
    // collapse STC-254 warns about ("a diagnostic that lies is worse than one
    // that admits ignorance").
    guard let reply = waitFor({ ($0["seq"] as? Int) == 1 }, timeout: 10) else {
        writeResult(["helperAuth": "timeout", "helperDevices": [String]()])
        p.terminate(); exit(1)
    }

    guard reply["ev"] as? String == "camera-probe" else {
        // The helper answered, just not with what we asked for. Name what it
        // actually said rather than reporting "timeout" for a live reply.
        let ev = reply["ev"] as? String ?? "missing"
        var o: [String: Any] = ["helperAuth": "unexpected-reply:\(ev)", "helperDevices": [String]()]
        if let code = reply["code"] { o["helperReplyCode"] = code }
        if let detail = reply["detail"] { o["helperReplyDetail"] = detail }
        writeResult(o)
        p.terminate(); exit(1)
    }

    writeResult(["helperAuth": reply["auth"] as? String ?? "missing",
                 "helperDevices": reply["devices"] as? [String] ?? []])
    p.terminate()
    exit(0)
}

// MARK: - cursor-probe mode (STC-309 increment 0)

/// Launches the helper as a child of THIS bundle and runs its `cursor-probe`
/// command: the spike that answers whether `NSCursor.currentSystem` sees other
/// apps' pointers from a background process, under the TCC identity that
/// ships. The helper does the sampling with its production code; this only
/// asks and records. Hover a text field, a link, the desktop, a window edge
/// and a Finder drag while it runs — the reply lists every signature change.
///
/// A third copy of runSession's pipe reader would be the "one thing, two
/// copies" trap this repo keeps paying for, so the reader is a class here;
/// the two older modes are left as they were, verified on hardware.
final class HelperChild {
    private let p = Process()
    private let inPipe = Pipe(), outPipe = Pipe()
    private let lock = NSLock()
    private var lines: [[String: Any]] = []
    private var buf = Data()

    init(helper: String) {
        p.executableURL = URL(fileURLWithPath: helper)
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        outPipe.fileHandleForReading.readabilityHandler = { [self] fh in
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
    }
    func run() throws { try p.run() }
    func terminate() { p.terminate() }
    var transcript: [[String: Any]] { lock.lock(); defer { lock.unlock() }; return lines }
    func waitFor(_ test: @escaping ([String: Any]) -> Bool, timeout: Double) -> [String: Any]? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            lock.lock()
            let m = lines.first(where: test)
            lock.unlock()
            if let m { return m }
            usleep(20_000)
        }
        return nil
    }
    func send(_ o: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: o) else { return }
        inPipe.fileHandleForWriting.write(d + Data("\n".utf8))
    }
}

func runCursorProbe(helper: String, ms: Int, onMain: Bool) {
    let child = HelperChild(helper: helper)
    do { try child.run() } catch {
        writeResult(["verdict": "spawn-failed", "error": "\(error)"]); exit(4)
    }
    guard child.waitFor({ $0["ev"] as? String == "ready" }, timeout: 10) != nil else {
        writeResult(["verdict": "no-ready"]); child.terminate(); exit(5)
    }
    child.send(["cmd": "cursor-probe", "seq": 1, "ms": ms, "onMain": onMain])
    // seq alone, as camera-probe does: an error reply still answers seq 1.
    guard let reply = child.waitFor({ ($0["seq"] as? Int) == 1 }, timeout: Double(ms) / 1000 + 15) else {
        writeResult(["verdict": "timeout", "transcript": child.transcript])
        child.terminate(); exit(1)
    }
    child.send(["cmd": "quit", "seq": 2])
    _ = child.waitFor({ $0["ev"] as? String == "bye" }, timeout: 5)
    child.terminate()
    let ev = reply["ev"] as? String ?? "missing"
    let ok = ev == "cursor-probe"
    writeResult(["verdict": ok ? "probed" : "unexpected-reply:\(ev)",
                 "probe": reply, "transcript": child.transcript])
    exit(ok ? 0 : 1)
}

DispatchQueue.main.async {
    if args.contains("--probe") { runProbe(); return }
    if args.contains("--cursor-probe") {
        guard let helper = arg("--helper") else {
            writeResult(["verdict": "bad-args", "detail": "--cursor-probe needs --helper <bin>"])
            exit(2)
        }
        DispatchQueue.global().async {
            runCursorProbe(helper: helper, ms: Int(arg("--ms") ?? "20000") ?? 20000,
                           onMain: args.contains("--on-main"))
        }
        return
    }
    if args.contains("--camera-request") { runCameraRequest(); return }
    if args.contains("--camera-probe") {
        guard let helper = arg("--helper") else {
            writeResult(["verdict": "bad-args", "detail": "--camera-probe needs --helper <bin>"])
            exit(2)
        }
        DispatchQueue.global().async { runCameraProbe(helper: helper) }
        return
    }
    guard let helper = arg("--helper"), let dir = arg("--dir") else {
        writeResult(["verdict": "bad-args", "detail": "session mode needs --helper and --dir"])
        exit(2)
    }
    DispatchQueue.global().async {
        runSession(helper: helper, dir: dir, recordMs: Int(arg("--ms") ?? "3000") ?? 3000,
                   camera: args.contains("--camera"))
    }
}
app.run()
