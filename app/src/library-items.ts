/**
 * The library's item contract and its presentation — pure, and shared across
 * the process line (STC-294).
 *
 * `library.ts` does the scanning and imports node; this file must not, because
 * `renderer.ts` and `library-view.ts` need these types and these strings, and
 * the browser typecheck pass follows an import even when the emitted bundle
 * would have erased it. That pass caught exactly this the first time the grid
 * was wired up, which is what it is for.
 *
 * So the split is the same one this repo uses everywhere else — `selection.ts`
 * beside `overlay-session.ts`, `thumbnail.ts` beside `thumbnail-window.ts`,
 * `still-decorate.ts` beside `still-render.ts`: the decisions live where they
 * can be tested with no filesystem, and the I/O lives next door.
 */

import type { DecorationMode } from "@transform/shot.js";

export type LibraryKind = "recording" | "still";

/** What a tile can be told to do. The view dispatches on this, never on kind. */
export type LibraryActionId = "open" | "rename" | "duplicate" | "reveal" | "delete";

export interface LibraryAction {
  id: LibraryActionId;
  /** The button's text. Chosen here so "Preview" vs "Open" is not a view's branch. */
  label: string;
}

/**
 * How a tile gets its picture.
 *
 * `file` names a cached image INSIDE the take directory when one is already
 * there; `render` says the renderer must produce it (and, having produced it,
 * hand it back to be cached). `none` is a kind with no picture yet — a
 * recording, in this slice — and the view draws its placeholder without asking
 * why.
 *
 * The discriminant is `source` rather than `kind` ON PURPOSE: a view legitimately
 * switches on where a picture comes from, and if that field were also called
 * `kind` no reader — and no guard — could tell it apart from the one branch this
 * design forbids. `library-seam.test.ts` greps for `.kind`, so the two names
 * had to differ for the grep to mean anything.
 */
export type LibraryThumbnail =
  | { source: "file"; file: string }
  | { source: "render" }
  | { source: "none" };

/**
 * The narrow interface the ticket asks for: id, kind, created, label,
 * thumbnail, delete — plus the presentation each kind owns.
 */
export interface LibraryItem {
  /** Identity AND sort key: the directory's timestamped name. Never the label. */
  id: string;
  kind: LibraryKind;
  /** Shown on the tile. Data, not a branch. */
  badge: string;
  dir: string;
  createdAt: number;
  bytes: number;
  label?: string;
  /** The one line under the title, already composed for this kind. */
  summary: string;
  /**
   * Extra lines this item wants stated. STC-287's camera notes live here — a
   * camera that recorded nothing has to say so, and that is a fact about one
   * recording rather than a shape every kind has.
   */
  notes: string[];
  thumbnail: LibraryThumbnail;
  actions: LibraryAction[];
}

/** A directory that looks like a take but is not usable, and why. */
export interface InvalidItem {
  dir: string;
  name: string;
  reason: string;
}

export interface LibraryList {
  items: LibraryItem[];
  invalid: InvalidItem[];
  /** The chips to draw, and which one is on. Data, so the view chooses nothing. */
  filters: readonly LibraryFilter[];
  filter: string;
}

export interface LibraryFilter { id: string; label: string }

/**
 * The kind filter, as data.
 *
 * This exists here rather than in the view for the same reason `badge` and
 * `actions` do, and it is the case that nearly got away: "filters by kind" is a
 * scope bullet, and the obvious implementation is `items.filter((i) => i.kind
 * === selected)` in the renderer — which is exactly the branch the fourth
 * acceptance criterion forbids, arrived at by doing what the ticket asked for.
 * Mixed is FIRST and is the default: a demo session produces both kinds and
 * they belong together.
 */
export const LIBRARY_FILTERS: readonly LibraryFilter[] = [
  { id: "all", label: "All" },
  { id: "recording", label: "Recordings" },
  { id: "still", label: "Stills" },
];

export const DEFAULT_LIBRARY_FILTER = "all";

/** An unknown filter id shows everything rather than nothing — a stale preference must not empty the library. */
export function applyFilter(items: readonly LibraryItem[], id: string): LibraryItem[] {
  if (id === "recording" || id === "still") return items.filter((i) => i.kind === id);
  return [...items];
}

/**
 * Anchors document versions this build can read.
 *
 * MUST stay in step with `transform/src/session.ts`. They drifted once: STC-232
 * widened the transform to accept v2 and left this scanner at v1, so once the
 * helper emitted v2 every new recording would have been listed as unsupported
 * while the transform loaded it happily — the take library wrong, the transform
 * right, and the two disagreeing about what a recording is.
 *
 * The two cannot share a constant: this runs in the Electron main process and
 * imports only node builtins, while the transform is bundled for the renderer.
 * `app/test/take-list.test.ts` pins them together instead.
 */
export const SUPPORTED_ANCHORS_VERSIONS: readonly number[] = [1, 2];

/** The cached decorated thumbnail, beside the document it was rendered from. */
export const THUMBNAIL_FILE = "thumb.png";

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

export interface TakeList {
  takes: TakeInfo[];
  invalid: InvalidItem[];
}

/** What a still tile needs, over and above the shared fields. */
export interface StillInfo {
  dir: string;
  name: string;
  capturedAt: number;
  /** Capture pixels, not output pixels — the decoration decides the output. */
  width: number;
  height: number;
  mode: DecorationMode;
  redactions: number;
  bytes: number;
  label?: string;
  /** Whether a decorated thumbnail is already cached beside the document. */
  cached: boolean;
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



const fmtBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
};

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** How each decoration mode reads to a person. */
const MODE_LABELS: Readonly<Record<DecorationMode, string>> = {
  "selected-area": "Selected area",
  "window-only": "Window",
  "window-shadow": "Window + shadow",
  "window-shadow-background": "Window + background",
  "window-shadow-custom-background": "Window + custom background",
};

/**
 * One recording, as a library item.
 *
 * A recording has no thumbnail in this slice and says so structurally rather
 * than by the view knowing which kinds have pictures. Decoding a poster frame
 * for every recording is the WebCodecs path CLAUDE.md documents as tab-killing
 * at scale (one in-flight request, ~30 MB per `VideoFrame`), so it is a
 * deliberate follow-up, not an oversight.
 */
export function recordingItem(t: TakeInfo): LibraryItem {
  const notes: string[] = [];
  if (t.camera) {
    if (!t.camera.present) {
      notes.push("Camera: recorded no frames — this take has no picture-in-picture");
    } else {
      const who = t.camera.device ?? "camera";
      notes.push(t.camera.pipStartsAfterMs > 0
        ? `Camera: ${who} · picture-in-picture starts ${(t.camera.pipStartsAfterMs / 1000).toFixed(1)}s in`
        : `Camera: ${who}`);
    }
  }
  return {
    id: t.name,
    kind: "recording",
    badge: "Recording",
    dir: t.dir,
    createdAt: t.recordedAt,
    bytes: t.bytes,
    label: t.label,
    summary: `${fmtDuration(t.durationMs)} · ${t.width}×${t.height} · `
           + `${t.events} events · ${fmtBytes(t.bytes)}`,
    notes,
    thumbnail: { source: "none" },
    actions: [
      { id: "open", label: "Preview" },
      { id: "rename", label: "Rename" },
      { id: "reveal", label: "Show" },
      { id: "delete", label: "Delete" },
    ],
  };
}

/**
 * One still, as a library item.
 *
 * `open` re-opens it into the post-capture panel with its decoration intact,
 * which is the payoff of keeping the decoration in JSON; `duplicate` is what
 * lets a second decoration be tried without re-capturing. Neither exists for a
 * recording, and the view learns that from this list rather than from the kind.
 */
export function stillItem(s: StillInfo): LibraryItem {
  const bits = [`${s.width}×${s.height}`, MODE_LABELS[s.mode], fmtBytes(s.bytes)];
  if (s.redactions > 0) {
    bits.splice(2, 0, `${s.redactions} redaction${s.redactions === 1 ? "" : "s"}`);
  }
  return {
    id: s.name,
    kind: "still",
    badge: "Still",
    dir: s.dir,
    createdAt: s.capturedAt,
    bytes: s.bytes,
    label: s.label,
    summary: bits.join(" · "),
    notes: [],
    // A cached file is named; otherwise the renderer is asked to make one. The
    // cache lives in the take directory precisely so that deleting the take
    // deletes it too — an orphan is impossible rather than merely unlikely.
    thumbnail: s.cached ? { source: "file", file: THUMBNAIL_FILE } : { source: "render" },
    actions: [
      { id: "open", label: "Open" },
      { id: "rename", label: "Rename" },
      { id: "duplicate", label: "Duplicate" },
      { id: "reveal", label: "Show" },
      { id: "delete", label: "Delete" },
    ],
  };
}

