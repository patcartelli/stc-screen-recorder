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
 * capture that arrives while it is still showing. Drag-out, the right-click
 * menu, and stacking are follow-up work; see CLAUDE.md.
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
 * What the PANEL may be told to do on settle — a superset of the preference.
 *
 * `"none"` closes without exporting anything, and exists for exactly one
 * caller: a shot RE-OPENED from the library (STC-294). A fresh capture exists
 * nowhere but the panel, which is why ignoring it still saves — "there is no
 * path where a capture is silently lost" is STC-296's own acceptance
 * criterion. A re-opened shot is already on disk, so applying that rule to it
 * would mean glancing at yesterday's screenshot and silently writing a second
 * copy of it into the destination folder, which is the app inventing work
 * nobody asked for.
 *
 * It is deliberately NOT reachable from `parseSettleAction`, so no stored
 * preference and no settings round trip can ever select it: a user who chose
 * "none" for their captures would be choosing to lose them.
 */
export type PanelSettle = SettleAction | "none";

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
