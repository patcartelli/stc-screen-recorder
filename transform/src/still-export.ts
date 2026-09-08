import type { StillLayout } from "./still-decorate.js";

/**
 * Every decision a still makes on its way OUT of the app (STC-293), as pure
 * functions over plain data.
 *
 * The ticket's Note is the whole design constraint: "Every path out of the app
 * funnels through here — the thumbnail's drag-out, its ignore-and-save, the
 * editor's export, the right-click copy. One encoder, one filename template,
 * one destination setting; no second implementation hiding in the thumbnail."
 *
 * So the format list, the flatten rule, the scale factor and the filename
 * template live in ONE module that neither the renderer, the main process nor
 * the helper may re-derive. The pieces that genuinely cannot be pure — ImageIO
 * and NSPasteboard — take their instructions from here and decide nothing
 * (`helper/src/StillEncode.swift`).
 *
 * Node-free on purpose: `tsconfig.browser.json` covers `transform/src/`, so a
 * `node:path` import here would make the pure transform node-only and fail the
 * typecheck. Anything that needs the filesystem is expressed as data — a set
 * of names already taken, rather than a directory to read.
 */

// ── formats ────────────────────────────────────────────────────────────────

export type StillFormat = "png" | "heic" | "jpeg";

export const STILL_FORMATS: readonly StillFormat[] = ["png", "heic", "jpeg"];

export interface FormatInfo {
  /** File extension, without the dot. */
  ext: string;
  /** The Uniform Type Identifier ImageIO is handed. */
  uti: string;
  /** Whether the container can carry an alpha channel at all. */
  alpha: boolean;
  /** Whether `quality` means anything. */
  lossy: boolean;
  label: string;
}

/**
 * PNG is the default because it is the only one of the three that is both
 * lossless and universally readable; HEIC keeps alpha at a fraction of the
 * size but is still a coin-flip outside Apple's own apps; JPEG is here because
 * people ask for it, and it is the one that cannot carry the transparency
 * three of the five decoration modes exist to produce.
 */
export const FORMATS: Readonly<Record<StillFormat, FormatInfo>> = {
  png:  { ext: "png",  uti: "public.png",  alpha: true,  lossy: false, label: "PNG" },
  heic: { ext: "heic", uti: "public.heic", alpha: true,  lossy: true,  label: "HEIC" },
  jpeg: { ext: "jpg",  uti: "public.jpeg", alpha: false, lossy: true,  label: "JPEG" },
};

export const DEFAULT_FORMAT: StillFormat = "png";
export const DEFAULT_QUALITY = 0.9;

/** Anything not in the list is not a format; callers get the default, never a guess. */
export function parseFormat(v: unknown): StillFormat {
  return STILL_FORMATS.includes(v as StillFormat) ? (v as StillFormat) : DEFAULT_FORMAT;
}

/** 0..1. A lossless format ignores it, but it is still clamped so it cannot be stored wild. */
export function clampQuality(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : DEFAULT_QUALITY;
}

// ── output scale ───────────────────────────────────────────────────────────

/**
 * "2× / 1× output scale toggle — a Retina capture downscaled to 1× is often
 * what a README actually wants" (STC-293).
 *
 * `native` is the capture's own pixels, whatever the display's backing scale
 * was. `1x` is the same picture at POINT size, so a 2x capture halves and a
 * capture that was already 1x does not move. Expressed against the shot's
 * measured `pxPerPoint` rather than against the literal number 2, because a
 * shot's scale is a property of the display it came from, not a constant.
 */
export type OutputScale = "native" | "1x";

export const OUTPUT_SCALES: readonly OutputScale[] = ["native", "1x"];

export function parseScale(v: unknown): OutputScale {
  return OUTPUT_SCALES.includes(v as OutputScale) ? (v as OutputScale) : "native";
}

/**
 * Never greater than 1: this toggle only ever makes the output smaller.
 *
 * Upscaling a capture to hit a nominal "2×" would invent detail that was never
 * photographed, which is the one thing a screenshot tool must not do — and on
 * a non-Retina display `pxPerPoint` is 1, so a naive `2 / pxPerPoint` would do
 * exactly that.
 */
export function scaleFactor(scale: OutputScale, pxPerPoint: number): number {
  if (scale === "native") return 1;
  if (!(pxPerPoint > 0) || !Number.isFinite(pxPerPoint)) return 1;
  return Math.min(1, 1 / pxPerPoint);
}

/**
 * The layout at a different output scale.
 *
 * CLAUDE.md records that nothing in the still path resamples the capture, and
 * that this is load-bearing rather than tidy. This is the ONE deliberate
 * exception, and it is exempt for the reason the rule exists: the rule forbids
 * an INCIDENTAL resample — a half-pixel content offset, a canvas preset that
 * quietly rescales — because those degrade the image without anybody asking.
 * A 1× export is the user asking, in as many words, for a smaller picture.
 *
 * It is done by scaling the LAYOUT rather than the finished canvas, so the
 * capture is resampled exactly once (in the `drawImage` that places it) while
 * the background, the padding and the shadow are drawn at the output's own
 * size and are never resampled at all. Downscaling the composited canvas
 * instead would put a second resample over everything, including the blurred
 * shadow, for no gain.
 *
 * `pxPerPoint` moves with the factor so the cursor artwork, which is drawn in
 * points, stays the same physical size relative to the content.
 */
export function scaleStillLayout(layout: StillLayout, factor: number): StillLayout {
  if (!(factor > 0) || !Number.isFinite(factor) || factor === 1) return layout;
  const px = (n: number) => Math.round(n * factor);
  const out: StillLayout = {
    canvas: { width: Math.max(1, px(layout.canvas.width)), height: Math.max(1, px(layout.canvas.height)) },
    content: {
      x: px(layout.content.x), y: px(layout.content.y),
      width: Math.max(1, px(layout.content.width)), height: Math.max(1, px(layout.content.height)),
    },
    alpha: layout.alpha,
    redactions: layout.redactions.map((r) => ({
      x: r.x * factor, y: r.y * factor, width: r.width * factor, height: r.height * factor,
    })),
  };
  if (layout.shadow) {
    out.shadow = {
      offsetX: layout.shadow.offsetX * factor,
      offsetY: layout.shadow.offsetY * factor,
      blur: layout.shadow.blur * factor,
      spread: layout.shadow.spread * factor,
      opacity: layout.shadow.opacity,
    };
  }
  if (layout.background) out.background = layout.background;
  if (layout.cursor) {
    out.cursor = {
      x: layout.cursor.x * factor,
      y: layout.cursor.y * factor,
      shape: layout.cursor.shape,
      pxPerPoint: layout.cursor.pxPerPoint * factor,
    };
  }
  return out;
}

// ── alpha meeting a format that has none ───────────────────────────────────

/**
 * "Choosing JPEG while in a transparent mode must say what will happen —
 * flatten onto a chosen colour, or switch format — never silently fill black"
 * (STC-293).
 *
 * Silently filling black is the default behaviour of almost every encoder in
 * this situation, and it is the worst possible one: a window shot with a
 * shadow, flattened onto black, looks like a rendering fault rather than a
 * format limitation, and the user has no way to tell which it was.
 *
 * So the decision is made HERE and returned to the caller unresolved. A
 * `conflict` plan is not something the export path may act on: the UI has to
 * put both options to the user and come back with one of them. That is what
 * "having said so first" in the acceptance list means — the warning is not a
 * toast printed after the fact, it is a fork the export waits on.
 */
export type FlattenPlan =
  /** The format carries alpha, or there was none to carry. Nothing to say. */
  | { kind: "none" }
  /** The user has chosen: composite onto `color`, then encode without alpha. */
  | { kind: "flatten"; color: string }
  /** Unresolved. `message` is what to show; `suggestFormat` is the other way out. */
  | { kind: "conflict"; message: string; suggestFormat: StillFormat; defaultColor: string };

/**
 * White, not black.
 *
 * A transparent shot is nearly always destined for a light document — a
 * README, a slide, a portfolio page — and white is the one flat colour that
 * reads as "no background" rather than as a deliberate dark panel. It is a
 * default and not a rule: the caller supplies a colour, and this is what it
 * gets when nobody has chosen.
 */
export const DEFAULT_FLATTEN_COLOR = "#ffffff";

export function flattenPlan(hasAlpha: boolean, format: StillFormat,
                            chosenColor?: string): FlattenPlan {
  if (!hasAlpha || FORMATS[format].alpha) return { kind: "none" };
  if (chosenColor) return { kind: "flatten", color: chosenColor };
  return {
    kind: "conflict",
    message: `${FORMATS[format].label} cannot carry transparency. `
      + "This shot has a transparent background, so it has to be flattened onto "
      + "a solid colour — or saved as PNG or HEIC, which keep it.",
    suggestFormat: "png",
    defaultColor: DEFAULT_FLATTEN_COLOR,
  };
}

// ── the filename template ──────────────────────────────────────────────────

/**
 * The tokens a template may use. Named in the ticket: date, time, the app name
 * of the captured window, and an incrementing counter. The rest are here
 * because they cost nothing and are the next things anybody wants.
 */
export const FILENAME_TOKENS = [
  "date", "time", "app", "title", "counter", "width", "height", "mode",
] as const;
export type FilenameToken = typeof FILENAME_TOKENS[number];

export type FilenameTokens = Partial<Record<FilenameToken, string | number>>;

/**
 * `{app}` first, the way macOS's own screenshots lead with what the picture is
 * of. A region shot has no app, and `tokensFor` gives it "Screen" rather than
 * leaving a hole, so the default never renders to a name starting with a space.
 */
export const DEFAULT_FILENAME_TEMPLATE = "{app} {date} at {time}";

/**
 * Characters that cannot survive a macOS filename.
 *
 * `/` is the path separator; `:` is the CLASSIC path separator and Finder
 * still displays a `:` in a name as `/`, so a title containing either would
 * produce a file whose name in Finder is not the name on disk. Control
 * characters are stripped because a filename is shown in a dozen places that
 * do not expect them, and NUL would truncate the name at the syscall.
 */
function sanitizeSegment(s: string): string {
  return s
    .replace(/[/:\\]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How long a stem may be. HFS+/APFS allow 255 BYTES; a wide character is up to 4. */
export const MAX_STEM_LENGTH = 60;

/** What a template that renders to nothing usable falls back to. */
export const FALLBACK_STEM = "Shot";

/**
 * Renders a template to a filename STEM — no extension, no directory.
 *
 * An unknown token is left alone rather than dropped: `{sequence}` in a
 * hand-edited setting should look wrong in the resulting filename, so the user
 * can see what they typed, instead of silently vanishing and leaving them to
 * wonder which of their tokens the app understood.
 */
export function renderTemplate(template: string, tokens: FilenameTokens): string {
  const raw = template.replace(/\{([a-z]+)\}/g, (whole, name: string) => {
    const known = (FILENAME_TOKENS as readonly string[]).includes(name);
    if (!known) return whole;
    const v = tokens[name as FilenameToken];
    return v === undefined || v === null ? "" : String(v);
  });
  let stem = sanitizeSegment(raw);
  // A leading dot makes the file invisible in Finder, which for something the
  // user just asked to save is indistinguishable from it not having been saved.
  stem = stem.replace(/^\.+/, "").trim();
  if (stem.length > MAX_STEM_LENGTH) stem = stem.slice(0, MAX_STEM_LENGTH).trim();
  return stem.length > 0 ? stem : FALLBACK_STEM;
}

/** `2026-09-08`, in LOCAL time: the user's idea of when they took the shot. */
export function dateToken(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/** `14-23-05`. Dots or colons would be a second extension or a path separator. */
export function timeToken(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
}

/**
 * A name nothing in `taken` already uses.
 *
 * The suffix loop runs even when the template carries `{counter}`, and that is
 * deliberate belt-and-braces: a counter derived from a directory listing is
 * correct only until two exports race or the user deletes a file in the
 * middle, and "collision-free" in the acceptance list has to hold for the name
 * actually written, not for the one that was computed. The counter is for
 * legibility; this is for correctness.
 *
 * `taken` is a set of full file names, so the caller decides whether that
 * means "what is in the folder" or "what this batch has already claimed" —
 * both are real, and neither belongs in a pure function.
 */
export function uniqueFileName(stem: string, ext: string, taken: ReadonlySet<string>): string {
  const first = `${stem}.${ext}`;
  if (!taken.has(first)) return first;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem}-${n}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Ten thousand files with one stem is not a situation to paper over with a
  // random suffix that makes the next collision someone else's problem.
  throw new Error(`could not find an unused name for "${stem}.${ext}"`);
}

// ── metadata ───────────────────────────────────────────────────────────────

/**
 * What "strip metadata" strips, and what it must not.
 *
 * The ticket asks for an optional strip "since a shot of a screen can carry
 * the display's colour profile and a capture timestamp". Those two are not the
 * same kind of thing and must not share a switch:
 *
 * - The capture TIMESTAMP is metadata. It says when the user was at their
 *   desk, it travels with the file, and stripping it is a reasonable thing to
 *   want before sending a screenshot to a stranger.
 * - The colour PROFILE is not metadata. It is what makes the numbers in the
 *   file mean colours. Strip it from a Display P3 capture and every viewer
 *   falls back to sRGB, which is a visible shift — precisely the failure the
 *   acceptance list's "preserves the wide-gamut colours of a P3 display
 *   capture without a visible shift" forbids.
 *
 * So the profile is always embedded and `stripMetadata` governs the rest.
 */
export interface MetadataPlan {
  /** ICC profile name, always embedded. */
  colorSpace: StillColorSpace;
  /** ISO 8601 local time, or absent when stripping. */
  capturedAt?: string;
}

/**
 * The colour spaces a still can be tagged with.
 *
 * Kept to the two that a Mac display actually is, rather than the full ICC
 * zoo: anything else is a profile this app has no way to have produced, and
 * accepting a name it cannot honour would tag a file with a lie.
 */
export type StillColorSpace = "srgb" | "display-p3";

export const STILL_COLOR_SPACES: readonly StillColorSpace[] = ["srgb", "display-p3"];

/**
 * The shot's own display profile, mapped onto what a canvas and ImageIO can
 * both name. `shot.display.colorSpace` is whatever CoreGraphics called it —
 * `kCGColorSpaceDisplayP3`, `kCGColorSpaceSRGB`, and on some displays a name
 * neither of those. Anything that is not recognisably P3 is treated as sRGB,
 * because sRGB is the safe wrong answer: a P3 image shown as sRGB is
 * oversaturated, an sRGB image tagged P3 is washed out, and the second is the
 * one that happens on every viewer rather than only on wide-gamut ones.
 */
export function colorSpaceFor(displayColorSpace: string | undefined): StillColorSpace {
  return displayColorSpace && /p3/i.test(displayColorSpace) ? "display-p3" : "srgb";
}

export function metadataPlan(colorSpace: StillColorSpace, at: Date,
                             strip: boolean): MetadataPlan {
  return strip ? { colorSpace } : { colorSpace, capturedAt: at.toISOString() };
}

// ── the whole plan ─────────────────────────────────────────────────────────

export interface ExportOptions {
  format: StillFormat;
  quality: number;
  scale: OutputScale;
  stripMetadata: boolean;
  template: string;
  /** Set once the user has resolved a `conflict`; absent means "not asked yet". */
  flattenColor?: string;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: DEFAULT_FORMAT,
  quality: DEFAULT_QUALITY,
  scale: "native",
  stripMetadata: false,
  template: DEFAULT_FILENAME_TEMPLATE,
};

/**
 * What the RENDERER needs: everything about the pixels.
 *
 * Split from the filename half deliberately. The composite happens in a
 * renderer that has a canvas and no filesystem; the name is chosen in the main
 * process, which has a directory listing and no canvas. Neither half can
 * compute the other's, and a single `planExport` would have forced one of them
 * to be assembled by hand on the far side of an IPC boundary — which is the
 * "fourth caller assembled a project outside parseProject" trap in CLAUDE.md,
 * waiting to happen a fifth time.
 */
export interface RenderPlan {
  format: StillFormat;
  quality: number;
  /** The layout to render, already at the output scale. */
  layout: StillLayout;
  factor: number;
  flatten: FlattenPlan;
  /** True only when the encoded file will genuinely carry an alpha channel. */
  alpha: boolean;
}

export function planRender(opts: ExportOptions,
                           inputs: { layout: StillLayout; pxPerPoint: number }): RenderPlan {
  const format = parseFormat(opts.format);
  const factor = scaleFactor(parseScale(opts.scale), inputs.pxPerPoint);
  const layout = scaleStillLayout(inputs.layout, factor);
  const flatten = flattenPlan(layout.alpha, format, opts.flattenColor);
  // All three conditions, because any one of them alone has been the wrong
  // answer at some point on this path: the layout may have no alpha to keep,
  // the container may not carry one, and the user may have chosen to fill it.
  const alpha = layout.alpha && FORMATS[format].alpha && flatten.kind !== "flatten";
  return { format, quality: clampQuality(opts.quality), layout, factor, flatten, alpha };
}

/** True while the plan is waiting on the user. Encoding one of these is the bug. */
export function stillIsBlocked(plan: RenderPlan): boolean {
  return plan.flatten.kind === "conflict";
}

/**
 * What the MAIN PROCESS needs: the name to write under.
 *
 * `taken` is supplied rather than read, so this stays node-free and so the
 * caller decides whether it means "what is in the folder" or "what this batch
 * has already claimed". Both are real situations and neither belongs in here.
 */
export function planFileName(opts: ExportOptions,
                             inputs: { tokens: FilenameTokens; taken: ReadonlySet<string> }): string {
  const stem = renderTemplate(opts.template ?? DEFAULT_FILENAME_TEMPLATE, inputs.tokens);
  return uniqueFileName(stem, FORMATS[parseFormat(opts.format)].ext, inputs.taken);
}

/**
 * The tokens for a shot, so no caller assembles them by hand.
 *
 * The fourth-caller trap in CLAUDE.md is about exactly this: a hand-rolled
 * object cannot know the defaults the real one applies, and the fifth caller
 * always appears. `{app}` falling back to "Screen" for a region shot is the
 * kind of thing that would otherwise be right in one place and missing in the
 * next.
 */
export function tokensFor(info: {
  app?: string; title?: string; width: number; height: number;
  mode: string; counter?: number;
}, at: Date): FilenameTokens {
  return {
    date: dateToken(at),
    time: timeToken(at),
    app: info.app && info.app.trim() ? info.app.trim() : "Screen",
    title: info.title && info.title.trim() ? info.title.trim() : "",
    width: info.width,
    height: info.height,
    mode: info.mode,
    counter: info.counter ?? 1,
  };
}
