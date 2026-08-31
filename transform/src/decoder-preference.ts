/**
 * Which decoder implementation the sinks ask Chromium for.
 *
 * STC-259. On CI, the FIRST touch of a VideoDecoder wedges: the checkpoint
 * trail from run 33384105552 shows all four gates stopping at their first
 * decoder call, within 400-650 ms of page start. Three of them then ran the
 * full 180 s outer bound WITHOUT their own 60 s in-page flush bound ever
 * firing, which means no JS timer could run — the thread was blocked inside the
 * SYNCHRONOUS part of the first decoder use, `VideoDecoder.configure()`. CI
 * reports its video hardware as paravirtualized, a passthrough to a host shared
 * with other tenants, and STC-259 already measured that class of device
 * blocking on first touch from Swift.
 *
 * `configure()` had no `hardwareAcceleration` preference, so Chromium was free
 * to choose that path. This lets a caller ask for software instead.
 *
 * Deliberately NOT threaded through exportSession / loadSession / PreviewPlayer:
 * that would put a gate-only concern into the app's own signatures. It is set
 * at the harness boundary, by a value the RUNNER hands the page, and the app
 * never sets it — so the app keeps hardware decode on real hardware, which is
 * where it matters and where nothing has ever wedged.
 *
 * IT DOES CHANGE THE PRE-ENCODE HASH, and an earlier draft of this comment
 * claimed the opposite. Measured on fixtures/basic: the default path gives
 * 10a05a33…, `prefer-software` gives bc03e397… — the same two values the
 * rasterization pin produces, because forcing either the decoder or the
 * renderer onto the CPU path lands in the same state. H.264 decoding is
 * bit-exact in YUV; what reaches the canvas in RGBA after the browser's colour
 * conversion is not, and that is what gets hashed.
 *
 * That is survivable because of WHAT the gates compare: preview against export,
 * and export against export, always inside ONE browser with one preference. A
 * hash is never compared against a stored constant. The single cross-process
 * comparison, app/test/export-identity.slow.test.ts, pins both sides — and
 * `--disable-gpu` already forces software decode there, so this changes nothing
 * for it.
 */
export type DecoderPreference = "prefer-hardware" | "prefer-software" | "no-preference";

let preference: DecoderPreference | undefined;

/** Undefined means "say nothing", which is Chromium's own default. */
export function setDecoderPreference(p: DecoderPreference | undefined): void {
  preference = p;
}

/** Spread into a VideoDecoderConfig: `{ ...decoderPreference() }`. */
export function decoderPreference(): { hardwareAcceleration?: DecoderPreference } {
  return preference ? { hardwareAcceleration: preference } : {};
}
