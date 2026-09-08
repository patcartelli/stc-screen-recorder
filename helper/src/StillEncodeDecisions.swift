import Foundation
import CoreGraphics
import ImageIO

/// The decisions the still EXPORT path makes (STC-293), kept free of AppKit and
/// ImageIO's side effects so `helper/test/still-encode/main.swift` can compile
/// them into a throwaway binary and exercise them without a display, a grant, a
/// pasteboard or a single byte of image data — the same arrangement
/// `StillDecisions.swift` has for the capture path.
///
/// What is decided here: what an `export-still` request means and whether it is
/// well-formed; which UTI and which bitmap layout each format implies; and the
/// exact ImageIO properties dictionary the encode is handed. `StillEncode.swift`
/// calls these; it does not repeat them.
///
/// ## Why this exists at all
///
/// The composited still is produced by a canvas in the renderer, and the
/// obvious thing would be to let that canvas encode it — `toBlob("image/png")`
/// is one line. It cannot do the job. Three of the five decoration modes exist
/// to produce transparency, one of the two acceptance criteria is about a
/// Display P3 capture surviving the round trip without a visible shift, and the
/// ticket asks for HEIC. A canvas gives no control over the embedded ICC
/// profile, cannot write HEIC at all, and has no way to attach or withhold a
/// capture timestamp. ImageIO does all three, and it lives here.

// ── formats ────────────────────────────────────────────────────────────────

/// Mirrors `FORMATS` in `transform/src/still-export.ts`. The TypeScript side is
/// where a format is CHOSEN; this is where one is honoured. Two lists, one
/// contract — `still-encode-decisions.test.ts` asserts they agree, the same way
/// `cursor-shape-names.test.ts` pins the shape enum against its artwork.
enum StillExportFormat: String, CaseIterable {
    case png, heic, jpeg

    /// What ImageIO is handed. Not derived from the extension: `jpg` is the
    /// extension and `public.jpeg` is the type, and conflating the two is how a
    /// destination silently fails to be created.
    var uti: String {
        switch self {
        case .png:  return "public.png"
        case .heic: return "public.heic"
        case .jpeg: return "public.jpeg"
        }
    }

    /// Whether the container can carry an alpha channel.
    var keepsAlpha: Bool { self != .jpeg }

    /// Whether `quality` means anything to the encoder.
    var isLossy: Bool { self != .png }
}

/// The two colour spaces a Mac display actually is. Anything else is a profile
/// this app has no way to have produced, and tagging a file with a name it
/// cannot honour would be a lie about the pixels.
enum StillColorSpaceName: String {
    case srgb = "srgb"
    case displayP3 = "display-p3"

    var cgColorSpace: CGColorSpace? {
        switch self {
        case .srgb:      return CGColorSpace(name: CGColorSpace.sRGB)
        case .displayP3: return CGColorSpace(name: CGColorSpace.displayP3)
        }
    }
}

// ── the request ────────────────────────────────────────────────────────────

/// One `export-still`.
///
/// The pixels arrive as a FILE of raw RGBA rather than inline in the JSON.
/// A 4K still is 33 MB of RGBA; base64 in a JSON line would be 44 MB through a
/// pipe that this codebase deliberately keeps for small reliable messages, and
/// `IO.send`'s reliable channel would be blocked for the duration. The file is
/// written by the caller, read once here, and is the caller's to delete.
struct StillExportRequest: Equatable {
    /// Absolute path to `width * height * 4` bytes of RGBA8, unpremultiplied,
    /// top row first — exactly what a canvas `getImageData` yields.
    let rgbaPath: String
    let width: Int
    let height: Int
    /// Whether the caller wants the alpha channel kept. Already reconciled
    /// against the format on the TypeScript side; re-checked here because a
    /// helper that trusted a caller to have done the reconciliation would
    /// encode a transparent JPEG on the day one caller forgot.
    let alpha: Bool
    let colorSpace: StillColorSpaceName
    let format: StillExportFormat
    let quality: Double
    /// Absolute path to write, or nil for clipboard-only.
    let file: String?
    /// Whether to put the image on the pasteboard.
    let clipboard: Bool
    /// ISO 8601. Absent means the caller asked for the metadata to be stripped
    /// — see `imageProperties` for why the colour profile is not covered by it.
    let capturedAt: String?

    /// True when the encode has somewhere to go. A request with neither is not
    /// a cheap no-op, it is a caller that has lost track of what it wanted.
    var hasDestination: Bool { file != nil || clipboard }

    /// Overflow-safe, because `width * height * 4` on absurd input is exactly
    /// where a size check stops being one.
    var expectedBytes: Int? {
        let (pixels, overflow1) = width.multipliedReportingOverflow(by: height)
        if overflow1 { return nil }
        let (bytes, overflow2) = pixels.multipliedReportingOverflow(by: 4)
        return overflow2 ? nil : bytes
    }
}

enum StillExportError: Error, Equatable, CustomStringConvertible {
    case missingRgba
    case badSize(String)
    case badFormat(String)
    case badColorSpace(String)
    case badFile(String)
    case noDestination
    case rgbaUnreadable(String)
    case rgbaSizeMismatch(expected: Int, got: Int)
    case imageFailed(String)
    case encodeFailed(String)
    case clipboardFailed(String)

    var code: String {
        switch self {
        case .missingRgba:       return "missing-rgba"
        case .badSize:           return "bad-size"
        case .badFormat:         return "bad-format"
        case .badColorSpace:     return "bad-color-space"
        case .badFile:           return "bad-file"
        case .noDestination:     return "no-destination"
        case .rgbaUnreadable:    return "rgba-unreadable"
        case .rgbaSizeMismatch:  return "rgba-size-mismatch"
        case .imageFailed:       return "image-failed"
        case .encodeFailed:      return "encode-failed"
        case .clipboardFailed:   return "clipboard-failed"
        }
    }

    var description: String {
        switch self {
        case .missingRgba:
            return "export-still requires \"rgba\", an absolute path to raw RGBA8 pixels"
        case .badSize(let why):
            return "width and height must be positive integers within a sane image: \(why)"
        case .badFormat(let f):
            return "format must be one of \(StillExportFormat.allCases.map(\.rawValue).joined(separator: ", ")), not \"\(f)\""
        case .badColorSpace(let c):
            return "colorSpace must be srgb or display-p3, not \"\(c)\""
        case .badFile(let f):
            return "file must be an absolute path, not \"\(f)\""
        case .noDestination:
            return "export-still needs somewhere to put the image: a \"file\", \"clipboard\": true, or both"
        case .rgbaUnreadable(let why):
            return "could not read the RGBA pixels: \(why)"
        case .rgbaSizeMismatch(let expected, let got):
            return "the RGBA file holds \(got) bytes; width x height x 4 is \(expected)"
        case .imageFailed(let why):
            return "could not build an image from the pixels: \(why)"
        case .encodeFailed(let why):
            return "could not encode the image: \(why)"
        case .clipboardFailed(let why):
            return "could not put the image on the pasteboard: \(why)"
        }
    }
}

/// The largest side this will accept, in pixels.
///
/// Not a limit anybody should reach — the biggest display Apple ships is 6016
/// wide and a decorated still adds padding — but a `width` arriving as a
/// mistyped 60160 would ask CoreGraphics for a 14 GB allocation, and a helper
/// that dies of a bad number in a JSON line takes a running recording with it.
let stillExportMaxSide = 32_768

/// Numbers arrive from JSONSerialization as NSNumber, and `as? Double` bridges
/// an integral NSNumber too. A native Swift `Int` inside `Any` — which is what
/// the test harness's dictionary literals are — does NOT take that bridge, so
/// it is accepted by name. Learnt the hard way in `StillDecisions.swift`.
private func exportInt(_ v: Any?) -> Int? {
    if let i = v as? Int { return i }
    if let d = v as? Double, d.isFinite, d == d.rounded() { return Int(d) }
    return nil
}

private func exportDouble(_ v: Any?) -> Double? {
    if let d = v as? Double, d.isFinite { return d }
    if let i = v as? Int { return Double(i) }
    return nil
}

/// Clamped rather than refused: a quality outside 0..1 is a caller bug, but it
/// is not one worth failing an export over, and ImageIO's behaviour on an
/// out-of-range value is undefined rather than documented.
func clampExportQuality(_ v: Double?) -> Double {
    guard let v, v.isFinite else { return 0.9 }
    return Swift.min(1, Swift.max(0, v))
}

func parseStillExportRequest(_ cmd: [String: Any]) -> Result<StillExportRequest, StillExportError> {
    guard let rgba = cmd["rgba"] as? String, !rgba.isEmpty else { return .failure(.missingRgba) }
    guard rgba.hasPrefix("/") else { return .failure(.badFile(rgba)) }

    guard let width = exportInt(cmd["width"]), let height = exportInt(cmd["height"]) else {
        return .failure(.badSize("width and height are required"))
    }
    guard width > 0, height > 0 else { return .failure(.badSize("\(width)x\(height)")) }
    guard width <= stillExportMaxSide, height <= stillExportMaxSide else {
        return .failure(.badSize("\(width)x\(height) exceeds \(stillExportMaxSide) on a side"))
    }

    let formatName = cmd["format"] as? String ?? StillExportFormat.png.rawValue
    guard let format = StillExportFormat(rawValue: formatName) else {
        return .failure(.badFormat(formatName))
    }

    let spaceName = cmd["colorSpace"] as? String ?? StillColorSpaceName.srgb.rawValue
    guard let colorSpace = StillColorSpaceName(rawValue: spaceName) else {
        return .failure(.badColorSpace(spaceName))
    }

    var file: String? = nil
    if let f = cmd["file"] as? String, !f.isEmpty {
        guard f.hasPrefix("/") else { return .failure(.badFile(f)) }
        file = f
    }
    let clipboard = cmd["clipboard"] as? Bool ?? false

    // A JPEG asked to keep alpha is a request that cannot be honoured, so the
    // honest thing is to drop the alpha here rather than hand ImageIO a
    // contradiction and inherit whatever it decides to fill with — which is
    // black, and is the exact outcome the ticket forbids. The caller has
    // already flattened onto its chosen colour by this point; the pixels are
    // opaque and this only makes the layout say so.
    let alpha = (cmd["alpha"] as? Bool ?? true) && format.keepsAlpha

    let request = StillExportRequest(
        rgbaPath: rgba, width: width, height: height, alpha: alpha,
        colorSpace: colorSpace, format: format,
        quality: clampExportQuality(exportDouble(cmd["quality"])),
        file: file, clipboard: clipboard,
        capturedAt: (cmd["capturedAt"] as? String).flatMap { $0.isEmpty ? nil : $0 })

    guard request.hasDestination else { return .failure(.noDestination) }
    guard request.expectedBytes != nil else {
        return .failure(.badSize("\(width)x\(height) overflows a byte count"))
    }
    return .success(request)
}

// ── the bitmap layout ──────────────────────────────────────────────────────

/// How CoreGraphics should read the caller's bytes.
///
/// The bytes are RGBA in memory order, which is what `getImageData` produces
/// and what every other 32-bit-per-pixel format in this codebase is not — the
/// capture path uses BGRA. `byteOrder32Big` is what says "the first byte in
/// memory is the first component", which for RGBA means R.
///
/// `.last` is UNPREMULTIPLIED alpha, matching the canvas spec. `CGImage`
/// accepts it (it is `CGBitmapContext` that does not), but this is one of the
/// few lines in the file that cannot be checked from a machine with no
/// CoreGraphics, so `StillEncode` carries a premultiplying fallback and the
/// reply says which path it took.
func stillBitmapInfo(alpha: Bool, premultiplied: Bool) -> CGBitmapInfo {
    let alphaInfo: CGImageAlphaInfo = alpha
        ? (premultiplied ? .premultipliedLast : .last)
        // The alpha byte is still THERE — the caller sent four bytes per pixel
        // either way — it is just not to be read. Skipping it is what keeps the
        // stride at 4 without a repacking pass over 33 MB.
        : .noneSkipLast
    return CGBitmapInfo(rawValue: alphaInfo.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
}

// ── the properties dictionary ──────────────────────────────────────────────

/// EXIF and TIFF both want `yyyy:MM:dd HH:mm:ss` in LOCAL time, with the colons
/// — a format that predates ISO 8601 winning and is not negotiable.
func exifDateString(fromISO iso: String) -> String? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = parser.date(from: iso) ?? {
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }()
    guard let date else { return nil }
    let out = DateFormatter()
    out.locale = Locale(identifier: "en_US_POSIX")
    out.dateFormat = "yyyy:MM:dd HH:mm:ss"
    return out.string(from: date)
}

/// What ImageIO is told about the image, beyond the pixels.
///
/// ## The colour profile is not in here, and that is the point
///
/// It comes from the `CGImage`'s own colour space and is embedded on every
/// path, stripped or not. The ticket asks for "an optional metadata strip
/// ... since a shot of a screen can carry the display's colour profile and a
/// capture timestamp", and those two are not the same kind of thing:
///
/// - The TIMESTAMP is metadata. It says when the user was at their desk, it
///   travels with the file, and wanting it gone before sending a screenshot to
///   a stranger is entirely reasonable.
/// - The PROFILE is not metadata. It is what makes the numbers mean colours.
///   Strip it from a Display P3 capture and every viewer falls back to sRGB,
///   which is a visible shift — the exact failure the acceptance list's "round
///   trip through PNG preserves the wide-gamut colours ... without a visible
///   shift" forbids.
///
/// So one switch cannot govern both, and this one governs the timestamp.
///
/// There is also nothing to REMOVE here. The pixels arrive as raw RGBA with no
/// container and no EXIF of their own, so stripping is not a filtering pass
/// that might miss a field — it is simply not adding one, which is the one
/// version of this feature that cannot be incomplete.
func stillImageProperties(_ r: StillExportRequest) -> [CFString: Any] {
    var props: [CFString: Any] = [:]
    if r.format.isLossy {
        props[kCGImageDestinationLossyCompressionQuality] = r.quality
    }
    guard let iso = r.capturedAt, let stamp = exifDateString(fromISO: iso) else { return props }
    props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFDateTime: stamp]
    props[kCGImagePropertyExifDictionary] = [
        kCGImagePropertyExifDateTimeOriginal: stamp,
        kCGImagePropertyExifDateTimeDigitized: stamp,
    ]
    return props
}

/// The property KEYS a request implies, as plain strings.
///
/// Exists so the pure harness can assert what is being asked for without a
/// `CGImageDestination` to ask — `kCGImageDestinationLossyCompressionQuality`
/// and friends are CFStrings whose values are stable, and comparing them as
/// strings is the only way to check the strip actually strips on a machine
/// that cannot encode anything.
func stillPropertyKeys(_ r: StillExportRequest) -> [String] {
    stillImageProperties(r).keys.map { $0 as String }.sorted()
}
