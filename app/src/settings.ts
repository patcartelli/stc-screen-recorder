import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}

export const DEFAULT_SETTINGS: Settings = { camera: false };

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
  const merged: Settings = { ...readSettings(dir), ...patch };
  const clean: Settings = { camera: merged.camera === true };
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(clean, null, 2));
  } catch {
    /* preferences are not worth a crash */
  }
  return clean;
}
