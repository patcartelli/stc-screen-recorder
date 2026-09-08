import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FLATTEN_COLOR, FORMATS, clampQuality, colorSpaceFor, metadataPlan, parseFormat,
  parseScale, planFileName, tokensFor,
  type ExportOptions, type StillColorSpace,
} from "@transform/still-export.js";
import type { StillSettings } from "./settings.js";

/**
 * The single funnel every still takes out of the app (STC-293).
 *
 * The ticket's Note is the specification: "Every path out of the app funnels
 * through here — the thumbnail's drag-out, its ignore-and-save, the editor's
 * export, the right-click copy. One encoder, one filename template, one
 * destination setting; no second implementation hiding in the thumbnail."
 *
 * So `exportStill` is the only function in the main process that writes an
 * image or touches the pasteboard, and every caller — the still panel, the
 * preview's frame grab, and the floating thumbnail when it arrives — reaches
 * the disk and the clipboard through it and nowhere else.
 *
 * Electron-free on purpose, the same arrangement `settings.ts` and
 * `helper-client.ts` have: it takes a `sendExport` function and a directory
 * rather than importing `app` or `clipboard`, so the whole thing is testable
 * without launching an app or having a Mac.
 *
 * ## Why the pixels go through a file
 *
 * A 4K decorated still is ~33 MB of RGBA and a 6K one is over 80. The helper's
 * reliable channel (fd3) is deliberately for small messages — CLAUDE.md, "never
 * let stats back-pressure the capture graph" — and base64 in a JSON line would
 * be a third larger again and would hold that channel for the duration of the
 * encode. A still taken during a recording must not be able to delay a `stop`.
 * So the bytes land in a temp file, the helper is told where, and the file is
 * removed whatever happens.
 */

/** What the renderer hands over: the composited pixels and what they mean. */
export interface CompositedStill {
  /** RGBA8, unpremultiplied, top row first — a canvas `getImageData` buffer. */
  bytes: ArrayBuffer;
  width: number;
  height: number;
  /** Whether the pixels carry meaningful alpha, from the render plan. */
  alpha: boolean;
  colorSpace: StillColorSpace;
}

/** Where the still is going. Both is normal: a copy also wants a real file. */
export interface ExportTarget {
  file: boolean;
  clipboard: boolean;
}

export interface ExportRequest {
  still: CompositedStill;
  target: ExportTarget;
  options: ExportOptions;
  /** Fills the filename template. */
  info: { app?: string; title?: string; mode: string };
  /**
   * Where to save when the user has not chosen a destination folder — the
   * shot's own directory. Absent for a caller that has no take of its own.
   */
  fallbackDir?: string;
  at?: Date;
}

export interface ExportResult {
  file?: string;
  bytes?: number;
  clipboard?: string[];
  width: number;
  height: number;
  format: string;
  alpha: boolean;
  /** Whether the encoder had to fall back to a premultiplied bitmap layout. */
  premultiplied?: boolean;
  metadata?: string;
}

/** The helper call, injected so this module never imports the supervisor. */
export type SendExport = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * A copy with no save still needs a real file, for the pasteboard's file URL.
 *
 * It goes to a cache directory rather than beside the shot, because a user who
 * pressed Copy did not ask for a file and should not find one accumulating in
 * their shots folder every time they paste. The pasteboard holds a reference to
 * it for as long as the copy is live, so it is deliberately NOT cleaned up here
 * — deleting it would turn a working paste into a broken one, and the OS clears
 * this directory on its own schedule.
 */
export const CLIPBOARD_SUBDIR = "stc-clipboard";

/**
 * Where the encoded file goes.
 *
 * A SAVE goes where the user said: the chosen destination folder, or — while
 * they have not chosen one — the shot's own directory, which is the one place
 * a still can never be orphaned from the `shot.json` it came from.
 *
 * A COPY that is not also a save goes to the cache, always, whatever the
 * destination setting says. It only exists because the pasteboard's file URL
 * has to point at something real; the user asked for a clipboard, not a file,
 * and one appearing in their shots folder on every ⌘C would be the app
 * inventing work for them to tidy up.
 *
 * Resolved here rather than in the renderer because it is a filesystem answer,
 * and because it must be the SAME answer for every caller — a thumbnail that
 * resolved its own default is the second implementation the Note forbids.
 */
export function destinationDir(settings: Pick<StillSettings, "destination">,
                               target: ExportTarget,
                               fallbackDir: string | undefined,
                               cacheRoot: string): string {
  if (!target.file) return join(cacheRoot, CLIPBOARD_SUBDIR);
  if (settings.destination) return settings.destination;
  if (fallbackDir) return fallbackDir;
  return join(cacheRoot, CLIPBOARD_SUBDIR);
}

/**
 * What is already in `dir`, for the collision check.
 *
 * A directory that does not exist yet is empty, not an error: a destination
 * folder the user picked and later deleted, or a cache directory on first run,
 * are both normal and neither is a reason to refuse the export. The helper
 * creates the directory when it writes.
 */
export async function namesIn(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

/**
 * What a caller may decide about one export, and what only the stored
 * preference decides.
 *
 * Built field by field rather than by spreading `{ ...stored, ...requested }`,
 * so what a caller can influence is a LIST rather than whatever it happened to
 * send. The renderer is handed the settings to populate its controls and sends
 * them back, so a spread quietly let it choose the destination folder too —
 * which is the one thing a sandboxed renderer must never choose, because it
 * decides where the main process writes.
 *
 * The TEMPLATE is overridable and the rest of the preference is not, and that
 * distinction is deliberate. The stored template is the default NAME for a
 * still, not a rule that every artifact must be named that way: the preview's
 * frame grab names its file after the take and the millisecond it came from,
 * which no user-authored template can express (there is no position token),
 * and forcing the stored one on it destroys that information. "One filename
 * template" is about there being one SETTING and one renderer — `renderTemplate`
 * plus `uniqueFileName` — which an overriding caller still goes through.
 *
 * This lives here rather than inside main's IPC handler because a closure in
 * `ipcMain.handle` is unreachable from any test, and the first version of it
 * shipped with the template pinned to the stored one — which renamed every
 * saved frame and was caught by an E2E assertion rather than by anything that
 * could say why.
 */
export function resolveExportOptions(stored: StillSettings,
                                     requested: Partial<ExportOptions> | undefined): ExportOptions {
  const template = typeof requested?.template === "string" && requested.template.trim()
    ? requested.template : stored.template;
  return {
    format: parseFormat(requested?.format ?? stored.format),
    quality: clampQuality(requested?.quality ?? stored.quality),
    scale: parseScale(requested?.scale ?? stored.scale),
    template,
    // Never the caller's: the strip is a privacy preference, and a caller that
    // could turn it off would silently re-attach a timestamp the user asked to
    // have withheld.
    stripMetadata: stored.stripMetadata === true,
    ...(requested?.flattenColor ? { flattenColor: requested.flattenColor } : {}),
  };
}

/**
 * Encode a composited still and put it where it was asked to go.
 *
 * Answers with what actually happened rather than with what was requested:
 * which representations the pasteboard took, whether the bitmap needed the
 * premultiplied fallback, whether the timestamp was kept. Each of those is a
 * thing this code cannot check from the machine it was written on, so the reply
 * carries the observation instead of the runbook carrying an assumption.
 */
export async function exportStill(send: SendExport, req: ExportRequest,
                                  settings: StillSettings,
                                  cacheRoot: string): Promise<ExportResult> {
  if (!req.target.file && !req.target.clipboard) {
    throw new Error("an export needs somewhere to go: a file, the clipboard, or both");
  }
  const at = req.at ?? new Date();
  const dir = destinationDir(settings, req.target, req.fallbackDir, cacheRoot);
  // Listed ONCE and used for both the counter and the collision check: two
  // reads could disagree, and a filename whose counter came from a different
  // listing than its uniqueness check is exactly the kind of nearly-right that
  // survives every test and collides in the wild.
  const taken = await namesIn(dir);
  const name = planFileName(req.options, {
    tokens: tokensFor({
      ...req.info,
      width: req.still.width, height: req.still.height,
      // What is already there plus one, so it reads as "the 4th shot today"
      // rather than as a random suffix. Uniqueness does not REST on it —
      // `planFileName` re-checks against `taken` — because a counter derived
      // from a listing is correct only until two exports race.
      counter: taken.size + 1,
    }, at),
    taken,
  });

  // A copy always writes a file too, so the pasteboard's file URL points at
  // something real. A save-only export never touches the clipboard.
  const wantsFile = req.target.file || req.target.clipboard;
  const meta = metadataPlan(req.still.colorSpace, at, settings.stripMetadata === true);

  const scratch = await mkdtemp(join(tmpdir(), "stc-still-"));
  const rgba = join(scratch, "composite.rgba");
  try {
    await writeFile(rgba, Buffer.from(req.still.bytes));
    const reply = await send({
      rgba,
      width: req.still.width,
      height: req.still.height,
      alpha: req.still.alpha,
      colorSpace: meta.colorSpace,
      format: req.options.format,
      quality: req.options.quality,
      ...(wantsFile ? { file: join(dir, name) } : {}),
      clipboard: req.target.clipboard === true,
      // Absent means stripped. The colour PROFILE is not covered by this and
      // is embedded either way — it is what makes the numbers mean colours,
      // not a fact about when the user was at their desk.
      ...(meta.capturedAt ? { capturedAt: meta.capturedAt } : {}),
    });
    return {
      width: Number(reply.width ?? req.still.width),
      height: Number(reply.height ?? req.still.height),
      format: String(reply.format ?? req.options.format),
      alpha: reply.alpha === true,
      ...(reply.file ? { file: String(reply.file) } : {}),
      ...(typeof reply.bytes === "number" ? { bytes: reply.bytes } : {}),
      ...(Array.isArray(reply.clipboard) ? { clipboard: reply.clipboard as string[] } : {}),
      ...(typeof reply.premultiplied === "boolean" ? { premultiplied: reply.premultiplied } : {}),
      ...(typeof reply.metadata === "string" ? { metadata: reply.metadata } : {}),
    };
  } finally {
    // The scratch copy is 33 MB and has no reason to outlive the encode, on
    // the failure path least of all.
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The colour space to render and tag with, from the shot's display.
 *
 * Re-exported through here so the main process and the renderer agree without
 * either re-deriving it: `shot.display.colorSpace` is whatever CoreGraphics
 * called it, and deciding "is that P3?" in two places is how one of them ends
 * up tagging a wide-gamut capture as sRGB.
 */
export { colorSpaceFor, DEFAULT_FLATTEN_COLOR, FORMATS };
