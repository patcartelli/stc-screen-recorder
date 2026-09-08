import type { CursorShape } from "./types.js";
import type { Rect } from "./spaces.js";
import {
  ANNOTATION_TEXT_SIZES, ANNOTATION_WEIGHTS, MAX_ANNOTATION_TEXT,
  type Annotation, type AnnotationTextSize, type AnnotationWeight, type BoxShape,
} from "./still-annotate.js";

/**
 * The still document — schema/shot-1.schema.json as types, plus the one loader.
 *
 * Its own small format, deliberately not a one-frame project/anchors pair
 * (STC-288, decided): a still has no timeline, no segments and no event stream,
 * and coupling the two would make every video schema change ripple into stills.
 * The two kinds meet at exactly two seams, the library and the frame converter,
 * and nowhere in here.
 *
 * Unlike parseProject, this REFUSES rather than defaults. A project is an edit
 * over a recording that still exists without it; a shot document IS the still
 * — the description is the artefact and the pixels are derived — so a document
 * this cannot read is a still that cannot be rendered, and saying so beats
 * quietly rendering something else. STC-301 gate 5: every shot.json written
 * loads back, renders byte-identically, and carries a version.
 */

export type ShotKind = "display-crop" | "window";
export type DecorationMode =
  | "selected-area"
  | "window-only"
  | "window-shadow"
  | "window-shadow-background"
  | "window-shadow-custom-background";
export type CanvasPreset = "natural" | "16:9" | "4:3" | "1:1";

// Geometry types have ONE declaration (STC-314). Re-exported because
// `Rect` has been part of this module's surface since shot-1.
export type { Rect } from "./spaces.js";

export interface ShotDisplay {
  id: number;
  pointWidth: number;
  pointHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  backingScale: number;
  originX: number;
  originY: number;
  colorSpace?: string;
}

export interface ShotWindow {
  id: number;
  app?: string;
  title?: string;
  /** display-local points */
  bounds: Rect;
}

export interface ShotFrame {
  file: string;
  /** pixels */
  width: number;
  height: number;
  /** true only for window captures */
  alpha: boolean;
}

/** Sampled at capture, never in the pixels. Absent when the pointer was on another display. */
export interface ShotCursor { x: number; y: number; shape: CursorShape }

export interface Background {
  kind: "solid" | "linear" | "radial" | "image" | "wallpaper";
  colors?: string[];
  angleDeg?: number;
  file?: string;
}

export interface Shadow { offsetX: number; offsetY: number; blur: number; spread: number; opacity: number }

/** Normalised to the capture (0..1), so it moves with the content, not the canvas. */
export interface Redaction { x: number; y: number; width: number; height: number }

export interface Decoration {
  mode: DecorationMode;
  paddingPct?: number;
  background?: Background;
  shadow?: Shadow;
  canvas: CanvasPreset;
  cursor: boolean;
  redactions: Redaction[];
  /**
   * Markup over the decorated still (STC-295, shot-2). Always an array here —
   * absent in the document means empty — so no caller has to distinguish
   * "no annotations" from "an older document".
   */
  annotations: Annotation[];
}

export interface Shot {
  /** The MINIMUM version that can express this document — see `versionFor`. */
  version: 1 | 2;
  kind: ShotKind;
  /** mach-clock ns as a decimal string, like anchors.t0Ns */
  capturedAtNs: string;
  timebase: { numer: number; denom: number };
  display: ShotDisplay;
  crop?: Rect;
  window?: ShotWindow;
  frame: ShotFrame;
  cursor?: ShotCursor;
  decoration: Decoration;
}

export class ShotLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShotLoadError";
  }
}

export const SHOT_VERSIONS: readonly number[] = [1, 2];

/**
 * The version a document should be WRITTEN as: the minimum that can express it.
 *
 * A still with no annotations is a v1 document however it was produced, so the
 * helper needs no change (it has nothing to say about annotations) and a shot
 * that was never marked up stays readable by an older build. Removing the last
 * annotation takes it back to v1, which is the same rule read backwards rather
 * than a special case.
 *
 * The alternative — always writing the newest version — makes every capture
 * unreadable to an older reader for a field it does not use, which is a cost
 * paid by everyone to benefit nobody.
 */
export function versionFor(shot: { decoration: { annotations?: readonly unknown[] } }): 1 | 2 {
  return (shot.decoration.annotations?.length ?? 0) > 0 ? 2 : 1;
}
export const DECORATION_MODES: readonly DecorationMode[] = [
  "selected-area", "window-only", "window-shadow", "window-shadow-background", "window-shadow-custom-background",
];
export const CANVAS_PRESETS: readonly CanvasPreset[] = ["natural", "16:9", "4:3", "1:1"];
/** Modes that need a window capture with alpha — a crop is always an opaque rectangle. */
export const WINDOW_MODES: readonly DecorationMode[] = DECORATION_MODES.filter((m) => m !== "selected-area");

/**
 * The decoration a fresh capture gets: the honest one for its kind. The five
 * presets' real values are an open question that only making figures answers
 * (STC-288); these are the two that involve no judgement.
 */
export function defaultDecoration(kind: ShotKind): Decoration {
  return {
    mode: kind === "window" ? "window-only" : "selected-area",
    canvas: "natural",
    annotations: [],
    cursor: false,
    redactions: [],
  };
}

const isInt = (v: unknown): v is number => Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A key nobody declared is refused, not dropped. parseProject carries unknown
 * blocks through so an older reader does not strip a newer writer's field;
 * here the document is the artefact, and a field this version cannot render
 * from — "baked", say — would be silently lost on the next write instead.
 */
function noExtra(v: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) throw new ShotLoadError(`${what} has a field this version does not know: ${k}`);
  }
}

function rect(v: unknown, what: string): Rect {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.width) || !isNum(v.height) || v.width <= 0 || v.height <= 0) {
    throw new ShotLoadError(`${what} must be a rectangle with positive width and height`);
  }
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}

/** A normalised (0..1) point. Out of range is refused, never clamped: clamping a stored value would silently move someone's arrow. */
function normPoint(v: unknown, what: string): { x: number; y: number } {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1) {
    throw new ShotLoadError(`${what} must be a point normalised to 0..1`);
  }
  return { x: v.x, y: v.y };
}

function weightOf(v: unknown, what: string): AnnotationWeight {
  if (typeof v !== "string" || !(v in ANNOTATION_WEIGHTS)) {
    throw new ShotLoadError(`${what} must be one of ${Object.keys(ANNOTATION_WEIGHTS).join(", ")}`);
  }
  return v as AnnotationWeight;
}

/**
 * One annotation, refused rather than defaulted.
 *
 * Same rule as the rest of this loader: the document IS the still, so a mark
 * this build cannot draw is a still it cannot render, and saying which one and
 * why beats rendering a picture missing an arrow the author thinks is there.
 */
function annotation(v: unknown, what: string): Annotation {
  if (!isObj(v)) throw new ShotLoadError(`${what} must be an object`);
  if (v.kind === "arrow") {
    noExtra(v, ["kind", "from", "to", "weight"], what);
    return { kind: "arrow", from: normPoint(v.from, `${what}.from`),
             to: normPoint(v.to, `${what}.to`), weight: weightOf(v.weight, `${what}.weight`) };
  }
  if (v.kind === "box") {
    noExtra(v, ["kind", "shape", "rect", "weight"], what);
    if (v.shape !== "rect" && v.shape !== "ellipse") {
      throw new ShotLoadError(`${what}.shape must be rect or ellipse`);
    }
    const r = v.rect;
    if (!isObj(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.width) || !isNum(r.height) ||
        r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) {
      throw new ShotLoadError(`${what}.rect must be a normalised rectangle inside the capture`);
    }
    return { kind: "box", shape: v.shape as BoxShape, weight: weightOf(v.weight, `${what}.weight`),
             rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  }
  if (v.kind === "text") {
    noExtra(v, ["kind", "at", "text", "size"], what);
    if (typeof v.text !== "string" || !v.text.trim()) {
      throw new ShotLoadError(`${what}.text must be a non-empty string`);
    }
    if (v.text.length > MAX_ANNOTATION_TEXT) {
      throw new ShotLoadError(`${what}.text is longer than ${MAX_ANNOTATION_TEXT} characters`);
    }
    if (typeof v.size !== "string" || !(v.size in ANNOTATION_TEXT_SIZES)) {
      throw new ShotLoadError(`${what}.size must be one of ${Object.keys(ANNOTATION_TEXT_SIZES).join(", ")}`);
    }
    return { kind: "text", at: normPoint(v.at, `${what}.at`), text: v.text,
             size: v.size as AnnotationTextSize };
  }
  throw new ShotLoadError(`${what}.kind ${String(v.kind)} is not arrow, box or text`);
}

/**
 * Reads a shot.json. Throws ShotLoadError, with the field named, on anything
 * it cannot render from; returns a normalised copy (no aliasing of `raw`).
 */
export function parseShot(raw: unknown): Shot {
  if (!isObj(raw)) throw new ShotLoadError("shot.json is not an object");
  noExtra(raw, ["version", "kind", "capturedAtNs", "timebase", "display", "crop", "window", "frame", "cursor", "decoration"], "shot.json");
  if (!SHOT_VERSIONS.includes(raw.version as number)) {
    throw new ShotLoadError(`shot.json version ${String(raw.version)} is not supported (expected ${SHOT_VERSIONS.join(", ")})`);
  }
  const kind = raw.kind;
  if (kind !== "display-crop" && kind !== "window") throw new ShotLoadError(`kind must be display-crop or window, not ${String(kind)}`);
  if (typeof raw.capturedAtNs !== "string" || !/^[0-9]+$/.test(raw.capturedAtNs)) {
    throw new ShotLoadError("capturedAtNs must be a decimal string of nanoseconds");
  }
  const tb = raw.timebase;
  if (!isObj(tb) || !isInt(tb.numer) || !isInt(tb.denom) || tb.numer < 1 || tb.denom < 1) {
    throw new ShotLoadError("timebase must carry positive integer numer and denom");
  }

  const d = raw.display;
  if (!isObj(d)) throw new ShotLoadError("display is missing");
  for (const k of ["id", "pointWidth", "pointHeight", "pixelWidth", "pixelHeight"] as const) {
    if (!isInt(d[k]) || (d[k] as number) < (k === "id" ? 0 : 1)) throw new ShotLoadError(`display.${k} must be an integer`);
  }
  if (!isNum(d.backingScale) || d.backingScale <= 0) throw new ShotLoadError("display.backingScale must be positive");
  if (!isNum(d.originX) || !isNum(d.originY)) throw new ShotLoadError("display.originX/originY must be numbers");
  const display: ShotDisplay = {
    id: d.id as number, pointWidth: d.pointWidth as number, pointHeight: d.pointHeight as number,
    pixelWidth: d.pixelWidth as number, pixelHeight: d.pixelHeight as number,
    backingScale: d.backingScale, originX: d.originX, originY: d.originY,
  };
  if (typeof d.colorSpace === "string") display.colorSpace = d.colorSpace;

  const f = raw.frame;
  if (!isObj(f) || typeof f.file !== "string" || !f.file || !isInt(f.width) || !isInt(f.height) ||
      f.width < 1 || f.height < 1 || typeof f.alpha !== "boolean") {
    throw new ShotLoadError("frame must name a file with integer pixel width/height and an alpha flag");
  }
  const frame: ShotFrame = { file: f.file, width: f.width, height: f.height, alpha: f.alpha };

  const shot: Shot = {
    version: raw.version as 1 | 2, kind, capturedAtNs: raw.capturedAtNs,
    timebase: { numer: tb.numer, denom: tb.denom }, display, frame,
    decoration: defaultDecoration(kind),
  };

  // The source is the kind's own block, and only that one: a crop on a window
  // shot (or the reverse) is two claims about what was captured.
  if (kind === "display-crop") {
    if (raw.window !== undefined) throw new ShotLoadError("a display-crop shot must not carry a window block");
    shot.crop = rect(raw.crop, "crop");
  } else {
    if (raw.crop !== undefined) throw new ShotLoadError("a window shot must not carry a crop block");
    const w = raw.window;
    if (!isObj(w) || !isInt(w.id) || w.id < 0) throw new ShotLoadError("window.id must be a non-negative integer");
    shot.window = { id: w.id, bounds: rect(w.bounds, "window.bounds") };
    if (typeof w.app === "string") shot.window.app = w.app;
    if (typeof w.title === "string") shot.window.title = w.title;
  }

  // Absent means "on another display"; anything present must be complete. A
  // zeroed cursor is exactly the lie the schema forbids.
  if (raw.cursor !== undefined) {
    const c = raw.cursor;
    if (!isObj(c) || !isNum(c.x) || !isNum(c.y) ||
        !["arrow", "ibeam", "crosshair", "pointingHand"].includes(c.shape as string)) {
      throw new ShotLoadError("cursor, when present, must carry x, y and a known shape");
    }
    shot.cursor = { x: c.x, y: c.y, shape: c.shape as CursorShape };
  }

  const dec = raw.decoration;
  if (!isObj(dec)) throw new ShotLoadError("decoration is missing");
  noExtra(dec, ["mode", "paddingPct", "background", "shadow", "canvas", "cursor", "redactions", "annotations"], "decoration");
  if (!DECORATION_MODES.includes(dec.mode as DecorationMode)) throw new ShotLoadError(`decoration.mode ${String(dec.mode)} is not one of ${DECORATION_MODES.join(", ")}`);
  const mode = dec.mode as DecorationMode;
  if (WINDOW_MODES.includes(mode) && (kind !== "window" || !frame.alpha)) {
    throw new ShotLoadError(`decoration.mode ${mode} needs a window capture with alpha; this is a ${kind} shot${frame.alpha ? "" : " without alpha"}`);
  }
  if (!CANVAS_PRESETS.includes(dec.canvas as CanvasPreset)) throw new ShotLoadError(`decoration.canvas ${String(dec.canvas)} is not one of ${CANVAS_PRESETS.join(", ")}`);
  if (typeof dec.cursor !== "boolean") throw new ShotLoadError("decoration.cursor must be a boolean");
  if (!Array.isArray(dec.redactions)) throw new ShotLoadError("decoration.redactions must be an array");
  const redactions = dec.redactions.map((r, i) => {
    if (!isObj(r) || !isNum(r.x) || !isNum(r.y) || !isNum(r.width) || !isNum(r.height) ||
        r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) {
      throw new ShotLoadError(`decoration.redactions[${i}] must be a normalised rectangle inside the capture`);
    }
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  // Absent is empty. The version rule is enforced on the WRITE, not here:
  // `Decoration` always carries the array in memory, so a v1 document that has
  // been parsed, had one field changed and been handed back would be refused by
  // a strict read for a key it never asked for — which is exactly what
  // `still:writeShot` does on every stored shot. `shotForWrite` is what keeps
  // shot-1 documents free of the key, and it is tested for that.
  //
  // A v1 document carrying a NON-EMPTY array is a different thing and is still
  // refused: that document claims a version and then uses a feature the version
  // does not have, which nothing legitimate produces.
  if (dec.annotations !== undefined && !Array.isArray(dec.annotations)) {
    throw new ShotLoadError("decoration.annotations must be an array");
  }
  if (raw.version === 1 && Array.isArray(dec.annotations) && dec.annotations.length > 0) {
    throw new ShotLoadError("decoration.annotations needs version 2; this document says version 1");
  }
  const annotations: Annotation[] = (dec.annotations ?? [])
    .map((a: unknown, i: number) => annotation(a, `decoration.annotations[${i}]`));
  const decoration: Decoration = {
    mode, canvas: dec.canvas as CanvasPreset, cursor: dec.cursor, redactions, annotations,
  };
  if (dec.paddingPct !== undefined) {
    if (!isNum(dec.paddingPct) || dec.paddingPct < 0 || dec.paddingPct > 1) throw new ShotLoadError("decoration.paddingPct must be within 0..1");
    decoration.paddingPct = dec.paddingPct;
  }
  if (dec.background !== undefined) {
    const b = dec.background;
    if (!isObj(b) || !["solid", "linear", "radial", "image", "wallpaper"].includes(b.kind as string)) {
      throw new ShotLoadError("decoration.background.kind is not a known kind");
    }
    const bg: Background = { kind: b.kind as Background["kind"] };
    if (b.colors !== undefined) {
      if (!Array.isArray(b.colors) || b.colors.length === 0 ||
          !b.colors.every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c))) {
        throw new ShotLoadError("decoration.background.colors must be hex colours");
      }
      bg.colors = [...(b.colors as string[])];
    }
    if (b.angleDeg !== undefined) { if (!isNum(b.angleDeg)) throw new ShotLoadError("decoration.background.angleDeg must be a number"); bg.angleDeg = b.angleDeg; }
    if (b.file !== undefined) { if (typeof b.file !== "string" || !b.file) throw new ShotLoadError("decoration.background.file must name a file"); bg.file = b.file; }
    decoration.background = bg;
  }
  if (dec.shadow !== undefined) {
    const s = dec.shadow;
    if (!isObj(s) || !isNum(s.offsetX) || !isNum(s.offsetY) || !isNum(s.blur) || !isNum(s.spread) || !isNum(s.opacity) ||
        s.blur < 0 || s.opacity < 0 || s.opacity > 1) {
      throw new ShotLoadError("decoration.shadow must carry offsetX, offsetY, blur >= 0, spread and opacity within 0..1");
    }
    decoration.shadow = { offsetX: s.offsetX, offsetY: s.offsetY, blur: s.blur, spread: s.spread, opacity: s.opacity };
  }
  shot.decoration = decoration;
  return shot;
}

/**
 * The serialisable form of a shot.
 *
 * Distinct from `Shot` on exactly one axis, and the distinction is real rather
 * than bookkeeping: IN MEMORY `decoration.annotations` is always an array, so
 * no consumer has to tell "no annotations" from "an older document"; ON DISK a
 * v1 document must not carry the key at all, because shot-1 declares
 * `additionalProperties: false` and a document that fails its own schema is the
 * thing this project keeps paying for (STC-262, STC-311).
 */
export type ShotDocument = Omit<Shot, "decoration"> & {
  decoration: Omit<Decoration, "annotations"> & { annotations?: Annotation[] };
};

/**
 * The document to write: the MINIMUM version that can express it.
 *
 * The one funnel every write goes through, so the version rule lives in one
 * place. Round-tripped through `parseShot` first, deliberately — whatever is
 * written has already been proven readable by the same loader that will read it
 * back, so a shape this build can construct but not load cannot reach the disk.
 */
export function shotForWrite(shot: Shot): ShotDocument {
  const version = versionFor(shot);
  const checked = parseShot(JSON.parse(JSON.stringify({ ...shot, version })));
  const doc: ShotDocument = { ...checked, version };
  // `parseShot` always hands back the array; a v1 document may not carry it.
  if (version === 1) delete doc.decoration.annotations;
  return doc;
}
