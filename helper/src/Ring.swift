import Foundation

/// Fixed-size queue that discards its OLDEST entry when full.
///
/// This is the mechanism that keeps stats from ever back-pressuring the capture
/// graph: a producer in a capture callback must never wait on a pipe, so when
/// the consumer falls behind, telemetry is dropped rather than the recording
/// being stalled (PHASE-0 §3, PHASE-1 "Settled by phase 0").
///
/// Oldest-first is the important half. Dropping the NEWEST entry would keep a
/// stale snapshot and discard exactly the information that matters when the
/// machine is struggling — the moment telemetry is most needed.
///
/// Extracted from LossyChannel so it can be tested without a pipe. It was
/// previously only exercised by stalling a real consumer until the OS buffer
/// overflowed, which depends on the kernel's pipe size, takes minutes, and
/// timed out on CI.
struct DropOldestRing {
    let capacity: Int
    private var slots: [Data?]
    private var head = 0
    private var tail = 0
    private(set) var count = 0
    private(set) var dropped: UInt64 = 0

    init(capacity: Int) {
        precondition(capacity > 0, "a ring needs at least one slot")
        self.capacity = capacity
        self.slots = Array(repeating: nil, count: capacity)
    }

    /// Never fails and never blocks. Full means the oldest entry is discarded.
    mutating func offer(_ item: Data) {
        if count == capacity {
            slots[tail] = nil
            tail = (tail + 1) % capacity
            count -= 1
            dropped &+= 1
        }
        slots[head] = item
        head = (head + 1) % capacity
        count += 1
    }

    mutating func take() -> Data? {
        guard count > 0 else { return nil }
        let item = slots[tail]
        slots[tail] = nil
        tail = (tail + 1) % capacity
        count -= 1
        return item
    }

    /// Reads and resets, so each gap in the stream is reported exactly once.
    mutating func takeDropCount() -> UInt64 {
        defer { dropped = 0 }
        return dropped
    }
}
