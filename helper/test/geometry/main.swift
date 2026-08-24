// Pure-function tests for capture geometry, compiled together with the
// production source. No XCTest here: there is no Xcode and SwiftPM cannot
// resolve, so the "framework" is assertions + a non-zero exit code.
import Foundation

var failures = 0

func check(_ label: String, _ got: (w: Int, h: Int), _ want: (w: Int, h: Int)) {
    if got == want {
        print("ok   \(label): \(got.w)x\(got.h)")
    } else {
        print("FAIL \(label): got \(got.w)x\(got.h), want \(want.w)x\(want.h)")
        failures += 1
    }
}

// The case that forced the cap to exist: this machine's own built-in display.
check("6016x3384 built-in caps to 4K", captureSize(6016, 3384), (3840, 2160))
check("5120x2880 5K caps to 4K",       captureSize(5120, 2880), (3840, 2160))
check("3840x2160 exactly at cap",      captureSize(3840, 2160), (3840, 2160))
check("2560x1440 under cap",           captureSize(2560, 1440), (2560, 1440))
check("5120x2160 ultrawide, width-bound", captureSize(5120, 2160), (3840, 1620))
check("2160x3840 portrait, height-bound", captureSize(2160, 3840), (1214, 2160))
check("odd dimensions floor to even",  captureSize(1919, 1081), (1918, 1080))

// Invariants that must hold for any display, including ones nobody anticipated.
for (w, h) in [(6016, 3384), (5120, 2160), (2160, 3840), (1919, 1081), (801, 601),
               (7680, 4320), (1280, 800), (3841, 2161), (2, 2)] {
    let s = captureSize(w, h)
    if s.w % 2 != 0 || s.h % 2 != 0 {
        print("FAIL \(w)x\(h): odd output \(s.w)x\(s.h) — H.264 4:2:0 needs even dimensions")
        failures += 1
    }
    if s.w > 3840 || s.h > 2160 {
        print("FAIL \(w)x\(h): \(s.w)x\(s.h) exceeds the hardware-encode cliff")
        failures += 1
    }
    if s.w < 2 || s.h < 2 {
        print("FAIL \(w)x\(h): degenerate output \(s.w)x\(s.h)")
        failures += 1
    }
    // aspect ratio preserved within a pixel of rounding slack
    let srcAR = Double(w) / Double(h), outAR = Double(s.w) / Double(s.h)
    if abs(srcAR - outAR) / srcAR > 0.01 {
        print("FAIL \(w)x\(h): aspect drifted \(srcAR) -> \(outAR)")
        failures += 1
    }
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
