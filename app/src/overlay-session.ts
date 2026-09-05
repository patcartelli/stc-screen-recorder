import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import {
  reduce, confirm, initialState,
  type DisplayInfo, type SelectionContext, type SelectionEvent,
  type SelectionOutcome, type SelectionState, type WindowInfo,
} from "./selection.js";

/**
 * The selection overlay's windows and lifecycle (STC-290).
 *
 * ## One state, many windows
 *
 * There is a transparent window per display, and they are VIEWS ONLY: every
 * pointer and key event is forwarded to this process, reduced by
 * `selection.ts`, and the resulting state is broadcast back to all of them to
 * draw. That is what makes a drag that starts on one display and ends on
 * another work at all — with a state machine per window, the marquee would stop
 * at the bezel, because the window under the pointer changes mid-gesture and
 * neither half would know about the other. It also means the overlay's
 * behaviour is decided by a pure function that `app/test/selection.test.ts`
 * exercises without a display server.
 *
 * ## Getting out of the picture
 *
 * The acceptance list says the overlay must never appear in the captured
 * pixels, and hiding it is necessary but not sufficient: `hide()` and the
 * capture reach the window server through different paths with no ordering
 * between them. So this does BOTH — hides every overlay window, waits for a
 * paint to have gone by, and reports the windows' own ids so the caller can
 * name them in `capture-still`'s `excludeWindowIds`. Either alone is a race;
 * together the window is gone and, if it somehow is not, the filter drops it.
 */

export interface OverlayResult {
  outcome: SelectionOutcome;
  /**
   * The overlay windows' CGWindowIDs, for `capture-still` to exclude. Empty
   * when the platform would not name them, which is not fatal — the hide has
   * already happened and the exclusion is the second belt.
   */
  excludeWindowIds: number[];
}

/**
 * How long to let the window server settle after hiding the overlay.
 *
 * Not a guess dressed as a constant: this is the belt, not the braces. The
 * exclusion list is what makes the capture correct; this only keeps the common
 * case from depending on it. Two frames at 60 Hz, rounded up.
 */
export const HIDE_SETTLE_MS = 40;

/** Electron's display → the pure module's, in the one place that conversion happens. */
export function toDisplayInfo(d: Electron.Display): DisplayInfo {
  return {
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor || 1,
  };
}

/**
 * `"window:12345:0"` → `12345`, Electron's name for a window in the desktop
 * capturer's vocabulary, which on macOS is its CGWindowID — the same number
 * `SCShareableContent` reports and `excludeWindowIds` matches against.
 * Undefined on any platform or version that words it differently, which the
 * caller treats as "no exclusion available" rather than as an error.
 */
export function windowIdOf(mediaSourceId: string): number | undefined {
  const m = /^window:(\d+)/.exec(mediaSourceId);
  if (!m || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let active: OverlaySession | undefined;

/** Whether an overlay is on screen right now. */
export function overlayIsOpen(): boolean { return active !== undefined; }

export interface OpenOptions {
  /** The helper's `windows` reply, already in global points. */
  windows: WindowInfo[];
  /** Where the overlay's HTML and preload live. Injected so tests can point elsewhere. */
  dist: string;
  renderer: string;
}

/**
 * Puts the overlay on every display and resolves once the user has chosen or
 * cancelled. Never rejects: a failure to build the windows resolves as a
 * cancellation, because a selection that cannot be made is indistinguishable
 * from one the user declined to make, and the caller's cleanup is the same.
 */
export async function openOverlay(opts: OpenOptions): Promise<OverlayResult> {
  // One at a time. A second hotkey press while the overlay is up must not
  // stack a second set of windows over the first, leaving the user with an
  // overlay they cannot escape because Escape only reaches the top one.
  if (active) return active.promise;
  const session = new OverlaySession(opts);
  active = session;
  try {
    return await session.run();
  } finally {
    active = undefined;
  }
}

/** Tears down whatever is on screen. Used by quit, and by the tests. */
export async function closeOverlay(): Promise<void> {
  await active?.cancel();
}

class OverlaySession {
  private readonly windows: BrowserWindow[] = [];
  /**
   * Which display each overlay window covers. A map rather than a property on
   * the window: the query string tells the RENDERER which display it is on,
   * and this tells the main process the same thing without re-deriving it from
   * bounds that a display rearrangement may already have changed.
   */
  private readonly displayOf = new Map<BrowserWindow, number>();
  private state: SelectionState = initialState("region");
  private readonly ctx: SelectionContext;
  private settle!: (r: OverlayResult) => void;
  readonly promise: Promise<OverlayResult>;
  private done = false;

  constructor(private readonly opts: OpenOptions) {
    this.ctx = { displays: screen.getAllDisplays().map(toDisplayInfo), windows: opts.windows };
    this.promise = new Promise<OverlayResult>((res) => { this.settle = res; });
  }

  async run(): Promise<OverlayResult> {
    ipcMain.on("overlay:event", this.onEvent);
    try {
      for (const d of screen.getAllDisplays()) this.windows.push(this.makeWindow(d));
      // Focus one of them, or nothing receives the keyboard and Escape is dead.
      this.windows[0]?.focus();
    } catch (e) {
      // A window that cannot be built is a cancellation with the reason logged,
      // never a rejected promise the caller has to unwind a half-open overlay from.
      console.error("[overlay] could not open:", e);
      await this.finish({ kind: "cancelled" });
    }
    return this.promise;
  }

  private makeWindow(d: Electron.Display): BrowserWindow {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
      transparent: true, frame: false, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true,
      // Not shown until it has painted: a transparent window that appears
      // before its first frame flashes the desktop through, which on a dimming
      // overlay reads as a flicker at exactly the moment the ticket says is the
      // whole first impression.
      show: false,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: join(this.opts.dist, "overlay-preload.cjs"),
        contextIsolation: true, nodeIntegration: false,
        // The overlay is one frame of state per event; background throttling
        // would make the marquee lag behind the pointer when unfocused.
        backgroundThrottling: false,
      },
    });
    // Above everything, including other apps' full-screen spaces — the overlay
    // has to cover whatever the user is trying to photograph.
    this.displayOf.set(w, d.id);
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    w.loadFile(join(this.opts.renderer, "overlay.html"),
               { query: { displayId: String(d.id) } });
    w.once("ready-to-show", () => {
      if (this.done) return;
      w.showInactive();
      this.windows[0]?.focus();
      this.push(w);
    });
    return w;
  }

  /** Hand one window everything it needs to draw the current state. */
  private push(w: BrowserWindow): void {
    if (w.isDestroyed()) return;
    const d = this.ctx.displays.find((x) => x.id === this.displayOf.get(w));
    w.webContents.send("overlay:state", {
      display: d,
      displays: this.ctx.displays,
      windows: this.ctx.windows,
      state: this.state,
      preview: confirm(this.state, this.ctx),
    });
  }

  private broadcast(): void { for (const w of this.windows) this.push(w); }

  private onEvent = (_e: unknown, ev: SelectionEvent): void => {
    if (this.done) return;
    const r = reduce(this.state, ev, this.ctx);
    this.state = r.state;
    this.broadcast();
    if (r.outcome) void this.finish(r.outcome);
  };

  async cancel(): Promise<void> { await this.finish({ kind: "cancelled" }); }

  /**
   * Answers exactly once, whichever path gets here first — the same rule the
   * helper's `start` and `stop` follow, and for the same reason: a second
   * answer to one selection would capture twice.
   */
  private async finish(outcome: SelectionOutcome): Promise<void> {
    if (this.done) return;
    this.done = true;
    ipcMain.removeListener("overlay:event", this.onEvent);

    const excludeWindowIds: number[] = [];
    for (const w of this.windows) {
      if (w.isDestroyed()) continue;
      try {
        const id = windowIdOf(w.getMediaSourceId());
        if (id !== undefined) excludeWindowIds.push(id);
      } catch { /* not available here; the hide below still stands */ }
      w.hide();
    }
    await sleep(HIDE_SETTLE_MS);
    for (const w of this.windows) if (!w.isDestroyed()) w.destroy();
    this.windows.length = 0;
    this.displayOf.clear();
    this.settle({ outcome, excludeWindowIds });
  }
}
