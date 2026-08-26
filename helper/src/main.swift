import Foundation
import AppKit
import CoreGraphics
import AVFoundation

/// Long-running capture helper. Controlled over stdin; reports over stdout.
/// Increment 1: control plane, watchers, lifecycle. Capture lands in increment 2.
final class App {
    static let shared = App()
    enum State: String { case idle, starting, recording, stopping }
    private(set) var state: State = .idle
    private var sessionDir: URL?
    private var startedAtNs: UInt64 = 0
    private var statsTimer: DispatchSourceTimer?
    private var capture: CaptureSession?
    /// Stats run off the main queue on purpose: telemetry must never compete with
    /// the control plane for the queue that dispatches commands.
    private let statsQueue = DispatchQueue(label: "stc.stats")
    private var sigSources: [DispatchSourceSignal] = []

    func boot() {
        installSignalHandlers()
        startHeartbeat()
        Watchers.shared.start()
        Watchers.shared.onDisplayChange = { [weak self] _, changes in
            guard let self = self, self.state == .recording else { return }
            // Increment 2 rebuilds the stream here. For now the change is at least never silent.
            // AVAssetWriter cannot change output dimensions mid-file, so a
            // reconfiguration is a clean stop, not a rebuild (phase 2 concern).
            IO.send("warning", ["code": "display-change-during-recording",
                                "changes": changes,
                                "detail": "stopping cleanly — mid-stream rebuild is a phase 2 concern"])
            self.stop(reason: "display-reconfigured")
        }
        IO.send("ready", ["pid": ProcessInfo.processInfo.processIdentifier,
                          "timebase": Clock.describe,
                          "protocol": 1])
        IO.readCommands { [weak self] cmd in self?.handle(cmd) }
    }

    private func handle(_ cmd: [String: Any]) {
        let seq = cmd["seq"] as? Int
        switch cmd["cmd"] as? String ?? "" {
        case "status":
            IO.send("status", seq: seq,
                    ["state": state.rawValue,
                     "session": sessionDir?.path as Any,
                     "elapsedMs": state == .recording ? (Clock.nowNs() - startedAtNs) / 1_000_000 : 0])
        case "devices":
            Watchers.enumerateDevices { IO.send("devices", seq: seq, $0) }
        case "camera-probe":
            // Status only — never opens a device. Opening one here would light
            // the camera LED on every `npm test` run.
            let auth: String
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized:    auth = "authorized"
            case .denied:        auth = "denied"
            case .restricted:    auth = "restricted"
            case .notDetermined: auth = "notDetermined"
            @unknown default:    auth = "unknown"
            }
            let devices = AVCaptureDevice.DiscoverySession(
                deviceTypes: [.builtInWideAngleCamera, .externalUnknown],
                mediaType: .video, position: .unspecified).devices.map { $0.localizedName }
            IO.send("camera-probe", seq: seq, ["auth": auth, "devices": devices])
        case "start":
            start(cmd, seq: seq)
        case "stop":
            stop(seq: seq)
        case "quit":
            shutdown(reason: "quit", exitCode: 0, seq: seq)
        case let other:
            IO.send("error", seq: seq, ["code": "unknown-command", "cmd": other])
        }
    }

    private func start(_ cmd: [String: Any], seq: Int?) {
        guard state == .idle else {
            IO.send("error", seq: seq, ["code": "bad-state", "detail": "cannot start while \(state.rawValue)"]); return
        }
        guard let dir = cmd["dir"] as? String, !dir.isEmpty else {
            IO.send("error", seq: seq, ["code": "missing-dir", "detail": "start requires \"dir\""]); return
        }
        let url = URL(fileURLWithPath: dir)
        // Noted before creating: a session dir we made and never wrote to gets
        // cleaned up on failure, so a denied grant does not litter the user's
        // recordings folder with empty takes. A pre-existing dir is never touched.
        let dirExistedBefore = FileManager.default.fileExists(atPath: url.path)
        do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
        catch { IO.send("error", seq: seq, ["code": "mkdir-failed", "detail": "\(error)"]); return }

        state = .starting
        sessionDir = url
        startedAtNs = Clock.nowNs()

        let displayId = (cmd["displayId"] as? Int).map { CGDirectDisplayID($0) }
        let session = CaptureSession(dir: url, t0Ns: startedAtNs)
        capture = session
        session.start(displayId: displayId) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let info):
                    // A stop may have arrived while the async start was in flight.
                    guard self.state == .starting else { return }
                    self.state = .recording
                    var o: [String: Any] = ["dir": url.path, "t0Ns": self.startedAtNs]
                    o.merge(info) { a, _ in a }
                    IO.send("started", seq: seq, o)
                case .failure(let err):
                    let ce = err as? CaptureError
                    IO.send("error", seq: seq,
                            ["code": ce?.code ?? "start-failed",
                             "detail": ce.map { $0.description } ?? "\(err)"])
                    // A failed start still leaves the writer's zero-byte
                    // display.mp4 behind, so "is the directory empty?" is not
                    // the right question — "does it hold anything worth
                    // keeping?" is. Only ever removes a directory we created
                    // whose contents are all empty files.
                    if !dirExistedBefore, let fm = Optional(FileManager.default),
                       let entries = try? fm.contentsOfDirectory(atPath: url.path),
                       entries.allSatisfy({ name in
                           let attrs = try? fm.attributesOfItem(atPath: url.appendingPathComponent(name).path)
                           return (attrs?[.size] as? Int ?? 1) == 0
                       }) {
                        try? fm.removeItem(at: url)
                    }
                    // Leave the helper usable: a denied permission must not
                    // wedge the process, it must be retryable after granting.
                    self.capture = nil
                    self.sessionDir = nil
                    self.state = .idle
                }
            }
        }
    }

    private func stop(seq: Int? = nil, reason: String = "user") {
        guard state == .recording || state == .starting else {
            IO.send("error", seq: seq, ["code": "bad-state", "detail": "not recording"]); return
        }
        state = .stopping
        let dir = sessionDir?.path
        let elapsed = (Clock.nowNs() - startedAtNs) / 1_000_000

        guard let session = capture else {
            IO.send("stopped", seq: seq, ["dir": dir as Any, "elapsedMs": elapsed, "reason": reason])
            sessionDir = nil; state = .idle
            return
        }
        session.stop(reason: reason) { [weak self] stats in
            DispatchQueue.main.async {
                var o: [String: Any] = ["dir": dir as Any, "elapsedMs": elapsed, "reason": reason]
                o.merge(stats) { a, _ in a }
                IO.send("stopped", seq: seq, o)
                self?.capture = nil
                self?.sessionDir = nil
                self?.state = .idle
            }
        }
    }

    /// Periodic stats make thermal throttling observable rather than inferred.
    /// Phase 0 saw 6K H.264 fade from 18.7 to 12.1 fps across a longer benchmark.
    /// Liveness + capture telemetry, from boot until exit. Deliberately not
    /// gated on recording: a parent that only hears from the helper while
    /// recording cannot distinguish a healthy idle helper from a wedged one.
    ///
    /// Lossy on purpose — IO.stat never blocks, so a stalled consumer cannot
    /// back-pressure the capture graph. Never IO.send from anywhere near here.
    private func startHeartbeat() {
        let ms = max(1, Self.statsIntervalMs)
        let t = DispatchSource.makeTimerSource(queue: statsQueue)
        t.schedule(deadline: .now() + .milliseconds(ms), repeating: .milliseconds(ms))
        t.setEventHandler { [weak self] in
            guard let self else { return }
            var o: [String: Any] = ["state": self.state.rawValue]
            if self.state == .recording {
                o["elapsedMs"] = (Clock.nowNs() - self.startedAtNs) / 1_000_000
            }
            if let s = self.capture?.stats() { o.merge(s) { a, _ in a } }
            IO.stat("stats", o)
        }
        t.resume()
        statsTimer = t
    }

    /// `--stats-interval-ms N`, read once at launch. Electron sets it at spawn.
    static let statsIntervalMs: Int = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--stats-interval-ms"), i + 1 < a.count,
              let v = Int(a[i + 1]) else { return 2000 }
        return max(1, v)
    }()

    /// Phase 0 §2a: being killed while holding a capture device wedged CoreAudio system-wide.
    /// Background queue on purpose — these must fire even if the main thread is blocked.
    /// Leaves a trace when the process is killed by a fault rather than asked to
    /// stop. SIGSEGV/SIGBUS/SIGILL/SIGABRT do not go through the graceful path,
    /// so without this the parent sees only a signal number — which is exactly
    /// what three CI crashes produced (STC-254).
    ///
    /// Deliberately minimal: only async-signal-safe work. `write(2)` to fd 2 is
    /// safe; anything that allocates, locks, or formats is not, and a crash
    /// handler that crashes tells you even less than none.
    private func installCrashHandlers() {
        // SIGTRAP is here because it is how a Swift runtime trap and a CoreFoundation
        // assertion arrive, and both STC-254 crash reports were EXC_BREAKPOINT/SIGTRAP
        // rather than SIGSEGV. Without it the helper died mute for the variant that
        // actually reached CI, which is the blindness this handler exists to remove.
        for sig in [SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP] {
            signal(sig) { received in
                let name: StaticString
                // Every installed signal is named explicitly and the fallback says
                // it does not know. The previous `default: "SIGABRT"` would have
                // labelled any signal added above as SIGABRT — a diagnostic that
                // lies is worse than one that admits ignorance.
                switch received {
                case SIGSEGV: name = "SIGSEGV\n"
                case SIGBUS:  name = "SIGBUS\n"
                case SIGILL:  name = "SIGILL\n"
                case SIGFPE:  name = "SIGFPE\n"
                case SIGABRT: name = "SIGABRT\n"
                case SIGTRAP: name = "SIGTRAP\n"
                default:      name = "UNKNOWN\n"
                }
                let prefix: StaticString = "[helper] FATAL signal "
                prefix.withUTF8Buffer { _ = write(2, $0.baseAddress, $0.count) }
                name.withUTF8Buffer { _ = write(2, $0.baseAddress, $0.count) }
                // Restore the default and re-raise so the OS still writes a
                // crash report — the stack trace lives there, not here.
                signal(received, SIG_DFL)
                raise(received)
            }
        }
    }

    private func installSignalHandlers() {
        installCrashHandlers()
        for sig in [SIGINT, SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig,
                        queue: DispatchQueue.global(qos: .userInitiated))
            src.setEventHandler { [weak self] in
                self?.shutdown(reason: "signal-\(sig)", exitCode: 128 + sig)
            }
            src.resume()
            sigSources.append(src)
        }
    }

    func shutdown(reason: String, exitCode: Int32, seq: Int? = nil) {
        IO.log("shutdown: \(reason)")
        if state == .recording || state == .starting { stop(reason: reason) }
        IO.send("bye", seq: seq, ["reason": reason])
        exit(exitCode)
    }
}

setbuf(stdout, nil)
IO.boot()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
App.shared.boot()
app.run()
