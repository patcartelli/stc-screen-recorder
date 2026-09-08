import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_ACTIONS, DEFAULT_SHORTCUTS, parseAccelerator, type Shortcuts,
} from "./hotkeys.js";
import {
  DEFAULT_EXPORT_OPTIONS, DEFAULT_FILENAME_TEMPLATE, clampQuality, parseFormat, parseScale,
  type ExportOptions,
} from "@transform/still-export.js";
import {
  DEFAULT_CORNER, DEFAULT_THUMBNAIL_TIMEOUT_MS, clampTimeoutMs, parseCorner, parseSettleAction,
  type Corner, type SettleAction,
} from "./thumbnail.js";

/**
 * User preferences, owned by the main process.
 *
 * The camera preference decides whether a physical camera LED comes on, so it
 * is not the renderer's to hold: the renderer proposes a change, main stores it
 * and is the single source of truth when `start` is issued. That also keeps the
 * flag out of the IPC payload for `recorder:start`, where it would be a second
 * place the answer could come from.
 *
 * Electron-free on purpose — it takes a directory rather than calling
 * `app.getPath("userData")` — so it is testable without launching an app, the
 * same arrangement HelperClient and HelperSupervisor use.
 */

export interface Settings {
  /** Opt-in, default off, sticky (camera PiP design spec). */
  camera: boolean;
  /**
   * Which display to record (STC-247), as the helper's CGDirectDisplayID, or
   * null for "whichever the helper lists first" — the phase-1 behaviour and
   * the only one a single-display machine ever sees. Sticky, like the camera:
   * a picked display stays picked across launches. If that display is gone at
   * `start`, the helper refuses with `display-not-found` rather than quietly
   * recording another one; the UI shows the stale choice as such.
   */
  displayId: number | null;
  /**
   * The global capture shortcuts (STC-292), as Electron accelerators. `null`
   * for an action the user deliberately unbound — which is a preference like
   * any other, and must survive a restart rather than springing back to the
   * default the next time the file is read.
   */
  shortcuts: Shortcuts;
  /**
   * Whether a completed still capture makes the system shutter noise
   * (STC-292). On by default, because macOS's own screenshot does.
   *
   * It only ever SILENCES: with this ticked the sound still follows the Mac's
   * "Play user interface sound effects" setting and its alert volume. There is
   * no combination that makes a noise the system was told not to make.
   */
  shutterSound: boolean;
  /**
   * How a still leaves the app (STC-293), and the one place those answers
   * live. The ticket's Note: "One encoder, one filename template, one
   * destination setting; no second implementation hiding in the thumbnail."
   * The post-capture thumbnail (STC-296) reads THIS, and so does the preview's
   * frame grab — neither carries its own default.
   */
  still: StillSettings;
  /**
   * The post-capture floating thumbnail (STC-296) — where it sits, how long it
   * waits, and what "ignoring it" does. Its own block rather than folded into
   * `still`, because these answer "what happens to the panel", not "what does
   * an export look like" — `still` is read from inside the panel same as
   * everywhere else, never duplicated by it.
   */
  thumbnail: ThumbnailSettings;
}

export interface ThumbnailSettings {
  corner: Corner;
  /** Milliseconds; never below `MIN_THUMBNAIL_TIMEOUT_MS` (thumbnail.ts). */
  timeoutMs: number;
  /** What an ignored (timed-out) or explicitly closed panel does with the shot. */
  settleAction: SettleAction;
  /**
   * "Some days you take twenty shots and want none of this" (the ticket's own
   * words). When set, a capture never shows the panel at all and goes straight
   * to the clipboard — the one settle action that needs no destination folder
   * and leaves nothing for the user to clean up.
   */
  skip: boolean;
}

export const DEFAULT_THUMBNAIL_SETTINGS: ThumbnailSettings = {
  corner: DEFAULT_CORNER, timeoutMs: DEFAULT_THUMBNAIL_TIMEOUT_MS, settleAction: "save", skip: false,
};

export interface StillSettings extends ExportOptions {
  /**
   * Where saves go, or null for "beside the shot, in its own take directory".
   *
   * Null rather than a hardcoded ~/Desktop: a still that has not been given a
   * home belongs with the `shot.json` it was rendered from, which is the one
   * place it can never be orphaned from its source. A user who picks a folder
   * gets that folder; nobody gets a surprise.
   */
  destination: string | null;
}

export const DEFAULT_STILL_SETTINGS: StillSettings = {
  ...DEFAULT_EXPORT_OPTIONS,
  destination: null,
};

export const DEFAULT_SETTINGS: Settings = {
  camera: false, displayId: null, shortcuts: { ...DEFAULT_SHORTCUTS },
  shutterSound: true,
  still: { ...DEFAULT_STILL_SETTINGS },
  thumbnail: { ...DEFAULT_THUMBNAIL_SETTINGS },
};

/**
 * Never throws, and never half-trusts.
 *
 * Each field is validated on its own terms — an unknown format becomes the
 * default rather than reaching ImageIO as a string it will refuse, and a
 * destination that is not an absolute path is treated as unset rather than
 * resolved against whatever the process's working directory happens to be.
 * `flattenColor` is deliberately NOT persisted with a default: it is the
 * answer to a question the user was asked (STC-293's "having said so first"),
 * and a stored default would silently answer it for them next time.
 */
function cleanStill(v: unknown): StillSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const template = typeof d.template === "string" && d.template.trim()
    ? d.template : DEFAULT_FILENAME_TEMPLATE;
  const destination = typeof d.destination === "string" && d.destination.startsWith("/")
    ? d.destination : null;
  return {
    format: parseFormat(d.format),
    quality: clampQuality(d.quality),
    scale: parseScale(d.scale),
    stripMetadata: d.stripMetadata === true,
    template,
    destination,
  };
}

/**
 * Same rule as every other block here: an unknown shape falls back whole, and
 * each field is validated on its own terms rather than half-trusted.
 */
function cleanThumbnail(v: unknown): ThumbnailSettings {
  const d = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return {
    corner: parseCorner(d.corner),
    timeoutMs: clampTimeoutMs(d.timeoutMs),
    settleAction: parseSettleAction(d.settleAction),
    skip: d.skip === true,
  };
}

/** A display id is a positive integer; anything else is "automatic". */
function cleanDisplayId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * A stored binding is trusted only as far as it still parses.
 *
 * Absent means "never set" and takes the default; explicit `null` means
 * unbound and is kept. Anything else that no longer parses — a hand-edited
 * file, or a binding written by a version with a different grammar — falls
 * back to the default rather than to nothing, on the same rule as every other
 * field here: a corrupt preferences file must not silently cost the user the
 * feature.
 */
function cleanShortcuts(v: unknown): Shortcuts {
  const raw = (v && typeof v === "object" && !Array.isArray(v))
    ? v as Record<string, unknown> : {};
  const out = {} as Shortcuts;
  for (const action of CAPTURE_ACTIONS) {
    const stored = raw[action];
    if (stored === null) { out[action] = null; continue; }
    const parsed = typeof stored === "string" ? parseAccelerator(stored) : undefined;
    // Stored NORMALISED, so what preferences shows and what the menu bar draws
    // is the same string the registration used.
    out[action] = parsed?.ok ? parsed.accelerator : DEFAULT_SHORTCUTS[action];
  }
  return out;
}

const FILE = "settings.json";

/**
 * Never throws.
 *
 * A corrupt or unreadable preferences file must not cost a recording — the same
 * rule `parseProject` follows for a mangled project.json. An unknown shape is
 * treated as absent rather than half-trusted, so one bad field cannot smuggle
 * itself in as a preference.
 */
export function readSettings(dir: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const doc = raw as Record<string, unknown>;
  return {
    camera: typeof doc.camera === "boolean" ? doc.camera : DEFAULT_SETTINGS.camera,
    displayId: cleanDisplayId(doc.displayId),
    shortcuts: cleanShortcuts(doc.shortcuts),
    shutterSound: typeof doc.shutterSound === "boolean"
      ? doc.shutterSound : DEFAULT_SETTINGS.shutterSound,
    still: cleanStill(doc.still),
    thumbnail: cleanThumbnail(doc.thumbnail),
  };
}

/**
 * Merges `patch` over what is stored and writes the result. Also never throws:
 * a preference is not worth crashing the app over, and the in-memory value the
 * caller just set still applies for this session.
 *
 * Only known keys are written, so a typo cannot quietly persist a field nothing
 * reads and turn the file into a place wrong things accumulate.
 */
export function writeSettings(dir: string, patch: Partial<Settings>): Settings {
  const current = readSettings(dir);
  // `still` is merged one level deeper than the rest: a caller changing only
  // the format must not drop the destination folder the user chose months ago.
  // A shallow spread would, and the shape of that bug is a preference that
  // resets whenever an unrelated one is touched.
  const merged: Settings = {
    ...current, ...patch,
    still: { ...current.still, ...(patch.still ?? {}) },
    thumbnail: { ...current.thumbnail, ...(patch.thumbnail ?? {}) },
  };
  const clean: Settings = {
    camera: merged.camera === true,
    displayId: cleanDisplayId(merged.displayId),
    shortcuts: cleanShortcuts(merged.shortcuts),
    still: cleanStill(merged.still),
    thumbnail: cleanThumbnail(merged.thumbnail),
    // Not `=== true`: the default is ON, so an absent or malformed value must
    // fall back to on rather than to silence. The camera's `=== true` is the
    // opposite case for the opposite reason — it defaults off because it turns
    // on a physical LED.
    shutterSound: merged.shutterSound !== false,
  };
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(clean, null, 2));
  } catch {
    /* preferences are not worth a crash */
  }
  return clean;
}
