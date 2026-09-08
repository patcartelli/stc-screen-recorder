import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import {
  clampTimeoutMs, positionFor, type Corner, type Size, type PanelSettle,
} from "./thumbnail.js";
import { HIDE_SETTLE_MS, windowIdOf } from "./overlay-session.js";

/**
 * The post-capture floating thumbnail's window (STC-296).
 *
 * `thumbnail.ts` decides what STATE the panel is in; this owns the one real
 * `BrowserWindow` and the one real timer that state describes, the same split
 * `overlay-session.ts` makes for the selection overlay. One panel at a time —
 * a capture that arrives while a panel is still up REPLACES it rather than
 * stacking (the ticket's stacking behaviour is deferred, see CLAUDE.md), and
 * the outgoing panel is always SETTLED, never merely discarded, so a rapid
 * second capture cannot cost the first one its save.
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
  | { kind: "done" };

let active: ThumbnailSession | undefined;

/**
 * Put the panel on screen for a fresh capture, replacing whatever panel — if
 * any — was already showing.
 */
export function presentThumbnail(opts: PresentOptions): void {
  const outgoing = active;
  active = new ThumbnailSession(opts);
  // Settled AFTER the new one is already `active`, so a "done" racing back
  // from the outgoing session cannot be mistaken for the new one's.
  outgoing?.settleAndDestroy();
}

/**
 * Get the panel out of a capture's pixels. Hides it (if one is showing) and
 * reports its window id for `excludeWindowIds`, then waits the same settle
 * time the overlay does before returning — belt and braces, exactly as
 * `overlay-session.ts` reasons about it: the exclusion list is what makes the
 * capture correct, this only keeps the common case from depending on it.
 *
 * Does NOT destroy the panel: it is about to be replaced by `presentThumbnail`
 * for the capture this is guarding, and that replacement is what settles it.
 * A caller that hides without following up with a new capture (there is none
 * today) would leave the panel hidden but alive — worth knowing if one is
 * ever added.
 */
export async function beforeCapture(): Promise<number[]> {
  if (!active) return [];
  const id = active.hide();
  await sleep(HIDE_SETTLE_MS);
  return id !== undefined ? [id] : [];
}

/**
 * Tears down whatever panel is on screen, settling it first — quit must not
 * abandon an unsaved capture. Resolves once the window is actually gone
 * (bounded by `SETTLE_BACKSTOP_MS`, same as the timeout path), so a caller
 * that awaits this before quitting cannot destroy the process out from under
 * the export it just asked for.
 */
export function closeThumbnail(): Promise<void> {
  const session = active;
  if (!session) return Promise.resolve();
  session.settleAndDestroy();
  return session.waitUntilClosed();
}

/** Whether a panel is on screen right now, for tests. */
export function thumbnailIsOpen(): boolean { return active !== undefined; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ThumbnailSession {
  private readonly win: BrowserWindow;
  private timer?: NodeJS.Timeout;
  private backstop?: NodeJS.Timeout;
  private done = false;
  private expanded = false;
  /**
   * Whether the page has loaded far enough to be listening.
   *
   * `webContents.send` to a renderer whose scripts have not run yet is DROPPED
   * — silently, with no error and no queue — so a settle sent into that window
   * is simply lost.
   *
   * **This was NOT what gate 4 caught**, and saying so matters: it was the
   * first hypothesis, it was implemented, and the measurement was unchanged at
   * five captures / three exports. The actual cause was in the renderer
   * (`runExport`'s `if (!composite) return false`). This stayed because the
   * renderer-side fix can only run if the message ARRIVES, so the two are
   * complementary — but nothing here has been observed failing, and it should
   * be read as a guard rather than as a fix for a measured fault.
   */
  private loaded = false;
  private pendingSettle = false;
  private readonly corner: Corner;
  private resolveClosed!: () => void;
  private readonly closed: Promise<void>;

  constructor(private readonly opts: PresentOptions) {
    this.closed = new Promise((res) => { this.resolveClosed = res; });
    this.corner = opts.corner;
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
      if (active === this) active = undefined;
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
    const { x, y } = positionFor(this.corner, this.workArea(), size, CORNER_MARGIN);
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
    if (active === this) active = undefined;
  }
}

// Every export request goes through `ipcMain.handle("still:export", ...)`
// (`main.ts`), which is Electron-agnostic about WHICH window called it — the
// thumbnail's own preload reaches it the same way the main window's does.
// Nothing here duplicates that handler; see `app/src/still-io.ts`'s header.
