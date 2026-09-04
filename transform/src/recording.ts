import type { Anchors } from "./types.js";

/**
 * recording.json — schema/recording-1.schema.json as types, plus the one loader (STC-307).
 *
 * What media a take is made of, as a list of segments. Deliberately its own
 * file, not a project.json field and not an anchors.json field: media
 * identity has a different lifecycle from both. project.json is freely
 * rewritten by every edit (trim, cursor style, PiP) and must not carry the
 * one thing that has to survive a re-take unchanged. anchors.json is written
 * once by the helper and describes facts about a single capture (the clock,
 * the display geometry); it has no notion of a segment's own identity
 * surviving its file being replaced. A segment's media ids are
 * content-independent — a re-take swaps the file behind an id, it does not
 * mint a new one — which is exactly the property neither of those documents
 * needs to offer today.
 *
 * Today's helper always produces exactly one segment spanning the whole
 * take, so every take on disk predates this file. `synthesizeRecording`
 * derives the one this ticket's scope calls for from an existing
 * anchors.json, in memory — no migration script touches ~/Desktop/stc,
 * matching how anchors v1/v2 and project v1/v2/v3 are already read (readers
 * accept v1..vN). Nothing downstream consumes a Recording yet: re-take,
 * N-minute segmentation and hot-swap rebuild are separate, later tickets.
 */

export interface MediaRef {
  id: string;
  file: string;
}

export interface Segment {
  id: string;
  media: { display: MediaRef; camera?: MediaRef };
  startNs: number;
  endNs: number;
}

export interface Recording {
  version: 1;
  segments: Segment[];
}

export class RecordingLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordingLoadError";
  }
}

export const RECORDING_VERSIONS: readonly number[] = [1];

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A key nobody declared is refused, not dropped — same reasoning as shot.ts's
 * noExtra: this document is the artefact naming a take's media, and a field
 * this version cannot carry would be silently lost on the next write.
 */
function noExtra(v: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new RecordingLoadError(`${what} has a field this version does not know: ${k}`);
  }
}

function mediaRef(v: unknown, what: string): MediaRef {
  if (!isObj(v) || typeof v.id !== "string" || !v.id || typeof v.file !== "string" || !v.file) {
    throw new RecordingLoadError(`${what} must carry a non-empty id and file`);
  }
  noExtra(v, ["id", "file"], what);
  return { id: v.id, file: v.file };
}

function segment(v: unknown, i: number): Segment {
  const what = `segments[${i}]`;
  if (!isObj(v)) throw new RecordingLoadError(`${what} is not an object`);
  noExtra(v, ["id", "media", "startNs", "endNs"], what);
  if (typeof v.id !== "string" || !v.id) throw new RecordingLoadError(`${what}.id must be a non-empty string`);
  if (!isObj(v.media)) throw new RecordingLoadError(`${what}.media is missing`);
  noExtra(v.media, ["display", "camera"], `${what}.media`);
  const media: Segment["media"] = { display: mediaRef(v.media.display, `${what}.media.display`) };
  if (v.media.camera !== undefined) media.camera = mediaRef(v.media.camera, `${what}.media.camera`);
  if (!isInt(v.startNs) || v.startNs < 0) throw new RecordingLoadError(`${what}.startNs must be a non-negative integer`);
  // The schema can only bound endNs > 0 in isolation; endNs > startNs is a
  // sum constraint across two fields, same class as shot.ts's redaction
  // bound, and belongs to the loader alone.
  if (!isInt(v.endNs) || v.endNs <= v.startNs) throw new RecordingLoadError(`${what}.endNs must be an integer greater than ${what}.startNs`);
  return { id: v.id, media, startNs: v.startNs, endNs: v.endNs };
}

/**
 * Reads a recording.json. Throws RecordingLoadError, with the field named, on
 * anything it cannot render from; returns a normalised copy (no aliasing of
 * `raw`). Unlike parseProject, this refuses rather than defaults — same
 * reasoning as shot.ts: a document naming a take's media that cannot be read
 * is a take whose media cannot be resolved, and guessing beats nothing only
 * until the guess is wrong.
 */
export function parseRecording(raw: unknown): Recording {
  if (!isObj(raw)) throw new RecordingLoadError("recording.json is not an object");
  noExtra(raw, ["version", "segments"], "recording.json");
  if (!RECORDING_VERSIONS.includes(raw.version as number)) {
    throw new RecordingLoadError(`recording.json version ${String(raw.version)} is not supported (expected ${RECORDING_VERSIONS.join(", ")})`);
  }
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw new RecordingLoadError("segments must be a non-empty array");
  }
  const segments = raw.segments.map((s, i) => segment(s, i));

  // Ordered and non-overlapping: a downstream reader walking segments in
  // array order must see time move forward. Whether adjacent segments must
  // be CONTIGUOUS (no gap) is a question for whichever ticket first produces
  // a gap — hot-swap rebuild and N-minute segmentation may want different
  // answers — so it is deliberately not asserted here.
  for (let i = 1; i < segments.length; i++) {
    if (segments[i]!.startNs < segments[i - 1]!.endNs) {
      throw new RecordingLoadError(`segments[${i}] starts before segments[${i - 1}] ends — segments must be ordered and non-overlapping`);
    }
  }

  // Every id — a segment's own, and each of its media's — is a distinct
  // identity; the whole point of the id is that nothing else can be mistaken
  // for it.
  const seen = new Set<string>();
  segments.forEach((s, i) => {
    const ids: [string, string][] = [[s.id, `segments[${i}].id`], [s.media.display.id, `segments[${i}].media.display.id`]];
    if (s.media.camera) ids.push([s.media.camera.id, `segments[${i}].media.camera.id`]);
    for (const [id, where] of ids) {
      if (seen.has(id)) throw new RecordingLoadError(`id "${id}" (${where}) is used more than once in this document`);
      seen.add(id);
    }
  });

  return { version: 1, segments };
}

/** The document to write. Always the latest version. */
export function recordingForWrite(recording: Recording): Recording {
  return parseRecording(JSON.parse(JSON.stringify({ ...recording, version: 1 })));
}

/**
 * Synthesizes the recording.json a take never had. Today's helper always
 * writes exactly one segment covering the whole take, so anchors.json plus a
 * clean stop already carries everything a v1 document needs — nothing here
 * reads the media files themselves.
 *
 * Ids are deterministic, not random: a legacy take has no capture-time
 * identity to preserve, and a pure function must not invent a fresh one on
 * every call for the same input. The "legacy:" prefix marks them as
 * synthesized rather than real capture-time ids, which the helper does not
 * emit yet.
 */
export function synthesizeRecording(anchors: Anchors): Recording {
  if (!anchors.stop) {
    throw new RecordingLoadError("cannot synthesize a recording from anchors with no stop — the take never finished");
  }
  const media: Segment["media"] = {
    display: { id: "legacy:display", file: anchors.files.display },
  };
  if (anchors.camera?.present === true && anchors.files.camera) {
    media.camera = { id: "legacy:camera", file: anchors.files.camera };
  }
  return {
    version: 1,
    segments: [{ id: "legacy:segment-0", media, startNs: 0, endNs: anchors.stop.t }],
  };
}
