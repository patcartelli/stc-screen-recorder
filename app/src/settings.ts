import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_ACTIONS, DEFAULT_SHORTCUTS, parseAccelerator, type Shortcuts,
} from "./hotkeys.js";

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
}

export const DEFAULT_SETTINGS: Settings = {
  camera: false, displayId: null, shortcuts: { ...DEFAULT_SHORTCUTS },
};

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
  const clean: Settings = {
    camera: merged.camera === true,
    displayId: cleanDisplayId(merged.displayId),
    shortcuts: cleanShortcuts(merged.shortcuts),
  };
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(clean, null, 2));
  } catch {
    /* preferences are not worth a crash */
  }
  return clean;
}
