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
 *
 * This is STC-345, the fourth and last study in STC-338's series (scrubber →
 * selection overlay handles → floating thumbnail motion → take library).
 * STC-294 already built and tested the library — one scan, a grid, delete
 * with no orphans — so this study's job is the same as the second and third:
 * write the vocabulary down, and do an adversarial pass over logic that
 * shipped believing it correct. Rule 9 is what that pass found.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE RULES
 * ════════════════════════════════════════════════════════════════════════
 *
 * **1. No view branches on kind — that is the interface, not a convention
 * kept by discipline.** The badge is TEXT this module wrote, the summary is a
 * STRING it composed, and the actions are a LIST it chose; a view renders
 * what it is handed and dispatches by action id. When a kind needs something
 * the interface cannot express, the instruction is to WIDEN `LibraryItem`
 * deliberately, never to special-case it at the call site. `library-view.ts`
 * may not mention `kind` at all, and `library-seam.test.ts` greps for it.
 *
 * **2. A thumbnail's SOURCE is not its KIND, and the two must not share a
 * name.** `LibraryThumbnail`'s discriminant is `source` on purpose — a view
 * legitimately switches on where a picture comes from (cached file, render
 * on demand, none), and if that field were also called `kind` no reader, and
 * no grep, could tell the legitimate branch from the one rule 1 forbids.
 *
 * **3. One scan classifies every directory; nothing gets a second opinion.**
 * `shot.json` present is a still, `anchors.json` present is a recording,
 * neither is reported invalid — never thrown, never silently dropped. A take
 * that silently disappears from the list is indistinguishable from one that
 * was deleted, and a second scanner would be a second answer to "what is a
 * take", which the ticket's one-index constraint forbids outright.
 *
 * **4. The directory name is identity AND the sort key; a label is neither.**
 * Renaming a directory would scramble chronological order, break an open
 * preview and invalidate a path already handed out for an export — so a
 * label lives beside the take (`take.json`) and never touches the name a
 * take is found by. Losing a label costs nothing but itself: a corrupt
 * `take.json` degrades to "no label", never to an invalid take.
 *
 * **5. A cached thumbnail lives INSIDE the take directory, so an orphan is
 * unreachable rather than merely unlikely.** Deleting a take deletes its
 * directory, which is what makes "no orphaned thumbnail" true by
 * construction; a cache anywhere else would need its own eviction, which is
 * the orphan the criterion names.
 *
 * **6. An unknown filter shows everything, never nothing.** A stale stored
 * preference — a filter id from a version that no longer exists — must not
 * be how a library reads as empty. `applyFilter` falls back to "all" for
 * anything it does not recognise, silently and without complaint.
 *
 * **7. Laziness must not be load-bearing.** 500 tiles cannot each read an
 * IPC round trip and render a picture before the first frame, so a tile
 * paints only once it is scrolled into view — except the first screenful,
 * painted outright with no timer and no geometry sampled, because a laziness
 * mechanism that can silently fail to fire (a missing `IntersectionObserver`
 * under a test runner) must default to correct pictures rather than to
 * empty boxes forever.
 *
 * **8. A version list this scanner reads must stay in step with the
 * transform's, and neither file may assume the other.** `SUPPORTED_ANCHORS_
 * VERSIONS` drifted from `transform/src/session.ts` once already — the
 * transform widened to accept a new anchors version and the library did not,
 * so a brand-new recording would have been UNSUPPORTED in the one place a
 * person goes to find it while playing back perfectly everywhere else.
 * `app/test/take-list.test.ts` pins the two lists together now.
 *
 * **9. A destination this scanner is about to CREATE must be claimed before
 * anything async, not merely computed from a snapshot.** Found reviewing
 * this module for the study: `still:duplicate` read the directory listing,
 * derived a fresh timestamped name, and `mkdir`'d it — three steps with two
 * gaps, and `mkdir(..., {recursive:true})` does not throw when the directory
 * already exists. Two duplicates racing (a double-click, or two tiles
 * duplicated inside the same second) could compute the SAME destination and
 * both copy into it, interleaving two unrelated shots' files with nothing
 * to say so — the result still parses as some shot. The same shape of defect
 * as the scrubber's rubber-band sign bug, the selection overlay's resize
 * floor and the thumbnail's discard race, one study each, and the same fix
 * this repo has now reached for three times: claim the name in-process
 * before the first `await`, release it in a `finally`. `duplicateTake` in
 * `takes.ts` is where it lives now; `app/test/takes.test.ts` proves two
 * concurrent duplicates — of the same take, and of two different ones —
 * never share a destination.
 *
 * **10. This module owns PRESENTATION and must not read a raw, I/O-shaped
 * document.** A second, byte-for-byte copy of `library.ts`'s `cameraSummary`
 * sat here, unreachable, taking a raw `anchors.json` blob as its input — the
 * exact thing this file's own header already forbids ("library.ts does the
 * scanning and imports node; this file must not"). Nothing was wrong with
 * the live behaviour, because nothing ever called the copy; the risk was a
 * bug fixed in the real one tomorrow with no reason for anyone to know a
 * second existed. Deleted; `library-seam.test.ts` now asserts `cameraSummary`
 * lives in exactly one file.
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

