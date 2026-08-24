import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics
import CoreMedia

var tb = mach_timebase_info_data_t()
mach_timebase_info(&tb)
print("timebase numer=\(tb.numer) denom=\(tb.denom)")
print("mach_absolute_time=\(mach_absolute_time())")

// SCK API surface probe
let cfg = SCStreamConfiguration()
cfg.width = 3840
cfg.height = 2160
cfg.minimumFrameInterval = CMTime(value: 1, timescale: 60)
cfg.queueDepth = 6
cfg.showsCursor = false
print("SCStreamConfiguration OK w=\(cfg.width) h=\(cfg.height) qd=\(cfg.queueDepth)")

// captureResolution is macOS 14+; probe via KVC
if cfg.responds(to: NSSelectorFromString("setCaptureResolution:")) {
    cfg.setValue(3, forKey: "captureResolution")
    print("captureResolution settable via KVC -> \(cfg.value(forKey: "captureResolution") ?? "nil")")
} else {
    print("captureResolution NOT available on this runtime")
}

// AVFoundation probe
let vids = AVCaptureDevice.devices(for: .video)
print("video devices: \(vids.map { $0.localizedName })")
let auds = AVCaptureDevice.devices(for: .audio)
print("audio devices: \(auds.map { $0.localizedName })")

// CGEvent tap symbols
print("CGPreflightScreenCaptureAccess=\(CGPreflightScreenCaptureAccess())")
print("AXIsProcessTrusted=\(AXIsProcessTrusted())")
