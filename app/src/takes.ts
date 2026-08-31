import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where recordings live.
 *
 * Deliberately NOT os.tmpdir(): on macOS that is /var/folders/.../T, which the
 * system purges on boot and sweeps for files untouched for ~3 days. A take is
 * the thing the user made — it is a deliverable, not scratch, and must not sit
 * somewhere it can silently disappear.
 */
export function takesRoot(env: NodeJS.ProcessEnv): string {
  return env.STC_RECORDINGS_DIR || join(homedir(), "Desktop", "stc");
}

function stamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_` +
         `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
}

/**
 * Timestamped so takes sort chronologically by name. `existing` guards the
 * one-second collision: two takes started in the same second must not share a
 * directory, or the second would overwrite the first's display.mp4.
 */
export function newTakeDir(env: NodeJS.ProcessEnv, at: Date = new Date(),
                           existing: string[] = []): string {
  const root = takesRoot(env);
  const base = stamp(at);
  let name = base;
  for (let n = 2; existing.includes(name); n++) name = `${base}-${n}`;
  return join(root, name);
}

import { readdir, stat, readFile, writeFile } from "node:fs/promises";

/** A recording that can be listed, played and exported. */
export interface TakeInfo {
  dir: string;
  name: string;
  recordedAt: number;      // epoch ms
  durationMs: number;
  width: number;
  height: number;
  events: number;
  bytes: number;
  /** User-chosen display name. Never the identity, never the sort key. */
  label?: string;
  /**
   * What the camera actually did, when one was asked for (STC-287).
   *
   * `present: false` with a camera requested is the silent failure: the device
   * opened, wrote no frames, and the take looks camera-less with no reason
   * given. `pipStartsAfterMs` is the gap the viewer sees — the camera opens off
   * the critical path, so the PiP arrives after the picture does, measured at
   * 1.26-1.39 s across five real takes.
   */
  camera?: { present: boolean; device?: string; pipStartsAfterMs: number };
}

export const MAX_LABEL_LENGTH = 120;

/** A directory that looks like a take but is not usable, and why. */
export interface InvalidTake {
  dir: string;
  name: string;
  reason: string;
}

export interface TakeList {
  takes: TakeInfo[];
  invalid: InvalidTake[];
}

/**
 * Undefined when no camera was asked for; otherwise what it did.
 *
 * The helper always writes an `anchors.camera` block — `present: false` when
 * there is no camera — so "no block at all" and "a camera that produced
 * nothing" are different states and must not collapse into one.
 */
function cameraSummary(anchors: any): TakeInfo["camera"] {
  const c = anchors?.camera;
  if (!c || typeof c !== "object") return undefined;
  const gapNs = Number(c.firstFramePtsNs ?? 0) - Number(anchors?.capture?.firstFrameNs ?? 0);
  return {
    present: c.present === true,
    device: typeof c.device === "string" ? c.device : undefined,
    pipStartsAfterMs: c.present === true ? Math.max(0, Math.round(gapNs / 1e6)) : 0,
  };
}

async function dirSize(dir: string, names: string[]): Promise<number> {
  let total = 0;
  for (const n of names) {
    try { total += (await stat(join(dir, n))).size; } catch { /* gone */ }
  }
  return total;
}

/**
 * Anchors document versions this build can read.
 *
 * MUST stay in step with `transform/src/session.ts`. They drifted once: STC-232
 * widened the transform to accept v2 and left this scanner at v1, so once the
 * helper emits v2 (increment 3) every new recording would have been listed as
 * unsupported while the transform loaded it happily — the take library wrong,
 * the transform right, and the two disagreeing about what a recording is.
 *
 * The two cannot share a constant: this runs in the Electron main process and
 * imports only node builtins, while the transform is bundled for the renderer.
 * `app/test/take-list.test.ts` pins them together instead.
 */
const SUPPORTED_ANCHORS_VERSIONS: readonly number[] = [1, 2];

/**
 * Lists recordings, newest first.
 *
 * A broken take is REPORTED, never thrown and never silently skipped. One
 * unreadable directory must not hide the rest of someone's recordings, and a
 * take that quietly vanishes from the list is indistinguishable from one that
 * was deleted.
 */
export async function listTakes(env: NodeJS.ProcessEnv): Promise<TakeList> {
  const root = takesRoot(env);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { takes: [], invalid: [] };   // no recordings folder yet is not an error
  }

  const takes: TakeInfo[] = [];
  const invalid: InvalidTake[] = [];

  for (const name of entries.sort().reverse()) {
    const dir = join(root, name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;   // .DS_Store and friends
    } catch { continue; }

    const fail = (reason: string) => invalid.push({ dir, name, reason });

    let anchors: any;
    try {
      anchors = JSON.parse(await readFile(join(dir, "anchors.json"), "utf8"));
    } catch (e: any) {
      fail(e?.code === "ENOENT" ? "no anchors.json — not a recording"
                                : `anchors.json is unreadable: ${e?.message ?? e}`);
      continue;
    }
    if (!SUPPORTED_ANCHORS_VERSIONS.includes(anchors?.version)) {
      fail(`anchors.json version ${anchors?.version} is not supported`);
      continue;
    }

    let videoBytes: number;
    try {
      videoBytes = (await stat(join(dir, anchors.files?.display ?? "display.mp4"))).size;
      if (videoBytes === 0) { fail("display.mp4 is empty — the recording never started"); continue; }
    } catch {
      fail("display.mp4 is missing — the recording did not complete");
      continue;
    }

    // Events are an overlay, not the recording. A take with a readable video is
    // worth listing and playing even if the cursor track is gone.
    let events = 0;
    try {
      const doc = JSON.parse(await readFile(join(dir, "events.json"), "utf8"));
      events = Array.isArray(doc?.events) ? doc.events.length : 0;
    } catch { /* absent or malformed: 0 */ }

    // A label is decoration. Losing it must never cost the recording, so a
    // corrupt take.json degrades to "no label" rather than invalidating a take.
    let label: string | undefined;
    try {
      const doc = JSON.parse(await readFile(join(dir, "take.json"), "utf8"));
      if (typeof doc?.label === "string" && doc.label.trim()) label = doc.label.trim();
    } catch { /* absent or malformed */ }

    let recordedAt = 0;
    try { recordedAt = (await stat(join(dir, "anchors.json"))).mtimeMs; } catch { /* keep 0 */ }

    takes.push({
      dir, name, recordedAt,
      durationMs: Math.round((anchors.stop?.t ?? 0) / 1e6),
      width: anchors.capture?.width ?? 0,
      height: anchors.capture?.height ?? 0,
      events, label,
      camera: cameraSummary(anchors),
      bytes: await dirSize(dir, await readdir(dir).catch(() => [])),
    });
  }

  // Directory names are timestamps, so name order IS chronological order — and
  // it survives files being copied around, which mtime does not.
  takes.sort((a, b) => b.name.localeCompare(a.name));
  return { takes, invalid };
}

/**
 * Names a take without renaming its directory.
 *
 * The directory name is a timestamp, and it is both the take's identity and the
 * sort key. Renaming it would scramble chronological order, break any open
 * preview, and invalidate paths already handed out for exports — so the label
 * lives beside the recording instead.
 */
export async function setTakeLabel(env: NodeJS.ProcessEnv, dir: string, label: string): Promise<void> {
  const root = takesRoot(env);
  if (!dir.startsWith(root)) throw new Error("refusing to label a directory outside the recordings folder");
  const trimmed = label.trim();
  if (!trimmed) throw new Error("a label cannot be empty");
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new Error(`label is too long (max ${MAX_LABEL_LENGTH} characters)`);
  }
  await writeFile(join(dir, "take.json"), JSON.stringify({ version: 1, label: trimmed }, null, 2));
}
