import Foundation
import AVFoundation
import CoreGraphics
import AppKit

/// "The world changed mid-recording" — three of phase 1's four named risks are this.
/// Every change is surfaced as an event rather than being allowed to silently corrupt a take.
final class Watchers {
    static let shared = Watchers()
    /// Set by the recorder so it can rebuild its stream when the display config moves.
    var onDisplayChange: ((CGDirectDisplayID, [String]) -> Void)?
    var onDeviceChange: ((String, String, String) -> Void)?   // (action, uniqueID, name)

    private var started = false

    func start() {
        guard !started else { return }
        started = true
        CGDisplayRegisterReconfigurationCallback(displayCallback, nil)

        let nc = NotificationCenter.default
        nc.addObserver(forName: .AVCaptureDeviceWasDisconnected, object: nil, queue: .main) { [weak self] n in
            guard let d = n.object as? AVCaptureDevice else { return }
            IO.send("warning", ["code": "device-disconnected", "device": d.localizedName, "uid": d.uniqueID])
            self?.onDeviceChange?("disconnected", d.uniqueID, d.localizedName)
        }
        nc.addObserver(forName: .AVCaptureDeviceWasConnected, object: nil, queue: .main) { [weak self] n in
            guard let d = n.object as? AVCaptureDevice else { return }
            IO.send("info", ["code": "device-connected", "device": d.localizedName, "uid": d.uniqueID])
            self?.onDeviceChange?("connected", d.uniqueID, d.localizedName)
        }
        nc.addObserver(forName: .AVCaptureSessionRuntimeError, object: nil, queue: .main) { n in
            let e = n.userInfo?[AVCaptureSessionErrorKey] as? NSError
            IO.send("warning", ["code": "av-runtime-error", "detail": e?.localizedDescription ?? "unknown"])
        }
        // NB: AVCaptureSessionWasInterrupted / ...InterruptionReasonKey are iOS-only.
        // On macOS, runtime errors above are the equivalent signal.
        IO.log("watchers armed (display reconfiguration + AV device notifications)")
    }

    fileprivate func handleDisplayChange(_ id: CGDirectDisplayID, _ flags: CGDisplayChangeSummaryFlags) {
        // beginConfiguration fires before the change lands; the useful callback is the one after.
        if flags.contains(.beginConfigurationFlag) { return }
        var names: [String] = []
        func f(_ v: CGDisplayChangeSummaryFlags, _ n: String) { if flags.contains(v) { names.append(n) } }
        f(.addFlag, "added"); f(.removeFlag, "removed")
        f(.enabledFlag, "enabled"); f(.disabledFlag, "disabled")
        f(.movedFlag, "moved"); f(.setModeFlag, "modeChanged")
        f(.desktopShapeChangedFlag, "desktopShapeChanged")
        f(.setMainFlag, "becameMain")
        if names.isEmpty { return }
        let b = CGDisplayBounds(id)
        IO.send("warning", ["code": "display-reconfigured", "display": id, "changes": names,
                            "bounds": ["x": b.origin.x, "y": b.origin.y, "w": b.size.width, "h": b.size.height]])
        onDisplayChange?(id, names)
    }

    /// CGDirectDisplayID -> the name System Settings shows for it.
    private static func displayNames() -> [CGDirectDisplayID: String] {
        var out: [CGDirectDisplayID: String] = [:]
        for screen in NSScreen.screens {
            if let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                out[CGDirectDisplayID(truncating: n)] = screen.localizedName
            }
        }
        return out
    }

    /// Enumerating AV devices can hang when CoreAudio is wedged (PHASE-0 §2a), so it runs
    /// off-main with a timeout and reports the stall instead of blocking the process.
    static func enumerateDevices(timeout: TimeInterval = 6, _ done: @escaping ([String: Any]) -> Void) {
        let sem = DispatchSemaphore(value: 0)
        var result: [String: Any] = [:]
        // AppKit's to give and read on the calling thread (main) before the
        // enumeration moves off it; NSScreen is not promised off-main.
        let names = displayNames()
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                let bt: Int32 = 0x626C7565   // 'blue'
                let cams = AVCaptureDevice.devices(for: .video).map {
                    ["name": $0.localizedName, "uid": $0.uniqueID] as [String: Any]
                }
                let mics = AVCaptureDevice.devices(for: .audio).map {
                    ["name": $0.localizedName, "uid": $0.uniqueID,
                     "bluetooth": $0.transportType == bt] as [String: Any]
                }
                var displays: [[String: Any]] = []
                var ids = [CGDirectDisplayID](repeating: 0, count: 16)
                var count: UInt32 = 0
                if CGGetActiveDisplayList(16, &ids, &count) == .success {
                    for i in 0..<Int(count) {
                        let id = ids[i]
                        let b = CGDisplayBounds(id)
                        let m = CGDisplayCopyDisplayMode(id)
                        // originX/Y are the display's place in the global point
                        // space CGEvent coordinates and anchors.display use
                        // (STC-247); a picker shows the name, a test checks
                        // anchors against the origin.
                        displays.append(["id": id, "main": CGDisplayIsMain(id) != 0,
                                         "name": names[id] ?? "Display \(id)",
                                         "pointW": b.size.width, "pointH": b.size.height,
                                         "pixelW": m?.pixelWidth ?? 0, "pixelH": m?.pixelHeight ?? 0,
                                         "originX": b.origin.x, "originY": b.origin.y])
                    }
                }
                result = ["cameras": cams, "mics": mics, "displays": displays]
            }
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            done(["stalled": true,
                  "detail": "AVCaptureDevice enumeration timed out — CoreAudio may be wedged. "
                          + "Disconnect the Bluetooth audio device, or `sudo killall coreaudiod`."])
        } else {
            done(result)
        }
    }
}

private func displayCallback(_ display: CGDirectDisplayID,
                             _ flags: CGDisplayChangeSummaryFlags,
                             _ userInfo: UnsafeMutableRawPointer?) {
    Watchers.shared.handleDisplayChange(display, flags)
}
