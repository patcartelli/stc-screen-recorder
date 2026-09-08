import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { takesRoot } from "./takes.js";
import { parseShot, type Shot } from "@transform/shot.js";
import {
  recordingItem, stillItem, applyFilter, LIBRARY_FILTERS, DEFAULT_LIBRARY_FILTER,
  THUMBNAIL_FILE, SUPPORTED_ANCHORS_VERSIONS,
  type InvalidItem, type LibraryList, type StillInfo, type TakeInfo, type TakeList,
} from "./library-items.js";

// Re-exported so callers have one import for the library, not two.
export * from "./library-items.js";

/**
 * The library's one index, over both kinds of take (STC-294).
 *
 * ## Why this file exists
 *
 * A still is its own format (`shot-1`, STC-289) and a recording is what it has
 * always been. The ticket's constraint is that this stays ONE storage root and
 * ONE index: *"two formats is a decision; two libraries is not."* So the two
 * kinds meet here and nowhere else — `transform/src/shot.ts`'s own header
 * already names this file as one of exactly two seams between them.
 *
 * ## The rule this file exists to keep
 *
 * **No view component branches on kind.** That is an acceptance criterion, and
 * it is not kept by good intentions — a view reaching for `item.kind ===
 * "still"` to decide a button's label is how the seam leaks, one small
 * reasonable line at a time. So a `LibraryItem` carries no decision for a view
 * to make: the badge is TEXT the adapter wrote, the summary is a STRING the
 * adapter composed, and the buttons are a LIST the adapter chose. A view
 * renders what it is handed and dispatches by action id.
 * `app/test/library-seam.test.ts` holds the line.
 *
 * The honest cost is stated rather than hidden: `summary` and `actions` mean
 * this module knows what the UI says, which is a layering compromise. It is the
 * one the ticket asks for, and the alternative — a view switching on kind in
 * three places — is the thing it forbids. When a kind needs something this
 * interface cannot express, the instruction is to WIDEN the interface
 * deliberately, not to special-case it at the call site.
 *
 * ## Why the scan lives here and not in `takes.ts`
 *
 * One pass over the root has to classify every directory, because a second pass
 * would stat 500 directories twice and, worse, would have to agree with the
 * first about what a still is. `takes.ts` keeps the root, the naming and the
 * label; it imports nothing from here. One direction only — CLAUDE.md already
 * records what a cycle costs in ESM (a hang and exit 13, not an error).
 */

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
 * A label is decoration. Losing it must never cost the take, so a corrupt
 * take.json degrades to "no label" rather than invalidating anything. Shared
 * by both kinds deliberately: labelling is one mechanism over one interface,
 * which is what lets the rename UI be written once.
 */
async function readLabel(dir: string): Promise<string | undefined> {
  try {
    const doc = JSON.parse(await readFile(join(dir, "take.json"), "utf8"));
    if (typeof doc?.label === "string" && doc.label.trim()) return doc.label.trim();
  } catch { /* absent or malformed */ }
  return undefined;
}

interface Scan {
  takes: TakeInfo[];
  stills: StillInfo[];
  invalid: InvalidItem[];
}

/**
 * One pass over the storage root, classifying every directory.
 *
 * A directory holding `anchors.json` is a recording; one holding `shot.json` is
 * a still; anything else is reported invalid. **Before this existed, a still
 * was reported as a BROKEN RECORDING** — `listTakes` looked for anchors.json,
 * did not find one, and said "not a recording", which is true and useless. Every
 * still capture since STC-289 has been sitting in the library's invalid list.
 *
 * A broken take is REPORTED, never thrown and never silently skipped. One
 * unreadable directory must not hide the rest of someone's recordings, and a
 * take that quietly vanishes from the list is indistinguishable from one that
 * was deleted.
 */
async function scanRoot(env: NodeJS.ProcessEnv): Promise<Scan> {
  const root = takesRoot(env);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { takes: [], stills: [], invalid: [] };   // no recordings folder yet is not an error
  }

  const takes: TakeInfo[] = [];
  const stills: StillInfo[] = [];
  const invalid: InvalidItem[] = [];

  for (const name of entries.sort().reverse()) {
    const dir = join(root, name);
    let names: string[];
    try {
      if (!(await stat(dir)).isDirectory()) continue;   // .DS_Store and friends
      names = await readdir(dir);
    } catch { continue; }

    const fail = (reason: string) => invalid.push({ dir, name, reason });

    if (names.includes("shot.json")) {
      await readStill(dir, name, names, stills, fail);
      continue;
    }
    await readRecording(dir, name, names, takes, fail);
  }

  // Directory names are timestamps, so name order IS chronological order — and
  // it survives files being copied around, which mtime does not.
  takes.sort((a, b) => b.name.localeCompare(a.name));
  stills.sort((a, b) => b.name.localeCompare(a.name));
  return { takes, stills, invalid };
}

async function readRecording(dir: string, name: string, names: string[],
                             out: TakeInfo[], fail: (r: string) => void): Promise<void> {
  let anchors: any;
  try {
    anchors = JSON.parse(await readFile(join(dir, "anchors.json"), "utf8"));
  } catch (e: any) {
    fail(e?.code === "ENOENT" ? "no anchors.json — not a recording"
                              : `anchors.json is unreadable: ${e?.message ?? e}`);
    return;
  }
  if (!SUPPORTED_ANCHORS_VERSIONS.includes(anchors?.version)) {
    fail(`anchors.json version ${anchors?.version} is not supported`);
    return;
  }

  let videoBytes: number;
  try {
    videoBytes = (await stat(join(dir, anchors.files?.display ?? "display.mp4"))).size;
    if (videoBytes === 0) { fail("display.mp4 is empty — the recording never started"); return; }
  } catch {
    fail("display.mp4 is missing — the recording did not complete");
    return;
  }

  // Events are an overlay, not the recording. A take with a readable video is
  // worth listing and playing even if the cursor track is gone.
  let events = 0;
  try {
    const doc = JSON.parse(await readFile(join(dir, "events.json"), "utf8"));
    events = Array.isArray(doc?.events) ? doc.events.length : 0;
  } catch { /* absent or malformed: 0 */ }

  let recordedAt = 0;
  try { recordedAt = (await stat(join(dir, "anchors.json"))).mtimeMs; } catch { /* keep 0 */ }

  out.push({
    dir, name, recordedAt,
    durationMs: Math.round((anchors.stop?.t ?? 0) / 1e6),
    width: anchors.capture?.width ?? 0,
    height: anchors.capture?.height ?? 0,
    events,
    label: await readLabel(dir),
    camera: cameraSummary(anchors),
    bytes: await dirSize(dir, names),
  });
}

/**
 * A still, read through `parseShot` rather than by picking fields out of JSON.
 *
 * That loader REFUSES rather than defaults, deliberately — the document IS the
 * still — so a shot.json it rejects is a still that cannot be rendered, and the
 * library says so with the loader's own message instead of listing a tile that
 * would fail the moment it was opened.
 */
async function readStill(dir: string, name: string, names: string[],
                         out: StillInfo[], fail: (r: string) => void): Promise<void> {
  let shot: Shot;
  try {
    shot = parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
  } catch (e: any) {
    fail(`shot.json is unreadable: ${e?.message ?? e}`);
    return;
  }

  try {
    const frameBytes = (await stat(join(dir, shot.frame.file))).size;
    if (frameBytes === 0) { fail(`${shot.frame.file} is empty — the capture never completed`); return; }
  } catch {
    fail(`${shot.frame.file} is missing — the capture did not complete`);
    return;
  }

  let capturedAt = 0;
  try { capturedAt = (await stat(join(dir, "shot.json"))).mtimeMs; } catch { /* keep 0 */ }

  out.push({
    dir, name, capturedAt,
    width: shot.frame.width,
    height: shot.frame.height,
    mode: shot.decoration.mode,
    redactions: shot.decoration.redactions.length,
    label: await readLabel(dir),
    cached: names.includes(THUMBNAIL_FILE),
    bytes: await dirSize(dir, names),
  });
}

/**
 * The library: both kinds, newest first, already presented.
 *
 * Sorted across kinds by the directory name, which is a timestamp for both — so
 * a demo session that produced a recording and three stills reads back in the
 * order it happened, which is the whole argument for one index.
 */
export async function listLibrary(env: NodeJS.ProcessEnv,
                                  filter: string = DEFAULT_LIBRARY_FILTER): Promise<LibraryList> {
  const { takes, stills, invalid } = await scanRoot(env);
  const all = [...takes.map(recordingItem), ...stills.map(stillItem)];
  all.sort((a, b) => b.id.localeCompare(a.id));
  const chosen = LIBRARY_FILTERS.some((f) => f.id === filter) ? filter : DEFAULT_LIBRARY_FILTER;
  return { items: applyFilter(all, chosen), invalid, filters: LIBRARY_FILTERS, filter: chosen };
}

/**
 * Recordings only — the phase-2 view of the same scan.
 *
 * Kept because the preview player, the export path and their tests are all
 * about recordings and have no business being handed stills. It is a FILTER
 * over the one scan, never a second implementation: two scanners would be two
 * answers to "what is a take", which is exactly what the ticket's one-index
 * constraint forbids.
 */
export async function listTakes(env: NodeJS.ProcessEnv): Promise<TakeList> {
  const { takes, invalid } = await scanRoot(env);
  return { takes, invalid };
}
