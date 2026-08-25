// Ring semantics, tested directly. These used to be verified only by stalling a
// real pipe until the OS buffer overflowed — which depends on the KERNEL's pipe
// size, took minutes, and timed out on CI. None of that is needed to check that
// a fixed-size queue drops its oldest entry.
import Foundation

var failures = 0
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) { print("ok   \(label)") }
    else { print("FAIL \(label): got \(got), want \(want)"); failures += 1 }
}
func d(_ s: String) -> Data { Data(s.utf8) }
func str(_ x: Data?) -> String { x.map { String(decoding: $0, as: UTF8.self) } ?? "nil" }

var r = DropOldestRing(capacity: 3)
check("starts empty", r.count, 0)
check("nothing to take", str(r.take()), "nil")
check("no drops yet", r.dropped, UInt64(0))

r.offer(d("a")); r.offer(d("b"))
check("counts what it holds", r.count, 2)
check("FIFO: oldest first", str(r.take()), "a")
check("then the next", str(r.take()), "b")
check("empty again", r.count, 0)

// The property the capture path depends on: a full ring discards the OLDEST
// entry so the newest telemetry always survives. Losing the newest would make
// the channel useless precisely when things are going wrong.
r = DropOldestRing(capacity: 3)
for s in ["1", "2", "3", "4", "5"] { r.offer(d(s)) }
check("never exceeds capacity", r.count, 3)
check("dropped the two oldest", r.dropped, UInt64(2))
check("keeps the newest", str(r.take()), "3")
check("in order", str(r.take()), "4")
check("to the end", str(r.take()), "5")

// Drop count is read-and-reset: the writer reports each gap exactly once.
r = DropOldestRing(capacity: 2)
for s in ["a", "b", "c", "d"] { r.offer(d(s)) }
check("two dropped", r.takeDropCount(), UInt64(2))
check("reading resets, so a gap is reported once", r.takeDropCount(), UInt64(0))
// The ring is still FULL after those reads — reading the counter does not free
// slots — so both of these displace an entry.
r.offer(d("e")); r.offer(d("f"))
check("counts again after reset", r.takeDropCount(), UInt64(2))

// Wraparound: head and tail must chase each other around the buffer without
// corrupting order — an off-by-one here silently reorders telemetry. Take after
// every offer so the ring never fills, isolating wraparound from dropping.
r = DropOldestRing(capacity: 3)
var out: [String] = []
for i in 1...10 {
    r.offer(d("\(i)"))
    if let taken = r.take() { out.append(str(taken)) }
}
check("wraps around without reordering", out, ["1","2","3","4","5","6","7","8","9","10"])
check("no drops when the consumer keeps up", r.dropped, UInt64(0))

r = DropOldestRing(capacity: 1)
r.offer(d("x")); r.offer(d("y"))
check("capacity 1 holds only the newest", str(r.take()), "y")
check("capacity 1 counted the drop", r.dropped, UInt64(1))

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
