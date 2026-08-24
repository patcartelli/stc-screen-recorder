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
    /// Stats run off the main queue on purpose: telemetry must never compete with
    /// the control plane for the queue that dispatches commands.
    private let statsQueue = DispatchQueue(label: "stc.stats")
    private var sigSources: [DispatchSourceSignal] = []

    func boot() {
        installSignalHandlers()
        Watchers.shared.start()
        Watchers.shared.onDisplayChange = { [weak self] _, changes in
            guard let self = self, self.state == .recording else { return }
            // Increment 2 rebuilds the stream here. For now the change is at least never silent.
            IO.send("warning", ["code": "display-change-during-recording",
                                "changes": changes,
                                "detail": "stream rebuild not yet implemented (increment 2)"])
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
        do { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
        catch { IO.send("error", seq: seq, ["code": "mkdir-failed", "detail": "\(error)"]); return }

        state = .starting
        sessionDir = url
        startedAtNs = Clock.nowNs()
        state = .recording
        IO.send("started", seq: seq, ["dir": url.path, "t0Ns": startedAtNs])
        startStatsTimer(intervalMs: cmd["statsIntervalMs"] as? Int ?? 2000, since: startedAtNs)
    }

    private func stop(seq: Int? = nil) {
        guard state == .recording else {
            IO.send("error", seq: seq, ["code": "bad-state", "detail": "not recording"]); return
        }
        state = .stopping
        statsTimer?.cancel(); statsTimer = nil
        let elapsed = (Clock.nowNs() - startedAtNs) / 1_000_000
        IO.send("stopped", seq: seq, ["dir": sessionDir?.path as Any, "elapsedMs": elapsed])
        sessionDir = nil
        state = .idle
    }

    /// Periodic stats make thermal throttling observable rather than inferred.
    /// Phase 0 saw 6K H.264 fade from 18.7 to 12.1 fps across a longer benchmark.
    private func startStatsTimer(intervalMs: Int, since t0: UInt64) {
        let ms = max(1, intervalMs)
        let t = DispatchSource.makeTimerSource(queue: statsQueue)
        t.schedule(deadline: .now() + .milliseconds(ms), repeating: .milliseconds(ms))
        // t0 captured by value: the handler must not touch main-queue state.
        t.setEventHandler {
            IO.stat("stats", ["elapsedMs": (Clock.nowNs() - t0) / 1_000_000,
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

    func shutdown(reason: String, exitCode: Int32, seq: Int? = nil) {
        IO.log("shutdown: \(reason)")
        if state == .recording { stop() }
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
