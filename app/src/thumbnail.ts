/**
 * The post-capture floating thumbnail's decisions (STC-296), with no DOM and no
 * Electron.
 *
 * Same split the rest of this project uses for a windowed interaction
 * (`selection.ts` / `overlay-session.ts`, `still-decorate.ts` / `still-render.ts`):
 * what the panel IS at any moment — showing, expanded, expired — lives here and
 * is exercised by `app/test/thumbnail.test.ts` with no window and no timer.
 * `app/src/thumbnail-window.ts` owns the real `BrowserWindow` and the real
 * `setTimeout`; it asks this module what they mean.
 *
 * ## What this slice covers, and what it does not
 *
 * The ticket's full scope is a stack of independently-shippable pieces: the
 * panel itself (appear, expand, timeout, save-on-ignore), true OS drag-out
 * (`NSFilePromiseProvider`), a right-click menu, and multiple captures
 * stacking rather than replacing. This module — and STC-296 in this pass —
 * is the FIRST of those: one panel at a time, replaced (not stacked) by a
 * capture that arrives while it is still showing. The right-click menu and
 * swipe-to-discard have since landed; drag-out and stacking are still
 * follow-up work. See CLAUDE.md.
 *
 * ## Why the clock is a parameter
 *
 * `reduce` and `tick` take `now` rather than reading `Date.now()`, the same
 * rule `render()` follows for the transform: a decision that reads its own
 * clock cannot be replayed in a test, and "the timeout fired" needs to be
 * producible on demand rather than waited for.
 */

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

export const DEFAULT_CORNER: Corner = "bottom-right";

/** A corner named in a stored preference or a hand-edited file; anything else is the default. */
export function parseCorner(v: unknown): Corner {
  return typeof v === "string" && (CORNERS as readonly string[]).includes(v) ? v as Corner : DEFAULT_CORNER;
}

/**
 * The ticket's own numbers: "default ~6 s, configurable, never less than 3."
 * The floor is not a taste — a panel that can be configured to vanish
 * instantly is a panel that can lose a capture nobody had time to look at,
 * which is exactly what "nothing is ever lost by doing nothing" forbids.
 */
export const DEFAULT_THUMBNAIL_TIMEOUT_MS = 6000;
export const MIN_THUMBNAIL_TIMEOUT_MS = 3000;

/** A stored value is trusted only as far as it is a finite number at or above the floor. */
export function clampTimeoutMs(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : DEFAULT_THUMBNAIL_TIMEOUT_MS;
  return Math.max(MIN_THUMBNAIL_TIMEOUT_MS, n);
}

/** What "ignoring the panel" does with the shot — a preference (ticket's Preferences section). */
export type SettleAction = "save" | "copy";

export function parseSettleAction(v: unknown): SettleAction {
  return v === "copy" ? "copy" : "save";
}

/**
 * The panel's own state machine. `showing` while the timeout can still fire;
 * `expanded` once the user has clicked it, which is a ONE-WAY door in this
 * slice — there is no second timeout after expand, the same way macOS's own
 * screenshot thumbnail waits forever once Markup is open. Getting back to
 * `idle` from `expanded` needs an explicit action (Copy, Save, or Close), never
 * a clock.
 */
export type ThumbnailState =
  | { kind: "idle" }
  | { kind: "showing"; expiresAt: number }
  | { kind: "expanded" };

export function initialState(): ThumbnailState { return { kind: "idle" }; }

/**
 * A capture arrived. Always transitions to `showing`, whatever the previous
 * state was — a second capture while one panel is still up REPLACES it
 * (stacking is deferred, see the module doc), and the caller is the one
 * responsible for destroying whatever window the previous state pointed at.
 */
export function show(now: number, timeoutMs: number): ThumbnailState {
  return { kind: "showing", expiresAt: now + clampTimeoutMs(timeoutMs) };
}

/** The click. A no-op from `idle` — there is nothing to expand — and idempotent from `expanded`. */
export function expand(state: ThumbnailState): ThumbnailState {
  return state.kind === "idle" ? state : { kind: "expanded" };
}

/**
 * Whether the panel should settle now — the timeout firing while still
 * collapsed. Never true once expanded: the click already means the user is
 * looking at it, and settling out from under them would be the "copy and
 * vanish" behaviour the ticket explicitly rejects.
 */
export function isExpired(state: ThumbnailState, now: number): boolean {
  return state.kind === "showing" && now >= state.expiresAt;
}

/**
 * Back to nothing on screen — a completed settle (timeout or explicit Close),
 * or a finished Copy/Save. Idempotent, the same rule `overlay-session.ts`'s
 * `finish` follows: whichever path gets here first is the answer.
 */
export function dismiss(): ThumbnailState { return { kind: "idle" }; }

// ── swipe to discard ────────────────────────────────────────────────────────

/**
 * Throwing the shot away by pushing the panel off the screen (STC-296's
 * "swipe the panel off-screen to discard the shot entirely").
 *
 * ## Why the corner decides the direction
 *
 * The panel sits in a corner, so only ONE horizontal direction takes it off
 * the screen — right from a right-hand corner, left from a left-hand one.
 * Accepting either direction would mean a shot could be destroyed by a drag
 * that visibly moved it further INTO the screen, which reads as a bug however
 * it is documented. It also makes the gesture self-describing: the panel
 * follows the pointer, and the direction that makes it leave is the one where
 * you can see it leaving.
 *
 * ## The same gesture also starts a drag-out, and direction is what tells them apart
 *
 * A drag toward the near edge discards; a drag ANY OTHER WAY hands the file to
 * whatever it is dropped on (`classifyDrag`). One pointer gesture, two
 * outcomes, and nothing but its direction to choose between them — which is
 * the arrangement macOS's own screenshot thumbnail uses, and the reason the
 * corner had to be in this decision from the start rather than being added
 * for the second feature.
 *
 * It also means the two can never both fire: `classifyDrag` returns ONE
 * answer, so a drag cannot discard a shot it has just handed to Finder.
 *
 * ## Why discarding is not the same risk as it looks
 *
 * This is the only gesture in the panel that destroys a capture, in a feature
 * whose stated principle is "nothing is ever lost by doing nothing". Doing
 * nothing still saves; this is doing SOMETHING, deliberately, and it goes to
 * the Trash exactly like the right-click Delete it shares its semantics with.
 * Two ways to throw a shot away that disagreed about where it went would be
 * the defect, not the second gesture.
 */

/** Which way is off-screen from a given corner: -1 is left, +1 is right. */
export function discardDirection(corner: Corner): -1 | 1 {
  return corner.endsWith("left") ? -1 : 1;
}

/**
 * How far the panel must travel along that direction before releasing throws
 * the shot away.
 *
 * 90 px against a 220 px collapsed panel — a little under half its own width,
 * so the panel is visibly on its way out before the threshold is met. Below
 * about a third it starts to compete with the click that expands the panel,
 * which is the gesture immediately next to this one in the same pixels.
 */
export const SWIPE_DISCARD_PX = 90;

/**
 * A drag has to be predominantly horizontal to count.
 *
 * Without this a slow diagonal drag reaches the distance eventually and
 * destroys a capture the user was not aiming at. `>` rather than `>=` so a
 * perfect 45° diagonal — genuinely ambiguous — does not discard.
 */
export function isHorizontal(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy);
}

/**
 * How far the panel should be DRAWN from its resting place, in pixels.
 *
 * Only ever along the discard direction: a drag the wrong way returns 0, so
 * the panel does not budge and the gesture reads as "that is not a thing you
 * can do here" without needing to be told. Vertical movement never displaces
 * it either — this panel leaves sideways or not at all.
 */
export function swipeOffset(dx: number, dy: number, corner: Corner): number {
  if (!isHorizontal(dx, dy)) return 0;
  const along = dx * discardDirection(corner);
  return along > 0 ? along : 0;
}

/**
 * Whether releasing here throws the shot away.
 *
 * Deliberately a function of the WHOLE gesture (its total delta), not of
 * velocity: a flick and a slow shove both mean the same thing, and a velocity
 * threshold would make the panel's behaviour depend on how fast the machine
 * happened to deliver pointer events — which on a loaded machine is the same
 * class of defect as every timing-dependent test in this repo.
 */
export function isDiscardSwipe(dx: number, dy: number, corner: Corner): boolean {
  return swipeOffset(dx, dy, corner) >= SWIPE_DISCARD_PX;
}

/**
 * What a drag on the collapsed panel MEANS.
 *
 * `none` while it is still small enough to be a click — the panel expands on
 * click, and that gesture lives in these same pixels, so nothing may commit
 * until the pointer has clearly left. `discard` toward the near edge.
 * `drag-out` any other way, which is where the OS takes over.
 *
 * Note the asymmetry, and that it is deliberate: `discard` needs
 * `SWIPE_DISCARD_PX` of travel because it destroys something, while
 * `drag-out` commits at `DRAG_START_PX` because the OS drag it starts is
 * itself cancellable — dropping on nothing does nothing. The cheap-to-undo
 * gesture is the easy one to reach.
 */
export type DragIntent = "none" | "discard" | "drag-out";

/**
 * How far the pointer must move before a drag-out is a drag rather than a
 * click that wobbled. Below this the panel still expands on release.
 */
export const DRAG_START_PX = 12;

export function classifyDrag(dx: number, dy: number, corner: Corner): DragIntent {
  const toward = dx * discardDirection(corner);
  // The discard axis first: a long horizontal push toward the edge is the one
  // gesture that must not be mistaken for anything else.
  if (isHorizontal(dx, dy) && toward >= SWIPE_DISCARD_PX) return "discard";
  if (Math.hypot(dx, dy) < DRAG_START_PX) return "none";
  // Still travelling toward the edge, just not far enough yet. Committing to
  // a drag-out here would make the discard unreachable: the OS would take the
  // pointer at 12 px and the swipe could never reach 90.
  if (isHorizontal(dx, dy) && toward > 0) return "none";
  return "drag-out";
}

export interface Size { width: number; height: number }
export interface Bounds { x: number; y: number; width: number; height: number }

/**
 * Where the panel sits within a display's WORK AREA (not its full bounds) —
 * work area excludes the menu bar and the Dock, and a "borderless always-on-top
 * panel in a configurable corner" landing partly under the menu bar would read
 * as a bug on the first launch.
 */
export function positionFor(corner: Corner, workArea: Bounds, size: Size, margin = 20): { x: number; y: number } {
  const x = corner.endsWith("left") ? workArea.x + margin
    : workArea.x + workArea.width - size.width - margin;
  const y = corner.startsWith("top") ? workArea.y + margin
    : workArea.y + workArea.height - size.height - margin;
  return { x: Math.round(x), y: Math.round(y) };
}
