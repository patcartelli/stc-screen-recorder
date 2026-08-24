// Deterministic fixture clip for increment 0. Reads a frames.json PTS grid
// (session-relative integer ns) and writes display.mp4 with exactly those
// sample times. Content is a pure function of frame index: hue-striped
// background, moving square, and the index itself as a 12-bit block row
// (frame identity is verifiable by eye and by pixel probe).
// Encoder settings per PHASE-0 §8: H.264 High, no B-frames, GOP 45.
import Foundation
import AVFoundation
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: gen-display <frames.json> <out.mp4> [--offset-ns N]\n".data(using: .utf8)!)
    exit(2)
}
// A non-zero offset makes AVAssetWriter emit an EMPTY EDIT rather than shifting
// sample CTS — which is exactly what a real capture does, because the first
// frame never lands precisely at the moment the start command arrived.
let offsetNs = args.firstIndex(of: "--offset-ns").flatMap { i -> Int? in
    i + 1 < args.count ? Int(args[i + 1]) : nil
} ?? 0
let framesNs = try JSONSerialization.jsonObject(
    with: Data(contentsOf: URL(fileURLWithPath: args[1]))) as! [Int]
let outURL = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: outURL)

let W = 640, H = 360
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: W, AVVideoHeightKey: H,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 2_000_000,
        AVVideoMaxKeyFrameIntervalKey: 45,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: false,
    ] as [String: Any],
])
input.expectsMediaDataInRealTime = false
input.mediaTimeScale = 1_000_000_000   // sample PTS survive as exact integer ns
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H,
    ])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

func hueRGB(_ h: Double) -> (Double, Double, Double) {
    let s = 0.55, v = 0.85
    let i = Int(h * 6) % 6, f = h * 6 - Double(Int(h * 6))
    let p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
    switch i {
    case 0: return (v, t, p); case 1: return (q, v, p); case 2: return (p, v, t)
    case 3: return (p, q, v); case 4: return (t, p, v); default: return (v, p, q)
    }
}

for (i, ptsNs) in framesNs.enumerated() {
    while !input.isReadyForMoreMediaData { usleep(2000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
    let buf = pb!
    CVPixelBufferLockBaseAddress(buf, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf),
                        width: W, height: H,
                        bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(buf),
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                  | CGBitmapInfo.byteOrder32Little.rawValue)!
    // background: hue advances per frame
    let (r, g, b) = hueRGB(Double((i * 7) % 90) / 90.0)
    ctx.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    // moving square, position a pure function of i
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: (i * 37) % (W - 40), y: (i * 23) % (H - 80) + 40, width: 40, height: 40))
    // 12-bit frame index as a block row along the top
    for bit in 0..<12 {
        let on = (i >> (11 - bit)) & 1 == 1
        ctx.setFillColor(CGColor(gray: on ? 1 : 0, alpha: 1))
        ctx.fill(CGRect(x: 8 + bit * 20, y: H - 24, width: 16, height: 16))
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(ptsNs + offsetNs), timescale: 1_000_000_000))
}
input.markAsFinished()
writer.endSession(atSourceTime: CMTime(value: CMTimeValue(5_000_000_000 + offsetNs), timescale: 1_000_000_000))
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
guard writer.status == .completed else {
    FileHandle.standardError.write("writer failed: \(String(describing: writer.error))\n".data(using: .utf8)!)
    exit(1)
}
print("wrote \(outURL.path): \(framesNs.count) frames")
