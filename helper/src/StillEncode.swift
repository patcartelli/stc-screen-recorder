import Foundation
import AppKit
import CoreGraphics
import ImageIO

/// `export-still`: the one way a still leaves this app (STC-293).
///
/// The composited pixels arrive as raw RGBA from whichever canvas drew them —
/// the still panel, the post-capture thumbnail (STC-296), the preview's frame
/// grab (STC-298) — and leave as a file, as pasteboard contents, or as both.
/// The ticket's Note is the reason this is one verb rather than three: "One
/// encoder, one filename template, one destination setting; no second
/// implementation hiding in the thumbnail." A `copy-still` beside an
/// `encode-still` would already be two.
///
/// Nothing here decides anything. Which format, whether alpha survives, what
/// the file is called and whether a timestamp is attached are all settled in
/// `transform/src/still-export.ts` and `StillEncodeDecisions.swift`; this file
/// reads a request and performs it.
///
/// ## Bounded, and answers exactly once
///
/// Like every other request path in this helper. `CGImageDestinationFinalize`
/// and `NSPasteboard` are both synchronous, so the wait this bounds is the
/// whole operation rather than a callback that might never come — but a 6K
/// HEIC encode on a busy machine is not instant, and "every wait needs a bound
/// and a reason" does not have an exception for the ones that look fast.
///
/// ## Nothing here touches `App.state`
///
/// Same rule `StillCapture` follows: an export taken during a recording must
/// not be able to disturb it. The only thing shared with the capture graph is
/// the process.
enum StillExport {
    /// Generous, because it covers reading up to 130 MB of RGBA off disk and a
    /// lossless encode of it. A wedge here costs the user one export and says
    /// so; it cannot cost them a take.
    ///
    /// It must stay UNDER the client's `DEFAULT_REQUEST_TIMEOUT_MS` (30 s), and
    /// that is the whole reason it is not 30 itself. Set equal, the client's
    /// generic "request timed out" always wins the race and this message —
    /// which names the operation and the bound — can never be delivered: the
    /// "inner bound set equal to the outer one" trap CLAUDE.md already records
    /// from the writer-gate work. `stop-bounds.test.ts` asserts the clearance,
    /// so the two numbers cannot drift back together.
    static let timeoutSeconds: Double = 20

    static func run(_ cmd: [String: Any],
                    completion: @escaping (Result<[String: Any], StillExportError>) -> Void) {
        let request: StillExportRequest
        switch parseStillExportRequest(cmd) {
        case .success(let r): request = r
        case .failure(let e): completion(.failure(e)); return
        }

        // Answer-once, the `start`/`stop` rule. Whichever of the work and the
        // backstop gets here first wins and the other is dropped.
        let lock = NSLock()
        var pending: ((Result<[String: Any], StillExportError>) -> Void)? = completion
        let answer: (Result<[String: Any], StillExportError>) -> Void = { r in
            lock.lock(); let c = pending; pending = nil; lock.unlock()
            c?(r)
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds) {
            answer(.failure(.encodeFailed("export-still did not finish within \(Int(timeoutSeconds)) s")))
        }
        DispatchQueue.global(qos: .userInitiated).async {
            answer(perform(request))
        }
    }

    // ── the work ───────────────────────────────────────────────────────────

    private static func perform(_ r: StillExportRequest) -> Result<[String: Any], StillExportError> {
        let started = Clock.nowNs()

        guard let expected = r.expectedBytes else {
            return .failure(.badSize("\(r.width)x\(r.height) overflows a byte count"))
        }
        let data: Data
        do {
            // Mapped, so a 130 MB buffer is not copied into this process only
            // to be handed straight to CoreGraphics.
            data = try Data(contentsOf: URL(fileURLWithPath: r.rgbaPath), options: [.mappedIfSafe])
        } catch {
            return .failure(.rgbaUnreadable("\(error)"))
        }
        guard data.count == expected else {
            return .failure(.rgbaSizeMismatch(expected: expected, got: data.count))
        }

        let made: (image: CGImage, premultiplied: Bool)
        switch makeImage(r, data)  {
        case .success(let m): made = m
        case .failure(let e): return .failure(e)
        }

        var reply: [String: Any] = [
            "width": r.width, "height": r.height,
            "format": r.format.rawValue,
            "alpha": r.alpha,
            "colorSpace": r.colorSpace.rawValue,
            // Which of the two bitmap layouts CoreGraphics actually accepted.
            // Not decoration: `.last` (unpremultiplied) is the layout a canvas
            // produces and the one this asks for first, and it is a line that
            // cannot be checked from a machine with no CoreGraphics — so the
            // reply reports it rather than the runbook assuming it.
            "premultiplied": made.premultiplied,
            "metadata": r.capturedAt == nil ? "stripped" : "kept",
        ]

        if let path = r.file {
            switch write(made.image, r, to: path) {
            case .success(let bytes):
                reply["file"] = path
                reply["bytes"] = bytes
            case .failure(let e):
                return .failure(e)
            }
        }

        if r.clipboard {
            switch copy(made.image, r) {
            case .success(let types): reply["clipboard"] = types
            case .failure(let e): return .failure(e)
            }
        }

        reply["totalMs"] = Double(Clock.nowNs() - started) / 1_000_000
        return .success(reply)
    }

    // ── pixels to a CGImage ────────────────────────────────────────────────

    /// Builds the image, falling back to premultiplied alpha if CoreGraphics
    /// refuses the unpremultiplied layout.
    ///
    /// The fallback is not superstition. `getImageData` is specified to return
    /// UNPREMULTIPLIED RGBA, `CGImage` documents `kCGImageAlphaLast` as valid,
    /// and this file is written on a machine with no CoreGraphics to ask —
    /// which is exactly the situation where a confident single path becomes a
    /// nil return and a dead end on someone else's Mac. Premultiplying costs
    /// one pass over the buffer and only happens if the first attempt fails.
    private static func makeImage(_ r: StillExportRequest, _ data: Data)
        -> Result<(image: CGImage, premultiplied: Bool), StillExportError> {
        guard let space = r.colorSpace.cgColorSpace else {
            return .failure(.imageFailed("no CGColorSpace for \(r.colorSpace.rawValue)"))
        }
        // NOT named `stride`: that shadows Swift's own `stride(from:to:by:)`
        // inside this scope, which compiles until the day somebody uses it.
        let bytesPerRow = r.width * 4

        if let image = image(from: data, r, space, bytesPerRow, premultiplied: false) {
            return .success((image, false))
        }
        // Only alpha-carrying layouts can be premultiplied; an opaque image
        // that failed to build failed for some other reason, and retrying it
        // identically would just be slower.
        guard r.alpha else {
            return .failure(.imageFailed("CGImage refused a \(r.width)x\(r.height) opaque RGBA buffer"))
        }
        guard let image = image(from: premultiply(data), r, space, bytesPerRow, premultiplied: true) else {
            return .failure(.imageFailed("CGImage refused a \(r.width)x\(r.height) RGBA buffer "
                + "in both unpremultiplied and premultiplied layouts"))
        }
        return .success((image, true))
    }

    private static func image(from data: Data, _ r: StillExportRequest,
                              _ space: CGColorSpace, _ bytesPerRow: Int,
                              premultiplied: Bool) -> CGImage? {
        guard let provider = CGDataProvider(data: data as CFData) else { return nil }
        return CGImage(width: r.width, height: r.height,
                       bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
                       space: space,
                       bitmapInfo: stillBitmapInfo(alpha: r.alpha, premultiplied: premultiplied),
                       provider: provider, decode: nil, shouldInterpolate: false,
                       intent: .defaultIntent)
    }

    /// Straight alpha to premultiplied, in place on a copy.
    ///
    /// Rounded rather than truncated (`+ 127) / 255`): truncation darkens every
    /// partially transparent pixel by up to one level, which along a window's
    /// antialiased corner is precisely the dark fringe the whole still path is
    /// built to avoid.
    private static func premultiply(_ data: Data) -> Data {
        var out = data
        out.withUnsafeMutableBytes { raw in
            guard let p = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            var i = 0
            while i + 3 < raw.count {
                let a = UInt32(p[i + 3])
                if a != 255 {
                    p[i]     = UInt8((UInt32(p[i])     * a + 127) / 255)
                    p[i + 1] = UInt8((UInt32(p[i + 1]) * a + 127) / 255)
                    p[i + 2] = UInt8((UInt32(p[i + 2]) * a + 127) / 255)
                }
                i += 4
            }
        }
        return out
    }

    // ── to a file ──────────────────────────────────────────────────────────

    private static func write(_ image: CGImage, _ r: StillExportRequest,
                              to path: String) -> Result<Int, StillExportError> {
        let url = URL(fileURLWithPath: path)
        // The directory is the caller's to choose and may not exist yet — a
        // user-set destination folder that was deleted since is a normal state,
        // not a reason to lose the export.
        let dir = url.deletingLastPathComponent()
        do { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        catch { return .failure(.encodeFailed("could not create \(dir.path): \(error)")) }

        guard let dest = CGImageDestinationCreateWithURL(
            url as CFURL, r.format.uti as CFString, 1, nil) else {
            // HEIC is the one of the three that a given macOS may genuinely not
            // be able to write, so say which format failed rather than "could
            // not create a destination".
            return .failure(.encodeFailed("this Mac cannot write \(r.format.rawValue) (\(r.format.uti))"))
        }
        CGImageDestinationAddImage(dest, image, stillImageProperties(r) as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            // A half-written file is worse than none: it is a file the user
            // will open, find broken, and blame the capture for.
            try? FileManager.default.removeItem(at: url)
            return .failure(.encodeFailed("\(r.format.rawValue) encode of \(url.lastPathComponent) failed"))
        }
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return .success((attrs?[.size] as? Int) ?? 0)
    }

    /// Encodes into memory, for the pasteboard.
    private static func encode(_ image: CGImage, uti: String,
                               _ props: [CFString: Any]) -> Data? {
        let buffer = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            buffer as CFMutableData, uti as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        return CGImageDestinationFinalize(dest) ? buffer as Data : nil
    }

    // ── to the pasteboard ──────────────────────────────────────────────────

    /// "Clipboard carries transparency where the destination supports it: put
    /// both PNG and TIFF representations on the pasteboard so Slack, Figma and
    /// Keynote each take the one they handle best" (STC-293).
    ///
    /// Both are lossless and both keep alpha, so this is not a quality
    /// trade-off — it is about what each receiver knows how to ask for. TIFF is
    /// the pasteboard's historical image type and is what the Apple apps reach
    /// for first; PNG is what the web-shaped ones (Slack, Figma, anything
    /// Electron) understand. An app offered only TIFF pastes a flattened or
    /// white-backed image surprisingly often, and offering only PNG loses
    /// Keynote.
    ///
    /// ## The order is the preference, and the file URL is last on purpose
    ///
    /// A receiver takes the FIRST type it recognises, so PNG leads: it is the
    /// one that most reliably keeps transparency across the widest set of
    /// destinations. The file URL is offered too — "also a file URL promise so
    /// a drag into Finder or a Slack upload gets a real file" — but last,
    /// because an app that prefers a file URL turns ⌘V into "attach a file",
    /// and a paste into a Slack message should be an inline image unless
    /// nothing else is on offer.
    ///
    /// ## It is a real file, not a promise
    ///
    /// The ticket says "file URL promise". `NSFilePromiseProvider` is a
    /// drag-and-drop mechanism: it needs a live provider object to answer the
    /// receiver's callback, which means an app that is still running when the
    /// paste happens. A helper process that has answered its request and gone
    /// idle cannot honour one, and a promise nobody answers is worse than no
    /// promise at all — the receiver gets a zero-byte file. So the caller
    /// writes a real file first and this points at it. The user-visible
    /// behaviour is the one the ticket asked for; the mechanism is the one that
    /// survives the process model.
    private static func copy(_ image: CGImage, _ r: StillExportRequest)
        -> Result<[String], StillExportError> {
        let props = stillImageProperties(r)
        guard let png = encode(image, uti: StillExportFormat.png.uti, props) else {
            return .failure(.clipboardFailed("PNG encode for the pasteboard failed"))
        }
        // Best-effort: TIFF is the belt to PNG's braces, and losing it costs
        // some receivers a nicer representation rather than costing the copy.
        let tiff = encode(image, uti: "public.tiff", props)

        let item = NSPasteboardItem()
        var types: [String] = []
        if item.setData(png, forType: .png) { types.append("png") }
        if let tiff, item.setData(tiff, forType: .tiff) { types.append("tiff") }
        if let path = r.file {
            let url = URL(fileURLWithPath: path)
            if item.setString(url.absoluteString, forType: .fileURL) { types.append("fileURL") }
        }
        guard !types.isEmpty else {
            return .failure(.clipboardFailed("the pasteboard accepted none of the representations"))
        }

        let pb = NSPasteboard.general
        pb.clearContents()
        guard pb.writeObjects([item]) else {
            return .failure(.clipboardFailed("NSPasteboard refused the item"))
        }
        return .success(types)
    }
}
