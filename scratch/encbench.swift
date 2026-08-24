// Isolate VideoToolbox H.264 encode throughput at 4K vs this machine's native 6K.
import Foundation
import AVFoundation
import CoreGraphics

func bench(_ W: Int, _ H: Int, frames: Int, bitrate: Int, label: String, codec: AVVideoCodecType = .h264) {
    let dir = URL(fileURLWithPath: NSHomeDirectory() + "/dev/stc-screen-recorder/scratch/out-bench")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("enc-\(W)x\(H)-\(codec.rawValue).mp4")
    try? FileManager.default.removeItem(at: url)
    let w = try! AVAssetWriter(outputURL: url, fileType: .mp4)
    let s: [String: Any] = [
        AVVideoCodecKey: codec, AVVideoWidthKey: W, AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoMaxKeyFrameIntervalKey: 45,
            AVVideoExpectedSourceFrameRateKey: 60,
            AVVideoAllowFrameReorderingKey: false] as [String: Any]]
    let inp = AVAssetWriterInput(mediaType: .video, outputSettings: s)
    inp.expectsMediaDataInRealTime = false
    let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
    w.add(inp); w.startWriting(); w.startSession(atSourceTime: .zero)

    // pre-render 8 distinct high-entropy frames OUTSIDE the timed loop
    let cs = CGColorSpaceCreateDeviceRGB()
    var seed: UInt64 = 99
    func rnd() -> Double { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Double((seed >> 33) & 0xFFFFFF)/Double(0xFFFFFF) }
    var pool: [CVPixelBuffer] = []
    for f in 0..<8 {
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, ad.pixelBufferPool!, &pb)
        guard let pb = pb else { continue }
        CVPixelBufferLockBaseAddress(pb, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: W, height: H, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: cs,
                            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        ctx.setFillColor(red: 0.1, green: 0.15, blue: 0.3, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        for i in 0..<400 {
            let ph = Double(i) * 0.31 + Double(f) * 0.9
            ctx.setFillColor(red: rnd(), green: rnd(), blue: rnd(), alpha: 0.9)
            ctx.fill(CGRect(x: (rnd()*Double(W) + sin(ph)*260).truncatingRemainder(dividingBy: Double(W)),
                            y: (rnd()*Double(H) + cos(ph)*200).truncatingRemainder(dividingBy: Double(H)),
                            width: 40 + rnd()*180, height: 20 + rnd()*100))
        }
        for _ in 0..<2500 {
            ctx.setFillColor(red: rnd(), green: rnd(), blue: rnd(), alpha: 1)
            ctx.fill(CGRect(x: rnd()*Double(W), y: rnd()*Double(H), width: 6, height: 6))
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        pool.append(pb)
    }

    let sem = DispatchSemaphore(value: 0)
    var n = 0
    var t0: Date? = nil
    inp.requestMediaDataWhenReady(on: DispatchQueue(label: "enc")) {
        if t0 == nil { t0 = Date() }
        while inp.isReadyForMoreMediaData {
            if n >= frames { inp.markAsFinished(); sem.signal(); return }
            ad.append(pool[n % pool.count], withPresentationTime: CMTime(value: Int64(n)*1000, timescale: 60000))
            n += 1
        }
    }
    sem.wait()
    let elapsed = -(t0 ?? Date()).timeIntervalSinceNow
    let f = DispatchSemaphore(value: 0); w.finishWriting { f.signal() }; f.wait()
    let mp = Double(W*H)/1e6
    let fps = Double(n)/elapsed
    print(String(format: "%-22@ %5d frames  %6.2f s  →  %6.1f fps   (%.1f MP/frame, %.2f Gpx/s)  realtime60=%@",
                 label as NSString, n, elapsed, fps, mp, fps*mp/1000,
                 (fps >= 60 ? "YES" : "NO — max \(Int(fps)) fps") as NSString))
}

print("VideoToolbox encode throughput (pre-rendered frames, encode-only, 600 frames each):")
print("--- H.264 ---")
bench(3840, 2160, frames: 600, bitrate: 50_000_000, label: "h264 3840x2160 (4K)")
bench(4480, 2520, frames: 600, bitrate: 50_000_000, label: "h264 4480x2520")
bench(5120, 2880, frames: 600, bitrate: 50_000_000, label: "h264 5120x2880 (5K)")
bench(6016, 3384, frames: 600, bitrate: 50_000_000, label: "h264 6016x3384 (6K)")
print("--- HEVC ---")
bench(3840, 2160, frames: 600, bitrate: 50_000_000, label: "hevc 3840x2160 (4K)", codec: .hevc)
bench(5120, 2880, frames: 600, bitrate: 50_000_000, label: "hevc 5120x2880 (5K)", codec: .hevc)
bench(6016, 3384, frames: 600, bitrate: 50_000_000, label: "hevc 6016x3384 (6K)", codec: .hevc)
