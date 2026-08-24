import Foundation

/// Line-delimited JSON over stdin/stdout. stderr is for human logs only.
/// Electron spawns this as a child, so the helper inherits Electron's TCC identity —
/// one grant, against the signed bundle the user recognises (PHASE-0 §6).
enum IO {
    private static let outLock = NSLock()

    static func emit(_ event: String, _ fields: [String: Any] = [:]) {
        var o: [String: Any] = fields
        o["ev"] = event
        o["t"] = Clock.nowNs()
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
              var s = String(data: d, encoding: .utf8) else { return }
        s += "\n"
        outLock.lock(); defer { outLock.unlock() }
        FileHandle.standardOutput.write(s.data(using: .utf8)!)
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
                    emit("error", ["code": "bad-json", "detail": trimmed.prefix(200).description])
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
