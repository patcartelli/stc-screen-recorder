// Per-frame motion energy for camera.mp4 → camera-motion.json
// Used to locate a clap visually (hands meeting) with no input device in the loop.
import Foundation
import AVFoundation
import CoreVideo

let dir = URL(fileURLWithPath: CommandLine.arguments.count > 1
              ? CommandLine.arguments[1]
              : NSHomeDirectory() + "/dev/stc-screen-recorder/scratch/out")
let url = dir.appendingPathComponent("camera.mp4")
guard FileManager.default.fileExists(atPath: url.path) else {
    FileHandle.standardError.write("no camera.mp4 in \(dir.path)\n".data(using: .utf8)!); exit(1)
}
let asset = AVURLAsset(url: url)
guard let track = asset.tracks(withMediaType: .video).first else {
    FileHandle.standardError.write("no video track\n".data(using: .utf8)!); exit(1)
}
let reader = try AVAssetReader(asset: asset)
let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
out.alwaysCopiesSampleData = false
reader.add(out)
reader.startReading()

let GW = 160, GH = 90                       // downsample grid
var prev = [Int32](repeating: -1, count: GW*GH)
var cur  = [Int32](repeating: 0,  count: GW*GH)
var rows: [[String: Any]] = []
var idx = 0

while let sb = out.copyNextSampleBuffer() {
    autoreleasepool {
        defer { idx += 1 }
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let stride = CVPixelBufferGetBytesPerRow(pb)
        let p = base.assumingMemoryBound(to: UInt8.self)
        for gy in 0..<GH {
            let sy = gy * h / GH
            let rowBase = sy * stride
            for gx in 0..<GW {
                let sx = gx * w / GW
                let o = rowBase + sx * 4
                // BGRA → rough luma
                cur[gy*GW + gx] = Int32(p[o]) + Int32(p[o+1])*2 + Int32(p[o+2])
            }
        }
        var motion: Int64 = 0
        if prev[0] >= 0 { for i in 0..<(GW*GH) { motion += Int64(abs(cur[i] - prev[i])) } }
        swap(&prev, &cur)
        rows.append(["idx": idx, "ptsSec": pts,
                     "motion": prev[0] >= 0 ? Double(motion) / Double(GW*GH) : 0.0])
    }
}
if reader.status == .failed {
    FileHandle.standardError.write("reader failed: \(String(describing: reader.error))\n".data(using: .utf8)!)
    exit(1)
}
let outURL = dir.appendingPathComponent("camera-motion.json")
try JSONSerialization.data(withJSONObject: rows).write(to: outURL)
let ms = rows.map { $0["motion"] as! Double }
let mx = ms.max() ?? 0, avg = ms.reduce(0,+) / Double(max(1, ms.count))
print("camera-motion.json: \(rows.count) frames, \(String(format: "%.2f", rows.last.map { $0["ptsSec"] as! Double } ?? 0))s")
print("  motion: mean \(String(format: "%.2f", avg))  max \(String(format: "%.2f", mx))  peak/mean \(String(format: "%.1f", mx/max(avg,1e-9)))x")
