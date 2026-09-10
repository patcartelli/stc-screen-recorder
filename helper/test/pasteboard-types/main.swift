// Prints the SYSTEM pasteboard's advertised types, one per line, as real UTIs.
//
// ## Why this exists rather than `osascript -e "clipboard info"`
//
// The clipboard test read its types through AppleScript and parsed them with
// a regex over the `«class XXXX»` form. That instrument could not see what it
// was being read as evidence about: AppleScript reports well-known types by
// FRIENDLY NAME — "TIFF picture", "GIF picture", "JPEG picture" — and falls
// back to `«class XXXX»` only for the ones it has no name for. So the regex
// silently dropped exactly the types AppleScript knows best.
//
// Measured on hardware 2026-09-09. `clipboard info` returned ten entries;
// the regex matched seven, and the test reported the pasteboard as lacking
// TIFF while `TIFF picture, 3878` sat in the untouched half of the same line.
// The product was correct throughout — NSPasteboard held public.png,
// public.tiff and public.file-url, and the helper's own reply had already
// said so.
//
// NSPasteboard reports the UTIs the product actually sets: StillEncode.swift's
// `.png` / `.tiff` / `.fileURL` are public.png / public.tiff / public.file-url,
// so the test compares against the same names the code writes, with no display
// mapping in between to drift.
//
// It prints EVERY type rather than a filtered set, so a failure message can
// quote the whole pasteboard. The old parse was lossy in a way its own failure
// message could not reveal; splitting this output on newlines is not.
import AppKit

let types = NSPasteboard.general.types?.map(\.rawValue) ?? []
print(types.joined(separator: "\n"))
