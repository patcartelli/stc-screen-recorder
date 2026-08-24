import Foundation
import AppKit

/// Long-running capture helper. Controlled over stdin; reports over stdout.
/// Increment 1: control plane, watchers, lifecycle. Capture lands in increment 2.
final class App {
    static let shared = App()
    enum State: String { case idle, starting, recording, stopping }
    private(set) var state: State = .idle
    private var sessionDir: URL?
    private var startedAtNs: UInt64 = 0
    private var statsTimer: DispatchSourceTimer?
    private var sigSources: [DispatchSourceSignal] = []

    func boot() {
        installSignalHandlers()
        Watchers.shared.start()
        Watchers.shared.onDisplayChange = { [weak self] _, changes in
            guard let self = self, self.state == .recording else { return }
            // Increment 2 rebuilds the stream here. For now the change is at least never silent.
            IO.emit("warning", ["code": "display-change-during-recording",
                                "changes": changes,
                                "detail": "stream rebuild not yet implemented (increment 2)"])
        }
        IO.emit("ready", ["pid": ProcessInfo.processInfo.processIdentifier,
                          "timebase": Clock.describe,
                          "protocol": 1])
        IO.readCommands { [weak self] cmd in self?.handle(cmd) }
    }

    private func handle(_ cmd: [String: Any]) {
        switch cmd["cmd"] as? String ?? "" {
        case "status":
            IO.emit("status", ["state": state.rawValue,
                               "session": sessionDir?.path as Any,
                               "elapsedMs": state == .recording ? (Clock.nowNs() - startedAtNs) / 1_000_000 : 0])
        case "devices":
            Watchers.enumerateDevices { IO.emit("devices", $0) }
        case "start":
            start(cmd)
        case "stop":
            stop()
        case "quit":
            shutdown(reason: "quit", exitCode: 0)
        case let other:
            IO.emit("error", ["code": "unknown-command", "cmd": other])
        }
    }

    private func start(_ cmd: [String: Any]) {
        guard state == .idle else {
            IO.emit("error", ["code": "bad-state", "detail": "cannot start while \(state.rawValue)"]); return
        }
        guard let dir = cmd["dir"] as? String, !dir.isEmpty else {
            IO.emit("error", ["code": "missing-dir", "detail": "start requires \"dir\""]); return
        }
        let url = URL(fileURLWithPath: dir)
        do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
        catch { IO.emit("error", ["code": "mkdir-failed", "detail": "\(error)"]); return }

        state = .starting
        sessionDir = url
        startedAtNs = Clock.nowNs()
        state = .recording
        IO.emit("started", ["dir": url.path, "t0Ns": startedAtNs])
        startStatsTimer()
    }

    private func stop() {
        guard state == .recording else {
            IO.emit("error", ["code": "bad-state", "detail": "not recording"]); return
        }
        state = .stopping
        statsTimer?.cancel(); statsTimer = nil
        let elapsed = (Clock.nowNs() - startedAtNs) / 1_000_000
        IO.emit("stopped", ["dir": sessionDir?.path as Any, "elapsedMs": elapsed])
        sessionDir = nil
        state = .idle
    }

    /// Periodic stats make thermal throttling observable rather than inferred.
    /// Phase 0 saw 6K H.264 fade from 18.7 to 12.1 fps across a longer benchmark.
    private func startStatsTimer() {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 2, repeating: 2)
        t.setEventHandler { [weak self] in
            guard let self = self, self.state == .recording else { return }
            IO.emit("stats", ["elapsedMs": (Clock.nowNs() - self.startedAtNs) / 1_000_000,
                              "frames": 0, "dropped": 0, "note": "capture lands in increment 2"])
        }
        t.resume()
        statsTimer = t
    }

    /// Phase 0 §2a: being killed while holding a capture device wedged CoreAudio system-wide.
    /// Background queue on purpose — these must fire even if the main thread is blocked.
    private func installSignalHandlers() {
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

    func shutdown(reason: String, exitCode: Int32) {
        IO.log("shutdown: \(reason)")
        if state == .recording { stop() }
        IO.emit("bye", ["reason": reason])
        exit(exitCode)
    }
}

setbuf(stdout, nil)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
App.shared.boot()
app.run()
