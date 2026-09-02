import type { CursorShape } from "./types.js";

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

export interface Rect { x: number; y: number; width: number; height: number }

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
}

export interface Shot {
  version: 1;
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

export const SHOT_VERSIONS: readonly number[] = [1];
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
    version: 1, kind, capturedAtNs: raw.capturedAtNs,
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
  noExtra(dec, ["mode", "paddingPct", "background", "shadow", "canvas", "cursor", "redactions"], "decoration");
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
  const decoration: Decoration = { mode, canvas: dec.canvas as CanvasPreset, cursor: dec.cursor, redactions };
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

/** The document to write. Always the latest version; optional blocks only when set. */
export function shotForWrite(shot: Shot): Shot {
  return parseShot(JSON.parse(JSON.stringify({ ...shot, version: 1 })));
}
