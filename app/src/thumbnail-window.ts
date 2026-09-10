import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import {
  clampTimeoutMs, positionFor, stackPosition, MAX_STACKED,
  type Corner, type Size, type PanelSettle,
} from "./thumbnail.js";
import { HIDE_SETTLE_MS, windowIdOf } from "./overlay-session.js";

/**
 * The post-capture floating thumbnail's window (STC-296).
 *
 * `thumbnail.ts` decides what STATE a panel is in; this owns the real
 * `BrowserWindow`s and the real timers that state describes, the same split
 * `overlay-session.ts` makes for the selection overlay.
 *
 * Captures STACK, newest at the corner, up to `MAX_STACKED`. A panel pushed
 * out by the cap is SETTLED, never merely dropped — the promise that made
 * replacing safe before stacking existed, and the reason a burst of captures
 * has never cost anyone a shot.
 *
 * Every panel keeps its OWN timer, armed when it paints, which is what makes
 * the ticket's "drains oldest-first on timeout" true without a queue: panels
 * that appeared in order expire in order. A central drain would have taken
 * that away and then had to reimplement it.
 *
 * ## Timeout dismissal must never block on a render (the ticket's own words)
 *
 * When the timer fires, or when a capture arrives and needs the outgoing panel
 * out of the way, this hides the window IMMEDIATELY and only afterwards tells
 * the renderer to composite and export the shot. The window stays alive but
 * invisible until the renderer confirms it is done — visually gone at once,
 * while the save it promised still happens. A backstop bounds that wait: a
 * renderer that never answers must not leak a hidden window forever.
 *
 * ## The `skip` panel drives itself
 *
 * A `silent` panel is never shown at all — there is nothing to animate or
 * expand into — so it has no reason to wait on a "painted" round trip through
 * main the way a visible panel does before its timer can start. It composites
 * and exports itself the moment `draw()` finishes (`?silent=1`,
 * `thumbnail-renderer.ts`) and reports only `"done"` when it is. One fewer
 * message crossing the process boundary for a window nobody ever sees.
 */

const COLLAPSED_SIZE: Size = { width: 220, height: 150 };
const EXPANDED_SIZE: Size = { width: 300, height: 260 };
/**
 * Redact mode's size (STC-297). Bigger than the panel needs to be for its own
 * controls, and deliberately: at the expanded size one preview pixel of a 4K
 * capture is ~14 real ones, so placing a box over an email address would be
 * guesswork. This is the size at which a line of text is a target. It is still
 * the same panel in the same corner — the still EDITOR is STC-300, and this
 * stops well short of one.
 */
const REDACT_SIZE: Size = { width: 520, height: 420 };
const CORNER_MARGIN = 20;

/**
 * How long to wait for the renderer's "done" after telling it to settle,
 * before giving up and destroying the window anyway. A hidden window that
 * never closes is invisible on screen but not gone — it would still show up
 * in `app.getAllWindows()`, in Mission Control's spaces bookkeeping, and in
 * the next capture's exclusion list forever pointing at a stale id.
 */
export const SETTLE_BACKSTOP_MS = 15_000;

export interface PresentOptions {
  dir: string;
  /** The shot document exactly as `capture-still` wrote it — not yet parsed. */
  shot: unknown;
  corner: Corner;
  timeoutMs: number;
  settleAction: PanelSettle;
  /** Where `thumbnail.html` and its preload live. */
  dist: string;
  rendererDir: string;
  /**
   * The "skip the panel" preference: never shown, settled the instant it has
   * composited. Still a real (hidden) window rather than a second compositing
   * path — reusing the one the panel already has is exactly what STC-293's
   * Note forbids a second implementation of.
   */
  silent?: boolean;
}

type ThumbEvent =
  | { kind: "painted" }
  | { kind: "expanded" }
  /** Redact mode opening or closing (STC-297), which the panel is resized for. */
  | { kind: "redact"; on: boolean }
  /**
   * A discard has committed — the swipe passed its threshold, or the
   * right-click Delete — and the renderer is about to ask main to trash the
   * capture (STC-343). The panel's own timeout has no idea a discard is in
   * flight, so without this it can fire in the gap between here and the
   * delete resolving: `settleAndDestroy()` would hide the window and arm its
   * own backstop, and if the delete then FAILS, the renderer's recovery (it
   * restores the panel and reports the error) happens inside a window main
   * has already hidden — invisible, and still headed for a silent destroy at
   * `SETTLE_BACKSTOP_MS` regardless of the failure. Stopping the timer the
   * moment the gesture commits closes the gap rather than narrowing it.
   */
  | { kind: "discarding" }
  | { kind: "done" };

/**
 * Every panel on screen, NEWEST FIRST.
 *
 * Was a single slot until stacking: a capture arriving while a panel was up
 * replaced it. It still settles what it displaces — that was always true, and
 * is why nothing was lost by replacing — but a burst of captures now leaves a
 * legible stack instead of one survivor.
 */
let panels: ThumbnailSession[] = [];

/**
 * Put the panel on screen for a fresh capture, replacing whatever panel — if
 * any — was already showing.
 */
export function presentThumbnail(opts: PresentOptions): void {
  panels.unshift(new ThumbnailSession(opts));
  // Over the cap, the oldest is SETTLED to make room — never merely dropped,
  // which is the same promise replacing always kept.
  const overflow = panels.slice(MAX_STACKED);
  for (const old of overflow) old.settleAndDestroy();
  restack();
}

/**
 * Put every panel where its position in the stack says it belongs.
 *
 * Called whenever the list changes — a new capture, or one settling out of the
 * middle — because every panel's place is a function of the whole stack, not
 * of where it happened to start.
 */
function restack(): void {
  panels.forEach((p, i) => p.moveToStackIndex(i));
}

/**
 * Get the panel out of a capture's pixels. Hides it (if one is showing) and
 * reports its window id for `excludeWindowIds`, then waits the same settle
 * time the overlay does before returning — belt and braces, exactly as
 * `overlay-session.ts` reasons about it: the exclusion list is what makes the
 * capture correct, this only keeps the common case from depending on it.
 *
 * Does NOT destroy the panels: they are hidden for the duration of one capture
 * and `presentThumbnail` shows the stack again. A caller that hides without
 * following up with a new capture (there is none today) would leave them
 * hidden but alive — worth knowing if one is ever added.
 */
export async function beforeCapture(): Promise<number[]> {
  if (panels.length === 0) return [];
  // EVERY panel, not just the newest. With a stack, excluding one and leaving
  // the rest visible would photograph the others — the exact failure
  // `excludeWindowIds` exists to prevent, reintroduced by the feature that
  // made more than one panel possible.
  const ids = panels.map((p) => p.hide()).filter((id): id is number => id !== undefined);
  await sleep(HIDE_SETTLE_MS);
  return ids;
}

/**
 * Put the stack back on screen after a capture.
 *
 * The counterpart to `beforeCapture`, and it has to be called on EVERY exit
 * from a capture — including a cancelled one. `beforeCapture` hides panels
 * that are not about to be replaced (a stack persists where a single panel
 * used to be destroyed), so without this a cancelled selection would leave
 * the whole stack invisible while its timers ran on, and the shots would
 * settle out of sight.
 */
export function afterCapture(): void {
  for (const p of panels) p.reshow();
}

/**
 * Tears down whatever panel is on screen, settling it first — quit must not
 * abandon an unsaved capture. Resolves once the window is actually gone
 * (bounded by `SETTLE_BACKSTOP_MS`, same as the timeout path), so a caller
 * that awaits this before quitting cannot destroy the process out from under
 * the export it just asked for.
 */
export function closeThumbnail(): Promise<void> {
  // A copy: settling mutates `panels` as each one closes.
  const all = [...panels];
  if (all.length === 0) return Promise.resolve();
  for (const p of all) p.settleAndDestroy();
  return Promise.all(all.map((p) => p.waitUntilClosed())).then(() => undefined);
}

/** Whether any panel is on screen right now, for tests. */
export function thumbnailIsOpen(): boolean { return panels.length > 0; }

/** How many are stacked right now, for tests. */
export function thumbnailCount(): number { return panels.length; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ThumbnailSession {
  private readonly win: BrowserWindow;
  private timer?: NodeJS.Timeout;
  private backstop?: NodeJS.Timeout;
  private done = false;
  private expanded = false;
  /**
   * It has painted at least once, so it is a panel the user has SEEN.
   *
   * `showInactive` is called on the one-time `painted` event, so re-showing a
   * panel hidden for a capture cannot go through that path — and showing one
   * that has never painted would flash the desktop through a transparent
   * window, which is the reason `show: false` is set in the first place.
   */
  private hasPainted = false;
  /** Where in the stack this panel currently sits; 0 is the newest. */
  private stackIndex = 0;
  /**
   * Whether the page has loaded far enough to be listening.
   *
   * `webContents.send` to a renderer whose scripts have not run yet is DROPPED
   * — silently, with no error and no queue — so a settle sent into that window
   * is simply lost, and `SETTLE_BACKSTOP_MS` then destroys it having exported
   * nothing.
   *
   * **Nothing has been observed failing here, and that is stated rather than
   * implied.** It was STC-301 gate 4's first hypothesis, it was implemented,
   * and the measurement did not move — the real cause was in the renderer
   * (`runExport`'s `if (!composite) return false`, fixed by #102). The path
   * that motivated it is gone as well: a capture used to REPLACE and settle a
   * panel that might still be loading, and captures stack now (#104). What is
   * left is the overflow eviction above `MAX_STACKED`, which settles the
   * OLDEST panel and so will almost always have painted.
   *
   * Kept anyway because it is orthogonal to stacking and cheap, and because
   * the renderer's own bounded wait can only run if the message ARRIVES. Read
   * it as a guard, not as a fix for a measured fault.
   */
  private loaded = false;
  private pendingSettle = false;
  private readonly corner: Corner;
  private resolveClosed!: () => void;
  private readonly closed: Promise<void>;

  constructor(private readonly opts: PresentOptions) {
    this.closed = new Promise((res) => { this.resolveClosed = res; });
    this.corner = opts.corner;
    // At the corner: a new panel is always the newest, so index 0. `restack`
    // moves the ones behind it immediately afterwards.
    const { x, y } = positionFor(this.corner, this.workArea(), COLLAPSED_SIZE, CORNER_MARGIN);
    this.win = new BrowserWindow({
      x, y, width: COLLAPSED_SIZE.width, height: COLLAPSED_SIZE.height,
      transparent: true, frame: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true,
      // Not shown before its first paint — the same reason the overlay isn't:
      // a transparent window shown empty flashes the desktop through it.
      show: false,
      webPreferences: {
        preload: join(opts.dist, "thumbnail-preload.cjs"),
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(join(opts.rendererDir, "thumbnail.html"), {
      query: {
        dir: opts.dir,
        shot: JSON.stringify(opts.shot),
        settleAction: opts.settleAction,
        // The view needs it too, and only for the swipe: which way is
        // off-screen is a property of where the panel was put.
        corner: opts.corner,
        ...(opts.silent ? { silent: "1" } : {}),
      },
    });
    this.win.webContents.on("ipc-message", (_e, channel, ev: ThumbEvent) => {
      if (channel === "thumbnail:event") this.onEvent(ev);
    });
    // The renderer registers its listeners at module scope, so this is the
    // first moment a `send` can be heard. A settle that arrived before it is
    // delivered here rather than lost.
    this.win.webContents.once("did-finish-load", () => {
      this.loaded = true;
      if (this.pendingSettle && !this.done && !this.win.isDestroyed()) {
        this.win.webContents.send("thumbnail:settle");
      }
    });
    this.win.on("closed", () => {
      this.done = true; this.clearTimers();
      this.leaveStack();
      this.resolveClosed();
    });
  }

  waitUntilClosed(): Promise<void> { return this.closed; }

  private workArea(): { x: number; y: number; width: number; height: number } {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  }

  private onEvent(ev: ThumbEvent): void {
    if (this.done) return;
    if (ev.kind === "painted") {
      // Never sent by a `silent` panel — see the class doc's "drives itself".
      this.hasPainted = true;
      this.win.showInactive();
      this.armTimer();
    } else if (ev.kind === "expanded") {
      this.expanded = true;
      this.clearTimers();
      this.resizeTo(EXPANDED_SIZE);
    } else if (ev.kind === "redact") {
      // Redact mode is only ever entered from the expanded panel, so the timer
      // is already cancelled; clearing again costs nothing and means this does
      // not depend on that staying true.
      this.expanded = true;
      this.clearTimers();
      this.resizeTo(ev.on ? REDACT_SIZE : EXPANDED_SIZE);
    } else if (ev.kind === "discarding") {
      // Not `expanded` — a discarded panel is not an expanded one, and
      // `armTimer`'s own guard is moot once the timer it would check is gone.
      this.clearTimers();
    } else if (ev.kind === "done") {
      this.destroy();
    }
  }

  /**
   * Grow or shrink in place, staying in ITS corner. Recomputed rather than
   * kept as an offset: a panel in the bottom-right that grew by moving its
   * origin would walk off the bottom of the display.
   */
  private resizeTo(size: Size): void {
    if (this.done || this.win.isDestroyed()) return;
    // Through `stackPosition`, not `positionFor`: a panel expanded from the
    // middle of a stack must grow where it IS, not jump to the corner.
    const { x, y } = stackPosition(this.stackIndex, this.corner, this.workArea(),
                                   size, CORNER_MARGIN);
    this.win.setBounds({ x, y, width: size.width, height: size.height });
  }

  private armTimer(): void {
    this.timer = setTimeout(() => {
      if (this.done || this.expanded) return;
      this.settleAndDestroy();
    }, clampTimeoutMs(this.opts.timeoutMs));
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.backstop) clearTimeout(this.backstop);
    this.timer = undefined;
    this.backstop = undefined;
  }

  /**
   * Show a panel that was hidden for a capture.
   *
   * Only one that has already painted: see `hasPainted`. Never re-arms the
   * timer — it was armed when the panel first appeared and has been running
   * throughout, which is what keeps a panel's lifetime the length the user was
   * promised rather than being extended by every capture that hides it.
   */
  reshow(): void {
    if (this.done || this.win.isDestroyed() || !this.hasPainted) return;
    if (!this.win.isVisible()) this.win.showInactive();
  }

  /** Hides the window and returns its CGWindowID, for `beforeCapture`. */
  hide(): number | undefined {
    if (this.done || this.win.isDestroyed()) return undefined;
    let id: number | undefined;
    try { id = windowIdOf(this.win.getMediaSourceId()); } catch { /* not available; hide still stands */ }
    this.win.hide();
    return id;
  }

  /**
   * Hide now, tell the renderer to composite-and-export in the background, and
   * destroy once it confirms — or after the backstop, whichever is first. Safe
   * to call more than once; only the first call does anything.
   */
  settleAndDestroy(): void {
    if (this.done) return;
    this.clearTimers();
    this.hide();
    if (this.win.isDestroyed()) { this.destroy(); return; }
    // Held until the page is listening, rather than sent into a void — see
    // `loaded`. The backstop is armed either way, so a page that never loads
    // still gets torn down instead of leaking a hidden window.
    if (this.loaded) this.win.webContents.send("thumbnail:settle");
    else this.pendingSettle = true;
    this.backstop = setTimeout(() => this.destroy(), SETTLE_BACKSTOP_MS);
  }

  private destroy(): void {
    if (this.done) return;
    this.done = true;
    this.clearTimers();
    if (!this.win.isDestroyed()) this.win.destroy();
    this.leaveStack();
  }

  /**
   * Drop out of the stack and close the gap.
   *
   * A panel can settle from the MIDDLE — its own timeout, or a click on Close
   * — so the ones behind it have to move up. Without the restack they would
   * keep a hole where it was, which reads as a panel that failed to appear.
   */
  private leaveStack(): void {
    const at = panels.indexOf(this);
    if (at === -1) return;
    panels.splice(at, 1);
    restack();
  }

  /** Move to the place `index` in the stack says, keeping its current size. */
  moveToStackIndex(index: number): void {
    if (this.done || this.win.isDestroyed()) return;
    this.stackIndex = index;
    const { width, height } = this.win.getBounds();
    const { x, y } = stackPosition(index, this.corner, this.workArea(),
                                   { width, height }, CORNER_MARGIN);
    this.win.setBounds({ x, y, width, height });
  }
}

// Every export request goes through `ipcMain.handle("still:export", ...)`
// (`main.ts`), which is Electron-agnostic about WHICH window called it — the
// thumbnail's own preload reaches it the same way the main window's does.
// Nothing here duplicates that handler; see `app/src/still-io.ts`'s header.
