// Synthetic 4K60 H.264 clip so gates 3+4 can be measured without any TCC grant.
import Foundation
import AVFoundation
import CoreGraphics
import CoreVideo
import AppKit

let W = 3840, H = 2160, FPS = 60, SECS = 12
let outDir = URL(fileURLWithPath: NSHomeDirectory() + "/dev/stc-screen-recorder/scratch/out-synth")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let url = outDir.appendingPathComponent("display.mp4")
try? FileManager.default.removeItem(at: url)

let w = try! AVAssetWriter(outputURL: url, fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 50_000_000,
        AVVideoMaxKeyFrameIntervalKey: 45,
        AVVideoExpectedSourceFrameRateKey: 60,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false
    ] as [String: Any]
]
let inp = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
inp.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H
])
w.add(inp); w.startWriting(); w.startSession(atSourceTime: .zero)

let cs = CGColorSpaceCreateDeviceRGB()
var seed: UInt64 = 12345
func rnd() -> Double { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Double((seed >> 33) & 0xFFFFFF) / Double(0xFFFFFF) }

let total = FPS * SECS
let sem = DispatchSemaphore(value: 0)
var frame = 0
let q = DispatchQueue(label: "gen")
let t0 = Date()

inp.requestMediaDataWhenReady(on: q) {
    while inp.isReadyForMoreMediaData {
        if frame >= total { inp.markAsFinished(); sem.signal(); return }
        var pbOut: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pbOut)
        guard let pb = pbOut else { frame += 1; continue }
        CVPixelBufferLockBaseAddress(pb, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: W, height: H,
                            bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
                            space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        let t = Double(frame) / Double(FPS)
        // moving gradient background
        let g = CGGradient(colorsSpace: cs, colors: [
            CGColor(red: 0.1 + 0.3*sin(t), green: 0.2, blue: 0.5, alpha: 1),
            CGColor(red: 0.6, green: 0.1, blue: 0.2 + 0.3*cos(t*1.3), alpha: 1)] as CFArray, locations: [0,1])!
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: 0), end: CGPoint(x: Double(W), y: Double(H)), options: [])
        // detail: many moving rects (keeps the encoder honest — a flat clip encodes unrealistically fast)
        seed = 12345
        for i in 0..<420 {
            let ph = Double(i) * 0.37 + t * (1.0 + rnd())
            let x = (rnd() * Double(W) + sin(ph) * 300).truncatingRemainder(dividingBy: Double(W))
            let y = (rnd() * Double(H) + cos(ph * 1.7) * 240).truncatingRemainder(dividingBy: Double(H))
            ctx.setFillColor(red: rnd(), green: rnd(), blue: rnd(), alpha: 0.85)
            ctx.fill(CGRect(x: x, y: y, width: 40 + rnd()*160, height: 20 + rnd()*90))
        }
        // high-frequency noise patch — worst case for the encoder
        for _ in 0..<3000 {
            ctx.setFillColor(red: rnd(), green: rnd(), blue: rnd(), alpha: 1)
            ctx.fill(CGRect(x: rnd()*Double(W), y: rnd()*Double(H), width: 6, height: 6))
        }
        // frame counter bar so frame identity is visually checkable
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: Double(H) - 60, width: Double(W) * Double(frame) / Double(total), height: 60))
        CVPixelBufferUnlockBaseAddress(pb, [])
        adaptor.append(pb, withPresentationTime: CMTime(value: Int64(frame) * 1000, timescale: 60000))
        frame += 1
        if frame % 120 == 0 { FileHandle.standardError.write("gen \(frame)/\(total)\n".data(using: .utf8)!) }
    }
}
sem.wait()
let f = DispatchSemaphore(value: 0)
w.finishWriting { f.signal() }
f.wait()
let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
print("wrote \(url.path)  \(frame) frames  \((size ?? 0)/1048576) MB  status=\(w.status.rawValue) err=\(String(describing: w.error))  in \(String(format: "%.1f", -t0.timeIntervalSinceNow))s")

// minimal sidecars so the harness's other panels don't error out on the synthetic clip
let t0ns: UInt64 = 1_000_000_000
var frames: [[String: Any]] = []
for k in 0..<total { frames.append(["frameIndex": k, "kind": "real", "status": 0,
    "displayTimeRaw": 0, "displayTimeNs": t0ns + UInt64(Double(k)*1e9/60),
    "ptsRawNs": 0, "ptsTimescale": 60000, "recvMachRaw": 0,
    "timelineNs": t0ns + UInt64(Double(k)*1e9/60), "driftNs": 0]) }
try? JSONSerialization.data(withJSONObject: frames).write(to: outDir.appendingPathComponent("display-frames.json"))
let anchors: [String: Any] = ["aborted": false, "abortReason": "SYNTHETIC", "machTimebaseNumer": 125,
    "machTimebaseDenom": 3, "nsPerMachTick": 125.0/3.0, "fps": 60,
    "displayPixelWidth": W, "displayPixelHeight": H, "displayPointWidth": W/2, "displayPointHeight": H/2,
    "displayBackingScale": 2.0, "displayBounds": ["x": 0, "y": 0, "w": W/2, "h": H/2],
    "screenFirstDisplayTimeNs": t0ns, "screenFramesReal": total, "screenFramesRepeat": 0, "screenFramesDropped": 0,
    "eventCount": 0, "eventTapReenables": 0, "cameraAuthorized": false, "micAuthorized": false,
    "cameraDevice": "none", "micDevice": "none", "cameraFirstPtsTimescale": 0, "micFirstPtsTimescale": 0,
    "notes": ["SYNTHETIC CLIP — gates 3 and 4 only. Gates 1/2/5 need a real capture."]]
try? JSONSerialization.data(withJSONObject: anchors).write(to: outDir.appendingPathComponent("anchors.json"))
try? JSONSerialization.data(withJSONObject: [] as [Any]).write(to: outDir.appendingPathComponent("events.json"))
print("wrote sidecars")
