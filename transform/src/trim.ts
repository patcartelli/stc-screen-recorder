import type { Pip, Project, Trim } from "./types.js";

const NS_PER_S = 1_000_000_000;

/**
 * GPU raster, no hash: 11.0 ms/frame at 4K (PHASE-2 increment 0). The UI
 * export also hashes, so this is an underestimate — better than inventing a
 * second number the gates do not measure.
 */
export const EXPORT_MS_PER_FRAME = 11;

/** One 60 fps output frame, matching export's `tickTimeNs(2)` step. */
export function minTrimNs(fps: number): number {
  return Math.ceil(NS_PER_S / fps);
}

export function availableFrames(durationNs: number, fps: number): number {
  return Math.max(1, Math.floor((durationNs * fps) / NS_PER_S) + 1);
}

export function clampTrim(startNs: number, endNs: number, durationNs: number, fps: 60 = 60): Trim {
  const min = minTrimNs(fps);
  const dur = Math.max(0, durationNs);
  if (dur <= min) return { startNs: 0, endNs: dur };
  const start = Math.max(0, Math.min(Math.round(startNs), dur - min));
  const end = Math.max(start + min, Math.min(Math.round(endNs), dur));
  return { startNs: start, endNs: end };
}

export function isFullTake(project: Project, durationNs: number): boolean {
  if (!project.trim) return true;
  return project.trim.startNs === 0 && project.trim.endNs === durationNs;
}

/**
 * Convert a project trim into the (fromFrame, maxFrames) window export already
 * understands. Inclusive of the 60 fps frame at endNs.
 */
export function exportWindow(
  project: Project,
  durationNs: number,
): { fromFrame: number; maxFrames: number; startNs: number; endNs: number } {
  const fps = project.output.fps;
  const available = availableFrames(durationNs, fps);
  const trim = project.trim
    ? clampTrim(project.trim.startNs, project.trim.endNs, durationNs, fps)
    : { startNs: 0, endNs: durationNs };
  const fromFrame = Math.max(0, Math.min(Math.floor((trim.startNs * fps) / NS_PER_S), available - 1));
  const endFrame = Math.max(fromFrame, Math.min(Math.floor((trim.endNs * fps) / NS_PER_S), available - 1));
  return { fromFrame, maxFrames: endFrame - fromFrame + 1, startNs: trim.startNs, endNs: trim.endNs };
}

export function estimateExportMs(maxFrames: number): number {
  return maxFrames * EXPORT_MS_PER_FRAME;
}

/**
 * The PiP a camera take gets when its own project does not say otherwise.
 *
 * Matches `fixtures/pip/project.json`'s geometry so the fixture and the app
 * agree about what "default" means.
 */
export const DEFAULT_PIP: Pip = {
  enabled: true, corner: "bottom-right", widthPct: 0.125, marginPx: 32,
};

export function defaultProject(
  width: number, height: number, trim?: Trim, hasCamera = false,
): Project {
  const project: Project = {
    // v2: `trim` lives in project-2 alongside `pip`. Emitting v1 would produce
    // a document carrying a field its own schema does not declare.
    version: 2,
    output: { fps: 60, width, height },
    cursor: { style: "default", scale: 1 },
  };
  // A recorded camera track is part of the take, so a take that has one shows
  // its PiP without needing an edit document to say so.
  //
  // Without this, every take the app records with the camera on previews with
  // an INVISIBLE PiP: nothing writes a project.json at record time, so
  // parseProject falls back to a default, the default had no pip, render()
  // returned pip: null, and composite() drew nothing — next to a perfectly good
  // camera.mp4. The first real hardware take needed a project written by hand
  // before anything appeared.
  if (hasCamera) project.pip = { ...DEFAULT_PIP };
  if (trim) project.trim = trim;
  return project;
}

/**
 * A corrupt sidecar must not cost the recording. Unknown versions, missing
 * fields and non-integer times fall back to a default project for this take.
 */
export function parseProject(
  raw: unknown, width: number, height: number, durationNs: number, hasCamera = false,
): Project {
  const fallback = defaultProject(width, height, undefined, hasCamera);
  if (!raw || typeof raw !== "object") return fallback;
  const doc = raw as Record<string, any>;
  // v1 and v2 both load: v1 documents predate trim and pip and simply have
  // neither. Refusing v1 here would discard every project written before this
  // change and silently replace it with a default.
  if (doc.version !== 1 && doc.version !== 2) return fallback;

  const outW = Number.isInteger(doc.output?.width) ? doc.output.width : width;
  const outH = Number.isInteger(doc.output?.height) ? doc.output.height : height;
  const scale = typeof doc.cursor?.scale === "number" && doc.cursor.scale > 0 ? doc.cursor.scale : 1;
  const project = defaultProject(outW, outH, undefined, hasCamera);
  project.cursor = { style: "default", scale };

  // Same reasoning as projectForWrite: anything this parser does not copy is
  // lost on the next write. `pip` is validated by the schema, so it is carried
  // as-is rather than re-derived here.
  if (doc.pip && typeof doc.pip === "object") project.pip = doc.pip;

  const t = doc.trim;
  if (t && Number.isInteger(t.startNs) && Number.isInteger(t.endNs) && t.startNs >= 0 && t.endNs >= 0) {
    project.trim = clampTrim(t.startNs, t.endNs, durationNs, 60);
  }
  return project;
}

export function projectForWrite(project: Project, durationNs: number): Project {
  const out: Project = {
    version: 2,
    output: project.output,
    cursor: project.cursor,
  };
  // Carried, not rebuilt from scratch. This function predates `pip`, and a
  // document reconstructed from a fixed field list silently drops anything
  // added since — so a take with a PiP would lose it on the next save.
  if (project.pip) out.pip = project.pip;
  if (!isFullTake(project, durationNs) && project.trim) out.trim = project.trim;
  return out;
}
