import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_EXPORT_OPTIONS, DEFAULT_FILENAME_TEMPLATE, clampQuality, parseFormat, parseScale,
  type ExportOptions,
} from "@transform/still-export.js";

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
   * How a still leaves the app (STC-293), and the one place those answers
   * live. The ticket's Note: "One encoder, one filename template, one
   * destination setting; no second implementation hiding in the thumbnail."
   * The post-capture thumbnail (STC-296) reads THIS, and so does the preview's
   * frame grab — neither carries its own default.
   */
  still: StillSettings;
}

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
  camera: false,
  displayId: null,
  still: { ...DEFAULT_STILL_SETTINGS },
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

/** A display id is a positive integer; anything else is "automatic". */
function cleanDisplayId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
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
    still: cleanStill(doc.still),
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
  };
  const clean: Settings = {
    camera: merged.camera === true,
    displayId: cleanDisplayId(merged.displayId),
    still: cleanStill(merged.still),
  };
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(clean, null, 2));
  } catch {
    /* preferences are not worth a crash */
  }
  return clean;
}
