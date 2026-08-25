import Foundation

/// Two channels, deliberately different (PHASE-0 §3, PHASE-1 "Settled by phase 0"):
///
///   fd3    reliable  — command responses (seq echoed) and lifecycle events.
///                      Blocking, ordered, never dropped.
///   stdout lossy     — telemetry only. Bounded drop-oldest ring drained by a
///                      dedicated writer thread over a non-blocking fd, so a
///                      stalled consumer can never back-pressure the producer.
///
/// stderr stays human logs. Electron spawns this as a child, so the helper
/// inherits Electron's TCC identity — one grant, against the signed bundle the
/// user recognises (PHASE-0 §6).
///
/// When fd3 is absent (a bare terminal run, e.g. the documented smoke test)
/// both kinds fall back to blocking stdout: the split exists to protect the
/// capture graph, and there is no capture graph in a pipe-to-terminal run.
/// They must not *share* fd 1 in split mode — the lossy writer's partial
/// non-blocking writes would interleave with reliable lines and corrupt both.

/// Bounded, drop-oldest ring feeding a dedicated writer thread.
final class LossyChannel {
    private let fd: Int32
    /// Semantics live in Ring.swift so they can be tested without a pipe.
    private var ring: DropOldestRing
    private let cond = NSCondition()

    init(fd: Int32, capacity: Int = 256) {
        self.fd = fd
        self.ring = DropOldestRing(capacity: capacity)
        let flags = fcntl(fd, F_GETFL, 0)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        let t = Thread { [weak self] in self?.writeLoop() }
        t.name = "lossy-writer"
        t.start()
    }

    /// Safe from a capture callback: no syscall, no pipe wait. The only possible
    /// wait is another producer's memcpy, which is never held across I/O.
    func offer(_ line: Data) {
        cond.lock()
        ring.offer(line)
        cond.signal()
        cond.unlock()
    }

    private func writeLoop() {
        while true {
            cond.lock()
            while ring.count == 0 { cond.wait() }
            let item = ring.take()!
            let drops = ring.takeDropCount()
            cond.unlock()

            // Loss is reported, never silent — a gap in telemetry that the
            // consumer cannot see is indistinguishable from a stalled capture.
            if drops > 0 { writeAll(IO.encode("stats-dropped", seq: nil, ["n": drops])) }
            writeAll(item)
        }
    }

    /// Blocks this thread only. While it waits, `offer` keeps dropping oldest.
    private func writeAll(_ data: Data) {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var off = 0
            while off < data.count {
                let n = write(fd, base + off, data.count - off)
                if n > 0 { off += n; continue }
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK {
                    var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    _ = poll(&p, 1, 100)
                    continue
                }
                return   // EPIPE and friends: consumer is gone for good
            }
        }
    }
}

enum IO {
    private static let reliableLock = NSLock()
    private static var reliableFd: Int32 = 1
    private static var lossy: LossyChannel?

    /// Must run before anything is emitted.
    static func boot() {
        let hasFd3 = fcntl(3, F_GETFD) != -1
        reliableFd = hasFd3 ? 3 : 1
        lossy = hasFd3 ? LossyChannel(fd: 1) : nil
    }

    static func encode(_ event: String, seq: Int?, _ fields: [String: Any]) -> Data {
        var o = fields
        o["ev"] = event
        o["t"] = Clock.nowNs()
        if let seq { o["seq"] = seq }
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
        else { return Data() }
        return d + Data("\n".utf8)
    }

    /// Reliable: responses and lifecycle. `seq` echoes the request it answers.
    static func send(_ event: String, seq: Int? = nil, _ fields: [String: Any] = [:]) {
        writeReliable(encode(event, seq: seq, fields))
    }

    /// Lossy: telemetry only. Never blocks on the pipe.
    static func stat(_ event: String, _ fields: [String: Any] = [:]) {
        let d = encode(event, seq: nil, fields)
        if let lossy { lossy.offer(d) } else { writeReliable(d) }
    }

    private static func writeReliable(_ data: Data) {
        guard !data.isEmpty else { return }
        reliableLock.lock(); defer { reliableLock.unlock() }
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            var off = 0
            while off < data.count {
                let n = write(reliableFd, base + off, data.count - off)
                if n > 0 { off += n; continue }
                if errno == EINTR { continue }
                return
            }
        }
    }

    static func log(_ s: String) {
        FileHandle.standardError.write("[helper] \(s)\n".data(using: .utf8)!)
    }

    /// Reads commands on a dedicated thread; each parsed command is handed to `onCommand` on the main queue.
    static func readCommands(_ onCommand: @escaping ([String: Any]) -> Void) {
        let t = Thread {
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                guard let d = trimmed.data(using: .utf8),
                      let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
                    // Unparseable, so there is no seq to correlate against.
                    send("error", seq: nil, ["code": "bad-json", "detail": trimmed.prefix(200).description])
                    continue
                }
                DispatchQueue.main.async { onCommand(o) }
            }
            // stdin closed — parent died. Shut down cleanly so devices are released.
            DispatchQueue.main.async { App.shared.shutdown(reason: "stdin-closed", exitCode: 0) }
        }
        t.name = "stdin"
        t.start()
    }
}

/// The one clock. PHASE-0 §1: mach ticks are 41.667 ns here, not 1 ns.
enum Clock {
    static let timebase: mach_timebase_info_data_t = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb
    }()
    @inline(__always) static func toNs(_ ticks: UInt64) -> UInt64 {
        ticks &* UInt64(timebase.numer) / UInt64(timebase.denom)
    }
    @inline(__always) static func nowNs() -> UInt64 { toNs(mach_absolute_time()) }
    static var describe: [String: Any] {
        ["numer": timebase.numer, "denom": timebase.denom,
         "nsPerTick": Double(timebase.numer) / Double(timebase.denom)]
    }
}
