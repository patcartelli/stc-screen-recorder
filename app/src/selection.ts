/**
 * The selection overlay's decisions (STC-290), with no DOM and no Electron.
 *
 * Same arrangement `CaptureDecisions.swift` and `StillDecisions.swift` have on
 * the Swift side: everything that DECIDES — what a drag means, which display a
 * marquee belongs to, what a keystroke does, what gets handed to the capture —
 * lives here and is exercised by `app/test/selection.test.ts` without a screen,
 * a pointer or a display server. `app/src/overlay.ts` draws it; it does not
 * repeat it.
 *
 * ## Two coordinate spaces, named
 *
 * GLOBAL points are the desktop's own space: origin at the top-left of the main
 * display, y down, one unit per point. Electron's `screen` module and
 * CoreGraphics agree on it, and the helper's `windows` verb reports window
 * frames in it — so the marquee, the display list and the window list can all
 * be compared without conversion. DISPLAY-LOCAL points are what
 * `capture-still`'s `crop` takes: the same units, but relative to one display's
 * own origin. The conversion happens once, at the hand-off, in `confirm`.
 *
 * ## One overlay, two capture paths
 *
 * Region mode keeps the v1 rule (capture the display, crop at render time) and
 * hands over a display id plus a crop. Window mode cannot keep it — STC-291's
 * transparent modes need the window through its own filter — so it hands over a
 * window id instead. The branch is HERE, at the hand-off, and nowhere in the
 * interaction: everything above `confirm` is the same code for both modes.
 */

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }

/** A display as both Electron's `screen` and the helper describe one. */
export interface DisplayInfo {
  id: number;
  /** GLOBAL points. */
  bounds: Rect;
  /** Pixels per point, for the readout. */
  scaleFactor: number;
}

/** One entry of the helper's `windows` reply. */
export interface WindowInfo {
  id: number;
  /** GLOBAL points. */
  bounds: Rect;
  app?: string;
  title?: string;
}

export type Mode = "region" | "window";
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "w" | "sw";
export interface Modifiers { shift?: boolean; alt?: boolean }

/**
 * The smallest marquee that counts as a selection, in points.
 *
 * A bare click is not a selection — it is how someone dismisses a menu or
 * checks that the overlay has focus, and macOS's own tool ignores it. Below
 * this the state keeps no rect at all, so `confirm` has nothing to hand over
 * and cannot produce the degenerate crop the helper would refuse as `bad-crop`.
 */
export const MIN_SELECTION_POINTS = 4;

/** Arrow-key steps, per the ticket: one point, ten with Shift. */
export const NUDGE_POINTS = 1;
export const NUDGE_POINTS_SHIFT = 10;

export interface SelectionState {
  mode: Mode;
  /** The marquee in GLOBAL points. Absent until a drag has made one. */
  rect?: Rect;
  /** Where the pointer is, in GLOBAL points. Drives the window highlight. */
  pointer?: Point;
  /** Window mode: what the pointer is over right now. */
  hoveredWindowId?: number;
  /** In-flight gesture, if any. */
  drag?: DragState;
}

export type DragState =
  | { kind: "new"; anchor: Point }
  | { kind: "move"; grabbedAt: Point; origin: Rect }
  | { kind: "resize"; handle: Handle; grabbedAt: Point; origin: Rect };

export type SelectionEvent =
  | { t: "pointerdown"; at: Point; mods?: Modifiers; handle?: Handle; onMarquee?: boolean }
  | { t: "pointermove"; at: Point; mods?: Modifiers }
  | { t: "pointerup"; at: Point; mods?: Modifiers }
  | { t: "key"; key: string; mods?: Modifiers };

/**
 * What the overlay hands back. `cancelled` is a real outcome, not an absence:
 * the caller must tear the windows down and write nothing, and the acceptance
 * list makes "no shot.json on disk" a checkable property of it.
 */
export type SelectionOutcome =
  | { kind: "cancelled" }
  | { kind: "region"; displayId: number; crop: Rect; global: Rect }
  | { kind: "window"; windowId: number };

export interface SelectionContext {
  displays: DisplayInfo[];
  /**
   * Front-to-back, as `SCShareableContent` lists them — the helper's `windows`
   * verb preserves that order, and `windowUnderPoint` depends on it: the first
   * match is the one a click would hit.
   */
  windows: WindowInfo[];
}

export interface Reduction {
  state: SelectionState;
  /** Set only when the interaction is over. */
  outcome?: SelectionOutcome;
}

export function initialState(mode: Mode = "region"): SelectionState {
  return { mode };
}

// ── geometry ────────────────────────────────────────────────────────────────

const isFinitePoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/** A rect from two opposite corners, in any order. */
export function rectFromCorners(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

/** Zero when they do not overlap; never negative. */
export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The part of `r` inside `bounds`, or undefined when nothing of it is. */
export function intersect(r: Rect, bounds: Rect): Rect | undefined {
  const x = Math.max(r.x, bounds.x);
  const y = Math.max(r.y, bounds.y);
  const right = Math.min(r.x + r.width, bounds.x + bounds.width);
  const bottom = Math.min(r.y + r.height, bounds.y + bounds.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

/** Integer points. The nudge step is one point, so the rect lives on that grid. */
export function roundRect(r: Rect): Rect {
  const x = Math.round(r.x), y = Math.round(r.y);
  return {
    x, y,
    width: Math.round(r.x + r.width) - x,
    height: Math.round(r.y + r.height) - y,
  };
}

/**
 * The marquee a fresh drag describes.
 *
 * Shift squares it — during a NEW drag there is no prior aspect to preserve, so
 * "constrain ratio" can only mean 1:1, and the square follows the larger of the
 * two deltas so the pointer stays on the diagonal it is nearest. Option draws
 * from the anchor as the CENTRE rather than a corner.
 */
export function dragRect(anchor: Point, current: Point, mods: Modifiers = {}): Rect {
  let dx = current.x - anchor.x;
  let dy = current.y - anchor.y;
  if (mods.shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  if (mods.alt) {
    return { x: anchor.x - Math.abs(dx), y: anchor.y - Math.abs(dy),
             width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 };
  }
  return rectFromCorners(anchor, { x: anchor.x + dx, y: anchor.y + dy });
}

const MOVES_X: Record<Handle, number> = { nw: 1, n: 0, ne: 0, e: 0, se: 0, s: 0, sw: 1, w: 1 };
const MOVES_Y: Record<Handle, number> = { nw: 1, n: 1, ne: 1, e: 0, se: 0, s: 0, sw: 0, w: 0 };
const SIZES_X: Record<Handle, number> = { nw: -1, n: 0, ne: 1, e: 1, se: 1, s: 0, sw: -1, w: -1 };
const SIZES_Y: Record<Handle, number> = { nw: -1, n: -1, ne: -1, e: 0, se: 1, s: 1, sw: 1, w: 0 };

/**
 * The marquee after dragging one handle by (dx, dy).
 *
 * Shift here means what it means everywhere else in a resize: preserve the
 * aspect the marquee had when the handle was grabbed. Option resizes about the
 * rect's centre, so the opposite edge moves out by as much as this one moves in.
 * A drag past the opposite edge flips the rect rather than producing a negative
 * size — the same forgiveness `rectFromCorners` gives a backwards drag.
 */
export function resizeRect(origin: Rect, handle: Handle, dx: number, dy: number,
                           mods: Modifiers = {}): Rect {
  let sx = SIZES_X[handle] * dx;
  let sy = SIZES_Y[handle] * dy;

  if (mods.shift && origin.width > 0 && origin.height > 0) {
    const aspect = origin.width / origin.height;
    // Follow whichever axis the handle actually drives; a corner follows the
    // larger relative change so the pointer leads rather than lags.
    const drivesX = SIZES_X[handle] !== 0;
    const drivesY = SIZES_Y[handle] !== 0;
    if (drivesX && drivesY) {
      if (Math.abs(sx) * origin.height >= Math.abs(sy) * origin.width) sy = sx / aspect;
      else sx = sy * aspect;
    } else if (drivesX) {
      sy = sx / aspect;
    } else if (drivesY) {
      sx = sy * aspect;
    }
  }

  let width: number, height: number, x: number, y: number;
  if (mods.alt) {
    width = origin.width + sx * 2;
    height = origin.height + sy * 2;
    x = origin.x - sx;
    y = origin.y - sy;
  } else {
    width = origin.width + sx;
    height = origin.height + sy;
    // A handle on the left or top edge moves the origin; one on the right or
    // bottom leaves it. Under Shift a corner's paired axis moves too, which is
    // why this reads MOVES_* rather than testing the raw delta.
    x = origin.x - (MOVES_X[handle] ? sx : 0);
    y = origin.y - (MOVES_Y[handle] ? sy : 0);
  }
  // Flip instead of going negative.
  return rectFromCorners({ x, y }, { x: x + width, y: y + height });
}

export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}

/**
 * The display a region belongs to: the one holding most of it.
 *
 * A marquee may span displays — the ticket requires the overlay to track a drag
 * that starts on one and ends on another — but `capture-still` captures ONE
 * display, because "full display is the only capture primitive" is the v1 rule
 * and a cross-display capture has no primitive behind it. So the region is
 * attributed to the display it mostly covers and clipped to it; the overlay
 * shows the clipped rect, so what the readout says is what gets captured rather
 * than what was drawn. Ties go to the lowest id, so the answer is stable.
 */
export function dominantDisplay(r: Rect, displays: DisplayInfo[]): DisplayInfo | undefined {
  let best: DisplayInfo | undefined;
  let bestArea = 0;
  for (const d of [...displays].sort((a, b) => a.id - b.id)) {
    const area = intersectionArea(r, d.bounds);
    if (area > bestArea) { best = d; bestArea = area; }
  }
  return best;
}

export function displayContaining(p: Point, displays: DisplayInfo[]): DisplayInfo | undefined {
  return displays.find((d) => rectContains(d.bounds, p));
}

/** GLOBAL → that display's own points. Assumes `r` overlaps `d`. */
export function toDisplayLocal(r: Rect, d: DisplayInfo): Rect {
  return { x: r.x - d.bounds.x, y: r.y - d.bounds.y, width: r.width, height: r.height };
}

/**
 * The topmost window under the pointer, or undefined over bare desktop.
 *
 * First match wins because the list is front-to-back; the helper's `windows`
 * verb already drops other layers, zero-sized frames and (through
 * `SCShareableContent`'s own filtering) minimised windows, so anything here is
 * something a click could actually hit.
 */
export function windowUnderPoint(windows: WindowInfo[], p: Point): WindowInfo | undefined {
  return windows.find((w) => rectContains(w.bounds, p));
}

/** Pixels for a region on a display, for the live readout. */
export function pixelSize(r: Rect, d: DisplayInfo | undefined): { width: number; height: number } {
  const s = d?.scaleFactor && d.scaleFactor > 0 ? d.scaleFactor : 1;
  return { width: Math.round(r.width * s), height: Math.round(r.height * s) };
}

// ── the hand-off ────────────────────────────────────────────────────────────

/**
 * What the current state would capture, or undefined when it would capture
 * nothing. Pure and side-effect free, so the overlay can call it every frame to
 * label the marquee with the truth rather than with the raw drag.
 */
export function confirm(state: SelectionState, ctx: SelectionContext): SelectionOutcome | undefined {
  if (state.mode === "window") {
    const id = state.hoveredWindowId;
    if (id === undefined) return undefined;
    // Still in the list: a window closed between hover and Return must not be
    // captured by a stale id. The helper refuses an unknown id as
    // `no-such-window`, which is the second half of the same guarantee.
    if (!ctx.windows.some((w) => w.id === id)) return undefined;
    return { kind: "window", windowId: id };
  }

  const r = state.rect;
  if (!r || r.width < MIN_SELECTION_POINTS || r.height < MIN_SELECTION_POINTS) return undefined;
  const display = dominantDisplay(r, ctx.displays);
  if (!display) return undefined;
  const clipped = intersect(r, display.bounds);
  if (!clipped) return undefined;
  const crop = roundRect(toDisplayLocal(clipped, display));
  if (crop.width < 1 || crop.height < 1) return undefined;
  return { kind: "region", displayId: display.id, crop, global: roundRect(clipped) };
}

// ── the state machine ───────────────────────────────────────────────────────

/**
 * One event in, the next state (and an outcome, once there is one) out.
 *
 * Total by construction: an event that means nothing in the current state
 * returns the state unchanged rather than throwing, because the overlay is
 * driven by real input and a stray pointermove after a cancel must not be able
 * to crash the window the user is trying to escape from.
 */
export function reduce(state: SelectionState, ev: SelectionEvent,
                       ctx: SelectionContext): Reduction {
  switch (ev.t) {
    case "pointerdown": {
      if (!isFinitePoint(ev.at)) return { state };
      const pointer = ev.at;
      if (state.mode === "window") {
        // A click in window mode selects what it is over, immediately — the
        // hover already showed exactly what would be taken, so a second
        // confirming gesture would be ceremony.
        const w = windowUnderPoint(ctx.windows, pointer);
        if (!w) return { state: { ...state, pointer } };
        return { state: { ...state, pointer, hoveredWindowId: w.id },
                 outcome: { kind: "window", windowId: w.id } };
      }
      if (ev.handle && state.rect) {
        return { state: { ...state, pointer,
                          drag: { kind: "resize", handle: ev.handle, grabbedAt: pointer, origin: state.rect } } };
      }
      if (ev.onMarquee && state.rect) {
        return { state: { ...state, pointer,
                          drag: { kind: "move", grabbedAt: pointer, origin: state.rect } } };
      }
      // Anywhere else starts a new marquee, discarding the old one.
      return { state: { ...state, pointer, rect: undefined, drag: { kind: "new", anchor: pointer } } };
    }

    case "pointermove": {
      if (!isFinitePoint(ev.at)) return { state };
      const pointer = ev.at;
      const mods = ev.mods ?? {};
      if (state.mode === "window") {
        const w = windowUnderPoint(ctx.windows, pointer);
        return { state: { ...state, pointer, hoveredWindowId: w?.id } };
      }
      const d = state.drag;
      if (!d) return { state: { ...state, pointer } };
      if (d.kind === "new") {
        return { state: { ...state, pointer, rect: dragRect(d.anchor, pointer, mods) } };
      }
      if (d.kind === "move") {
        return { state: { ...state, pointer,
                          rect: moveRect(d.origin, pointer.x - d.grabbedAt.x, pointer.y - d.grabbedAt.y) } };
      }
      return { state: { ...state, pointer,
                        rect: resizeRect(d.origin, d.handle,
                                         pointer.x - d.grabbedAt.x, pointer.y - d.grabbedAt.y, mods) } };
    }

    case "pointerup": {
      const pointer = isFinitePoint(ev.at) ? ev.at : state.pointer;
      if (state.mode === "window" || !state.drag) {
        return { state: { ...state, pointer, drag: undefined } };
      }
      const rect = state.rect;
      // A click with no drag leaves NO marquee — see MIN_SELECTION_POINTS. The
      // drag is cleared either way, so the next move does not keep resizing.
      const keep = rect && rect.width >= MIN_SELECTION_POINTS && rect.height >= MIN_SELECTION_POINTS;
      return { state: { ...state, pointer, drag: undefined, rect: keep ? rect : undefined } };
    }

    case "key": {
      const mods = ev.mods ?? {};
      switch (ev.key) {
        case "Escape":
          return { state, outcome: { kind: "cancelled" } };
        case "Enter": {
          const outcome = confirm(state, ctx);
          return outcome ? { state, outcome } : { state };
        }
        case " ": {
          // Space toggles, matching the macOS screenshot muscle memory. The
          // marquee is KEPT across the toggle so a mis-press costs nothing.
          const mode: Mode = state.mode === "region" ? "window" : "region";
          const hoveredWindowId = mode === "window" && state.pointer
            ? windowUnderPoint(ctx.windows, state.pointer)?.id
            : undefined;
          return { state: { ...state, mode, hoveredWindowId, drag: undefined } };
        }
        case "ArrowLeft": case "ArrowRight": case "ArrowUp": case "ArrowDown": {
          if (state.mode !== "region" || !state.rect) return { state };
          const step = mods.shift ? NUDGE_POINTS_SHIFT : NUDGE_POINTS;
          const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
          const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
          return { state: { ...state, rect: moveRect(state.rect, dx, dy) } };
        }
        default:
          return { state };
      }
    }
  }
}
