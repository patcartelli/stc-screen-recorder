// Pure-function tests for the still EXPORT path's decisions (STC-293).
// Compiled together with the production source, same as the still, geometry
// and decisions harnesses: no XCTest, so the "framework" is assertions plus a
// non-zero exit.
//
// Everything here runs without a display, a grant, a pasteboard or a byte of
// image data. What it CANNOT check is the half that only exists on a Mac:
// whether CoreGraphics accepts the unpremultiplied bitmap layout, whether this
// machine can write HEIC, and whether NSPasteboard takes the item. Those are
// `still-export.grant.test.ts` and docs/STC-293-RUNBOOK.md.
import Foundation
import CoreGraphics
import ImageIO

var failures = 0
// Compares descriptions, so `got` may be an Optional without every check
// failing on `Optional("x") != "x"` — the trap the still harness hit on CI.
func check(_ label: String, _ got: some Equatable, _ want: some Equatable) {
    if String(describing: got) == String(describing: want) {
        print("ok   \(label)")
    } else {
        let line = "FAIL \(label): got \(got), want \(want)"
        print(line)
        // Also to stderr: on a failure the runner reports only the TAIL of each
        // stream, and a page of `ok` lines pushes the one FAIL out of stdout's.
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
        failures += 1
    }
}

// ── request parsing ─────────────────────────────────────────────────────────

let ok: [String: Any] = ["cmd": "export-still", "rgba": "/tmp/x.rgba",
                         "width": 100, "height": 50, "file": "/tmp/out.png"]
func with(_ over: [String: Any]) -> [String: Any] {
    var c = ok
    for (k, v) in over { c[k] = v }
    return c
}
func parse(_ cmd: [String: Any]) -> String {
    switch parseStillExportRequest(cmd) {
    case .success(let r):
        return "ok:\(r.format.rawValue):\(r.width)x\(r.height):alpha=\(r.alpha)"
            + ":\(r.colorSpace.rawValue):q=\(r.quality)"
    case .failure(let e): return "err:\(e.code)"
    }
}

check("a minimal request parses", parse(ok), "ok:png:100x50:alpha=true:srgb:q=0.9")
check("rgba is required", parse(with(["rgba": ""])), "err:missing-rgba")
check("rgba must be an absolute path", parse(with(["rgba": "x.rgba"])), "err:bad-file")
check("width is required", parse(["rgba": "/tmp/x.rgba", "height": 50, "clipboard": true]), "err:bad-size")
check("a zero side is refused", parse(with(["width": 0])), "err:bad-size")
check("a negative side is refused", parse(with(["height": -1])), "err:bad-size")
check("an absurd side is refused before it is allocated",
      parse(with(["width": stillExportMaxSide + 1])), "err:bad-size")
check("the largest allowed side is allowed",
      parse(with(["width": stillExportMaxSide])), "ok:png:32768x50:alpha=true:srgb:q=0.9")
check("an unknown format is refused, not defaulted",
      parse(with(["format": "webp"])), "err:bad-format")
check("heic parses", parse(with(["format": "heic"])), "ok:heic:100x50:alpha=true:srgb:q=0.9")
check("an unknown colour space is refused, not defaulted",
      parse(with(["colorSpace": "adobe-rgb"])), "err:bad-color-space")
check("display-p3 parses",
      parse(with(["colorSpace": "display-p3"])), "ok:png:100x50:alpha=true:display-p3:q=0.9")
check("file must be an absolute path", parse(with(["file": "out.png"])), "err:bad-file")
check("clipboard alone is a destination",
      parse(["rgba": "/tmp/x.rgba", "width": 100, "height": 50, "clipboard": true]),
      "ok:png:100x50:alpha=true:srgb:q=0.9")
check("neither a file nor a clipboard is not a destination",
      parse(["rgba": "/tmp/x.rgba", "width": 100, "height": 50]), "err:no-destination")

// A JPEG cannot carry alpha, so the request may not claim it does — whatever
// the caller sent. The ticket's "never silently fill black" starts here: an
// alpha-carrying image handed to a JPEG encoder is where the black comes from.
check("a JPEG drops alpha whatever the caller asked for",
      parse(with(["format": "jpeg", "alpha": true])), "ok:jpeg:100x50:alpha=false:srgb:q=0.9")
check("a PNG keeps alpha off when the caller says so",
      parse(with(["alpha": false])), "ok:png:100x50:alpha=false:srgb:q=0.9")

check("quality is clamped high", parse(with(["quality": 4.0])), "ok:png:100x50:alpha=true:srgb:q=1.0")
check("quality is clamped low", parse(with(["quality": -1.0])), "ok:png:100x50:alpha=true:srgb:q=0.0")
check("an integer quality bridges (a Swift Int in Any is not an NSNumber)",
      parse(with(["quality": 1])), "ok:png:100x50:alpha=true:srgb:q=1.0")

// ── byte counts ─────────────────────────────────────────────────────────────

func bytes(_ w: Int, _ h: Int) -> String {
    switch parseStillExportRequest(with(["width": w, "height": h])) {
    case .success(let r): return String(describing: r.expectedBytes ?? -1)
    case .failure(let e): return "err:\(e.code)"
    }
}
check("expected bytes is w*h*4", bytes(100, 50), "20000")
check("a 4K still is 33 MB of RGBA", bytes(3840, 2160), "33177600")

// ── the bitmap layout ───────────────────────────────────────────────────────

func layout(_ alpha: Bool, _ pre: Bool) -> String {
    let info = stillBitmapInfo(alpha: alpha, premultiplied: pre)
    let a = CGImageAlphaInfo(rawValue: info.rawValue & CGBitmapInfo.alphaInfoMask.rawValue)
    let big = info.contains(.byteOrder32Big)
    return "\(a?.rawValue ?? 99):big=\(big)"
}
// The byte order is what says "the first byte in memory is R"; without it the
// same buffer reads as ABGR and every colour is wrong in a way that looks like
// a capture bug rather than an encoder one.
check("unpremultiplied alpha is kCGImageAlphaLast, byte order big",
      layout(true, false), "\(CGImageAlphaInfo.last.rawValue):big=true")
check("the premultiplied fallback is kCGImageAlphaPremultipliedLast",
      layout(true, true), "\(CGImageAlphaInfo.premultipliedLast.rawValue):big=true")
check("no alpha skips the fourth byte rather than repacking to 24bpp",
      layout(false, false), "\(CGImageAlphaInfo.noneSkipLast.rawValue):big=true")
check("premultiplied is meaningless without alpha",
      layout(false, true), "\(CGImageAlphaInfo.noneSkipLast.rawValue):big=true")

// ── the properties dictionary ───────────────────────────────────────────────

func keys(_ over: [String: Any]) -> String {
    switch parseStillExportRequest(with(over)) {
    case .success(let r): return stillPropertyKeys(r).joined(separator: ",")
    case .failure(let e): return "err:\(e.code)"
    }
}
let quality = kCGImageDestinationLossyCompressionQuality as String
let tiff = kCGImagePropertyTIFFDictionary as String
let exif = kCGImagePropertyExifDictionary as String
let dated = [exif, quality, tiff].sorted().joined(separator: ",")

check("a lossless format is not handed a quality", keys([:]), "")
check("a lossy format is", keys(["format": "jpeg"]), quality)
check("heic is lossy too", keys(["format": "heic"]), quality)
check("a kept timestamp lands in both EXIF and TIFF",
      keys(["format": "jpeg", "capturedAt": "2026-09-08T14:23:05Z"]), dated)
check("stripping metadata is not adding it, so nothing is left to miss",
      keys(["format": "jpeg"]), quality)
check("an empty capturedAt is an absent one, not an empty timestamp",
      keys(["format": "jpeg", "capturedAt": ""]), quality)
check("an unparseable capturedAt is dropped rather than written wrong",
      keys(["format": "jpeg", "capturedAt": "last tuesday"]), quality)
check("a PNG with a timestamp still gets no quality",
      keys(["capturedAt": "2026-09-08T14:23:05Z"]), [exif, tiff].sorted().joined(separator: ","))

// ── the EXIF date format ────────────────────────────────────────────────────
//
// EXIF and TIFF both want `yyyy:MM:dd HH:mm:ss` with colons, in LOCAL time.
// Asserted against a fixed UTC instant rendered in a fixed zone, because the
// harness runs wherever CI puts it and "whatever this machine calls now" is
// not an assertion.
func exifIn(_ tz: String, _ iso: String) -> String {
    // ISO8601DateFormatter parses to an instant; only the OUTPUT formatter
    // reads a zone, so pinning that zone pins the whole answer.
    guard let zone = TimeZone(identifier: tz) else { return "no such zone" }
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime]
    guard let date = parser.date(from: iso) else { return "unparseable" }
    let out = DateFormatter()
    out.locale = Locale(identifier: "en_US_POSIX")
    out.timeZone = zone
    out.dateFormat = "yyyy:MM:dd HH:mm:ss"
    return out.string(from: date)
}
check("EXIF dates use colons, not dashes",
      exifIn("UTC", "2026-09-08T14:23:05Z"), "2026:09:08 14:23:05")
check("EXIF dates are local, so a zone shifts them",
      exifIn("America/Los_Angeles", "2026-09-08T14:23:05Z"), "2026:09:08 07:23:05")
// The production function reads the machine's zone, so it is checked for SHAPE
// rather than for a value CI cannot know.
if let s = exifDateString(fromISO: "2026-09-08T14:23:05Z") {
    let shaped = s.range(of: "^\\d{4}:\\d{2}:\\d{2} \\d{2}:\\d{2}:\\d{2}$",
                         options: .regularExpression) != nil
    check("exifDateString produces the EXIF shape", shaped, true)
} else {
    check("exifDateString parsed an ISO instant", false, true)
}
check("fractional seconds parse too (Date#toISOString writes them)",
      exifDateString(fromISO: "2026-09-08T14:23:05.123Z") != nil, true)
check("a non-date is refused rather than defaulted to now",
      String(describing: exifDateString(fromISO: "not a date")), "nil")

// ── the format table, for the TypeScript side to compare against ────────────
//
// Printed rather than asserted here: `still-encode-decisions.test.ts` reads
// these and checks them against FORMATS in transform/src/still-export.ts, so
// the two lists cannot drift. Same arrangement cursor-shape-names.test.ts has.
for f in StillExportFormat.allCases {
    print("format \(f.rawValue) \(f.uti) alpha=\(f.keepsAlpha) lossy=\(f.isLossy)")
}
for s in [StillColorSpaceName.srgb, .displayP3] {
    print("colorspace \(s.rawValue)")
}

print(failures == 0 ? "ALL PASS" : "\(failures) FAILURES")
exit(failures == 0 ? 0 : 1)
