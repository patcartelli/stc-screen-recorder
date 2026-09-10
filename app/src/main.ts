import {
  app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, screen, Menu, nativeImage,
} from "electron";
import { readSettings, writeSettings, type Settings } from "./settings.js";
import {
  CAPTURE_ACTIONS, DEFAULT_SHORTCUTS, planShortcuts,
  type CaptureAction, type ShortcutReport, type Shortcuts,
} from "./hotkeys.js";
import { installTray, type TrayHandle } from "./tray.js";
import {
  thumbnailMenuTemplate, type ThumbMenuContext, type ThumbMenuId,
} from "./thumbnail-menu.js";
import { playShutter } from "./shutter.js";
import {
  CLIPBOARD_SUBDIR, exportStill, plannedFileName, resolveExportOptions,
  type CompositedStill, type ExportTarget,
} from "./still-io.js";
import { colorSpaceFor, type ExportOptions } from "@transform/still-export.js";
import { parseShot, shotForWrite } from "@transform/shot.js";
import { isProjectVersion } from "@transform/project-version.js";
import {
  DEFAULT_EMBED_TEMPLATE, embedSnippet, exportManifestName, exportMediaName, planPublish,
  publicSrc, type PublishPlan,
} from "./share.js";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, stat, open, copyFile, rm } from "node:fs/promises";
import { HelperSupervisor } from "./supervisor.js";
import { newTakeDir, takesRoot, setTakeLabel, insideTakesRoot, duplicateTake } from "./takes.js";
import { listTakes, listLibrary, THUMBNAIL_FILE } from "./library.js";
import { openOverlay, closeOverlay, overlayIsOpen } from "./overlay-session.js";
import type { WindowInfo } from "./selection.js";
import {
  presentThumbnail, beforeCapture as hideThumbnailForCapture,
  afterCapture as showThumbnailsAfterCapture, closeThumbnail,
} from "./thumbnail-window.js";

/**
 * Electron main process. Owns the helper: it is spawned as a CHILD of this
 * process, which is what gives it this app's TCC identity — one grant, against
 * the signed bundle the user recognises, rather than a second opaque helper
 * appearing in System Settings (PHASE-0 §6, demonstrated in increment 2).
 */

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Overridable for the same reason STC_RECORDINGS_DIR is: the E2E suite needs to
 * drive the real start path against a stand-in, because the real helper cannot
 * record without a Screen Recording grant and CI has no way to give one. Also
 * useful for pointing the app at a debug build.
 */
const HELPER = process.env.STC_HELPER_BIN
  || join(here, "..", "..", "helper", "build", "stc-helper");

let win: BrowserWindow | undefined;
let sup: HelperSupervisor | undefined;
/** The take the renderer may currently read, set only by preview:open. */
let openTake: string | undefined;
let tray: TrayHandle | undefined;
let shortcuts: Shortcuts = { ...DEFAULT_SHORTCUTS };
let shortcutReport: ShortcutReport[] = [];
/**
 * A capture is in flight. Not derived from `overlayIsOpen()`: a full-display
 * shot opens no overlay, and the window between the request and the helper's
 * reply is exactly when a second hotkey press would arrive.
 */
let capturing = false;
/**
 * The last still THIS process wrote, for `still:reveal` (STC-293).
 *
 * Remembered here rather than passed back through the renderer because a
 * destination folder is by definition outside the recordings root, so
 * `recorder:reveal`'s "inside the recordings folder" guard correctly refuses
 * it — and widening that guard to accept a renderer-supplied path would hand
 * the sandboxed renderer the ability to open anything. A path the main process
 * produced itself needs no guard at all.
 */
let lastStillFile: string | undefined;

// The renderer is sandboxed and cannot read files. It gets bytes over IPC and
// never names a path: it may ask for one of a few fixed filenames, and only
// from the take the main process deliberately opened.
//
// A custom protocol was the first attempt and cannot work here — the window is
// loaded from file://, and Chromium refuses cross-origin fetches from a file
// origin to any non-http scheme. Serving the app itself over a custom scheme
// would fix that, but IPC removes the origin question altogether.
const TAKE_FILES = new Set(["anchors.json", "events.json", "display.mp4", "camera.mp4", "project.json"]);

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  setDockVisible(true);
  win = new BrowserWindow({
    width: 520, height: 680, title: "stc recorder",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(join(here, "..", "renderer", "index.html"));
}

/**
 * Menu-bar first (STC-292): no Dock icon while no window is open.
 *
 * The whole point of the hotkey and the menu-bar item is that a capture never
 * needs the app brought forward, and an app that keeps a bouncing Dock icon
 * for a window nobody has open contradicts that every time the user looks at
 * the Dock. The icon comes back the moment there IS a window, because a window
 * with no Dock icon cannot be found again after it is hidden behind something.
 *
 * The cost is stated rather than hidden: with the icon gone, `app.on("activate")`
 * can no longer fire, so the menu bar is the only way back in. That is why
 * `installTray` runs before the first window and why its Quit item is not
 * optional.
 */
function setDockVisible(visible: boolean): void {
  if (process.platform !== "darwin") return;
  try {
    if (visible) void app.dock?.show();
    else app.dock?.hide();
  } catch {
    /* an activation-policy change is never worth a crash */
  }
}

/** The way back to a window from the menu bar. */
function openLibrary(): void {
  setDockVisible(true);
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); win.focus(); }
  // Without this an accessory app raises the window behind whatever is
  // frontmost, which reads as the click having done nothing.
  app.focus({ steal: true });
}

function startSupervisor(): void {
  sup = HelperSupervisor.start(HELPER, { statsIntervalMs: 500 });
  sup.on("ready", (l) => send("helper:ready", l));
  sup.on("stats", (l) => send("helper:stats", l));
  sup.on("respawned", (i) => send("helper:respawned", i));
  sup.on("gave-up", (i) => send("helper:gave-up", i));
  // The helper holds the capture devices: if it dies mid-recording the take is
  // gone, and that must be stated rather than left to look like an idle reset.
  sup.on("recording-lost", (i) => send("helper:recording-lost", i));
  // Stopped cleanly without being asked — the take is intact, unlike a loss.
  sup.on("recording-ended", (i) => send("helper:recording-ended", i));
  sup.on("helper:warning", (l) => send("helper:warning", l));
  // STC-287. The camera opens off the critical path (deliberately — see
  // Capture.swift), so it goes live a second or so AFTER recording starts. The
  // helper has always announced that; nothing was listening, so the user's only
  // evidence the camera worked was a PiP appearing ~1.4 s into playback, which
  // reads as a glitch rather than as the camera starting.
  sup.on("helper:camera-started", (l) => send("helper:camera-started", l));
}

app.whenReady().then(() => {
  startSupervisor();
  shortcuts = readSettings(app.getPath("userData")).shortcuts;
  // The menu bar first, and deliberately: from here on the app is allowed to
  // have no window, and installing the item afterwards would leave a gap in
  // which a user who closed the window had no way back.
  tray = installTray({ shortcuts, busy: capturing }, (id) => {
    if (id === "library") return openLibrary();
    if (id === "quit") return app.quit();
    const action = CAPTURE_ACTIONS.find((a) => id === `capture:${a}`);
    if (action) void captureStill(action, "menu-bar");
  });
  applyShortcuts(shortcuts);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", async () => {
  // A take in flight when its window goes is ENDED, not abandoned: the helper
  // would otherwise keep recording with nothing left that could stop it.
  if (sup?.state === "recording") await sup.stopRecording().catch(() => {});
  // On macOS the app stays alive and the helper stays with it. Shutting the
  // helper down here left a reopened window (Dock click) with a supervisor
  // that was "stopped" for good — every Record failed with "helper already
  // exited" until the app was relaunched. Elsewhere, quitting shuts it down.
  if (process.platform !== "darwin") { app.quit(); return; }
  // Nothing on screen: the app is now only its menu-bar item and its hotkeys,
  // which is the state the ticket's acceptance criterion describes.
  setDockVisible(false);
});

// Devices are released on a deliberate quit, not left to process teardown —
// and a recording in flight is stopped first (see HelperSupervisor.shutdown).
// Electron does not await an async listener here, so the first pass holds
// the quit until the shutdown has actually finished, then re-issues it.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  // An overlay still up at quit would outlive its window list and sit on the
  // screen with nothing left to answer it. A thumbnail still up is worse if
  // left alone — its shot would never be saved — so closing it SETTLES it
  // (STC-296), not merely discards the window.
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = undefined;
  closeThumbnail()
    .catch(() => {})
    .then(() => closeOverlay())
    .catch(() => {})
    .then(() => (sup ? sup.shutdown() : Promise.resolve()))
    .catch(() => {})
    .finally(() => app.quit());
});

ipcMain.handle("recorder:getSettings", async (): Promise<Settings> =>
  readSettings(app.getPath("userData")));

/**
 * The renderer's own preferences, minus the ones it may not name.
 *
 * `still.destination` is main's alone: it decides WHERE THIS PROCESS WRITES,
 * and `resolveExportOptions` documents in as many words that a renderer cannot
 * choose it. That guarantee was true of the export request and false here —
 * this generic handler passed the whole patch through, so the destination was
 * settable after all through a different door. A comment that promises more
 * than the code delivers is worse than no comment.
 *
 * The dedicated channel stays: `still:chooseDestination` sets it from a native
 * folder picker, which is a person choosing, not the renderer.
 */
ipcMain.handle("recorder:setSettings", async (_e, patch: Partial<Settings>): Promise<Settings> => {
  const clean: Partial<Settings> = { ...(patch ?? {}) };
  if (clean.still) {
    // Destructured rather than deleted, so `destination` is named here and a
    // reader can see exactly which key does not survive.
    const { destination: _mainsAlone, ...rest } = clean.still;
    // `writeSettings` merges `still` one level deep, so an absent destination
    // keeps the stored one rather than clearing it.
    clean.still = rest as Partial<Settings>["still"];
  }
  if (clean.share) {
    // Same rule, same reason (STC-242): `share.destination` is a folder in the
    // user's own site repo, and a renderer that could name it could make this
    // process copy a file anywhere it liked. `share:chooseDestination` sets it
    // from a native picker — a person choosing — and the slug and template,
    // which decide only what the file is CALLED and what text is offered for
    // pasting, stay settable from the preferences UI like any other field.
    const { destination: _mainsAlone, ...rest } = clean.share;
    clean.share = rest as Partial<Settings>["share"];
  }
  return writeSettings(app.getPath("userData"), clean);
});

ipcMain.handle("recorder:devices", async () => {
  if (!sup) throw new Error("supervisor not running");
  return sup.devices();
});

ipcMain.handle("recorder:status", async () => ({
  state: sup?.state ?? "starting",
  pid: sup?.pid,
}));

ipcMain.handle("recorder:start", async () => {
  if (!sup) throw new Error("supervisor not running");
  const root = takesRoot(process.env);
  const existing = existsSync(root) ? readdirSync(root) : [];
  // The helper creates the directory itself, and removes it again if the start
  // fails — so a denied grant leaves nothing behind on the user's Desktop.
  const dir = newTakeDir(process.env, new Date(), existing);
  try {
    // Read from the stored preference, NOT passed up from the renderer. Main
    // already owns this setting, and a renderer-supplied flag would be a second
    // source of truth for the thing that turns on a physical camera.
    const { camera, displayId } = readSettings(app.getPath("userData"));
    // displayId only when one was picked: absent means "the helper's first",
    // and the helper refuses an id it cannot find (display-not-found) rather
    // than recording another screen (STC-247).
    const r = await sup.startRecording(dir, { camera, ...(displayId != null ? { displayId } : {}) });
    return { ok: true, dir, info: r };
  } catch (e: any) {
    // A missing Screen Recording grant is the common case and is actionable —
    // surface the helper's own code rather than a generic failure.
    return { ok: false, code: e?.code ?? "start-failed", detail: e?.detail ?? String(e?.message ?? e) };
  }
});

/**
 * Select, then capture one frame (STC-290 handing off to STC-289), or capture a
 * whole display with no selection at all (STC-292).
 *
 * A FUNCTION, not just an IPC handler: the hotkey and the menu-bar item are the
 * primary entry points now, and neither has a renderer to route through. The
 * button in the window calls exactly this, so there is one capture path with
 * three doors rather than three implementations that can drift.
 *
 * The window list is read from the helper for THIS selection rather than
 * cached: it is stale the moment anything is closed or moved, and the overlay
 * is the one place where showing a window that has gone would hand the capture
 * an id it cannot honour.
 *
 * Nothing touches the disk until there is something to write. A cancelled
 * selection returns without ever asking for a directory, which is what makes
 * "Escape leaves no shot.json on disk" a property of the code rather than a
 * hope — the helper only ever sees a request that a real selection produced.
 */
export interface StillResult {
  ok: boolean;
  cancelled?: boolean;
  dir?: string;
  kind?: string;
  file?: string;
  shot?: unknown;
  warning?: string;
  code?: string;
  detail?: string;
  /** Which door this came through, so the UI can tell a capture it asked for
   * from one that arrived while the user was somewhere else entirely. */
  source?: CaptureSource;
}

type CaptureSource = "window" | "hotkey" | "menu-bar";

async function captureStill(action: CaptureAction, source: CaptureSource): Promise<StillResult> {
  // Never throws, whatever the door. A hotkey has no caller to reject to: an
  // exception here would be an unhandled rejection in the main process and a
  // capture that silently did nothing.
  if (!sup) return { ok: false, code: "helper-not-running", source };
  // A second press while one is in flight is a no-op, not a second overlay and
  // not a second directory.
  if (capturing || overlayIsOpen()) return { ok: false, code: "overlay-open", source };

  capturing = true;
  tray?.update({ shortcuts, busy: true });
  try {
    // Whatever panel is on screen from a PREVIOUS capture must be out of this
    // one's pixels (STC-296's acceptance list: "including a full-display
    // capture on the same display") and out from underneath the overlay, if
    // one is about to open. Cheap when nothing is showing — see `beforeCapture`.
    const thumbExcluded = await hideThumbnailForCapture();
    const outcome = action === "display"
      ? await wholeDisplay(thumbExcluded)
      : await selectRegionOrWindow(action, thumbExcluded);
    if (outcome === undefined) return { ok: false, cancelled: true, source };

    const root = takesRoot(process.env);
    const existing = existsSync(root) ? readdirSync(root) : [];
    const dir = newTakeDir(process.env, new Date(), existing);
    const r = await sup.captureStill({ dir, ...outcome.params });
    // The sound is the ONLY feedback a full-display hotkey capture gives — no
    // overlay was ever on screen — so it is played on every successful shot,
    // for the same reason macOS plays one. Not awaited: the shot is already on
    // disk, and a wedged speaker must not delay the answer.
    //
    // The preference is read HERE rather than cached at launch, for the same
    // reason the system's own sound setting is: someone who has just unticked
    // it means the next capture, not the next launch.
    void playShutter({ enabled: readSettings(app.getPath("userData")).shutterSound })
      .catch(() => {});
    // The panel (STC-296), presented from HERE rather than from any window's
    // renderer: a capture from the hotkey or the menu bar has no window at
    // all, and the panel is the only place a decorated still can be gotten out
    // of the app in v1. `skip` bypasses it entirely: the ticket's own words are
    // "go straight to clipboard", so a silent capture always copies, whatever
    // the (otherwise inapplicable) settle-action preference says.
    // Never lets a panel failure cost the CAPTURE — the shot is already on
    // disk in `dir` by this point, the same "nothing lost by doing nothing"
    // rule the old still panel followed for exactly this reason.
    try {
      const { thumbnail } = readSettings(app.getPath("userData"));
      presentThumbnail({
        dir, shot: r.shot, corner: thumbnail.corner, timeoutMs: thumbnail.timeoutMs,
        dist: here, rendererDir: join(here, "..", "renderer"),
        ...(thumbnail.skip ? { settleAction: "copy" as const, silent: true } : { settleAction: thumbnail.settleAction }),
      });
    } catch (e) {
      console.error("[thumbnail] could not present:", e);
    }
    // The helper's reply is a JSON line, so its fields arrive as `unknown`;
    // named here rather than spread, so a renamed field is a type error and not
    // a silently absent one.
    return { ok: true, dir, kind: outcome.kind, shot: r.shot,
             file: r.file as string | undefined,
             warning: r.alphaWarning as string | undefined, source };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "still-failed",
             detail: e?.detail ?? String(e?.message ?? e), source };
  } finally {
    capturing = false;
    // Every exit, the cancelled one included: `hideThumbnailForCapture` hides
    // panels that are NOT about to be replaced, so anything that returns
    // without presenting a new one has to put the stack back.
    showThumbnailsAfterCapture();
    tray?.update({ shortcuts, busy: false });
  }
}

interface CaptureParams { kind: string; [k: string]: unknown }

/** The overlay path. `undefined` is a cancellation, which writes nothing. */
async function selectRegionOrWindow(
  action: Extract<CaptureAction, "region" | "window">,
  thumbExcluded: number[],
): Promise<{ kind: string; params: CaptureParams } | undefined> {
  let windows: WindowInfo[] = [];
  try {
    const r = await sup!.listWindows();
    windows = ((r.windows as any[]) ?? []).map((w) => ({
      id: w.id, app: w.app, title: w.title,
      bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
    }));
  } catch {
    // Without a Screen Recording grant the helper cannot enumerate anything.
    // The overlay still opens — region mode needs no window list — and the
    // capture below reports the real reason, which is more use to the user
    // than refusing to open with a message about windows they did not ask for.
  }

  const { outcome, excludeWindowIds } = await openOverlay({
    windows, mode: action, dist: here, renderer: join(here, "..", "renderer"),
  });
  if (outcome.kind === "cancelled") return undefined;
  return outcome.kind === "region"
    // `displayId` is Electron's, which on macOS is the CGDirectDisplayID the
    // helper matches against. If that ever stops being true the helper answers
    // `no-such-display` and the capture fails loudly — it cannot silently
    // photograph the wrong screen, which is the failure worth designing out.
    // The overlay's own excluded windows and the thumbnail's (STC-296) are
    // combined here — a WINDOW capture needs neither, since its own filter
    // names exactly one window and cannot accidentally include another.
    ? { kind: "region",
        params: { kind: "display-crop", displayId: outcome.displayId,
                  crop: outcome.crop, excludeWindowIds: [...excludeWindowIds, ...thumbExcluded] } }
    : { kind: "window", params: { kind: "window", windowId: outcome.windowId } };
}

/**
 * The whole display the pointer is on, with no overlay and no selection.
 *
 * The pointer rather than the recording preference or the main display: a
 * hotkey is pressed while looking at something, and the thing being looked at
 * is the one under the cursor. It is also the only rule that needs nothing on
 * screen to disambiguate, which is the point of this action existing.
 *
 * No crop is sent — the helper reads an absent crop as the whole display — but
 * a showing thumbnail (STC-296) still needs excluding: "no overlay" is not
 * "nothing else is on screen."
 */
async function wholeDisplay(thumbExcluded: number[]): Promise<{ kind: string; params: CaptureParams }> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return { kind: "display",
           params: { kind: "display-crop", displayId: display.id,
                     ...(thumbExcluded.length ? { excludeWindowIds: thumbExcluded } : {}) } };
}

/**
 * A hotkey or menu-bar capture has no renderer waiting on a reply, so its
 * outcome is announced instead. A window that happens to be open updates its
 * take list and says what happened; one that is not open misses nothing,
 * because the shot is already on disk.
 */
async function captureAndAnnounce(action: CaptureAction, source: CaptureSource): Promise<void> {
  const r = await captureStill(action, source);
  send("still:captured", r);
}

ipcMain.handle("still:capture", async (_e, action?: CaptureAction) =>
  captureStill(action && CAPTURE_ACTIONS.includes(action) ? action : "region", "window"));

/**
 * Register what preferences asked for, and report what actually took.
 *
 * `planShortcuts` refuses what is knowably wrong before anything is attempted;
 * `globalShortcut.register` is the authority on the rest and returns false when
 * something else on the machine already holds the binding. Both answers reach
 * the same report, kept apart by their `problem`, because "macOS owns this" and
 * "some other app owns this" have different fixes.
 *
 * Everything is unregistered first: re-registering an accelerator that is still
 * held returns false, which would report a working binding as unavailable the
 * second time a user opened preferences.
 */
function applyShortcuts(next: Shortcuts): ShortcutReport[] {
  shortcuts = next;
  globalShortcut.unregisterAll();
  shortcutReport = planShortcuts(next).map((plan): ShortcutReport => {
    if (plan.problem !== undefined || plan.accelerator == null) {
      return { ...plan, registered: false };
    }
    let ok = false;
    try {
      ok = globalShortcut.register(plan.accelerator,
                                   () => { void captureAndAnnounce(plan.action, "hotkey"); });
    } catch {
      // A binding Electron cannot even parse. Reported as unavailable rather
      // than crashing the app on a preferences file someone edited by hand.
      ok = false;
    }
    return ok ? { ...plan, registered: true } : { ...plan, problem: "unavailable", registered: false };
  });
  tray?.update({ shortcuts, busy: capturing });
  return shortcutReport;
}

ipcMain.handle("shortcuts:get", async () => ({ shortcuts, report: shortcutReport }));

ipcMain.handle("shortcuts:set", async (_e, action: CaptureAction, accelerator: string | null) => {
  if (!CAPTURE_ACTIONS.includes(action)) throw new Error(`unknown capture action: ${action}`);
  const plan = planShortcuts({ ...shortcuts, [action]: accelerator })
    .find((p) => p.action === action)!;
  if (plan.problem !== undefined) {
    // Refused BEFORE anything is stored — the acceptance criterion is that a
    // binding macOS has already claimed is rejected, and a rejection that
    // quietly wrote the default instead would leave the user believing they
    // had bound ⌘⇧4. The previous binding stays live and stays registered;
    // only the report changes, so preferences can say why.
    return {
      shortcuts,
      report: shortcutReport.map((r) => r.action === action ? { ...plan, registered: false } : r),
    };
  }
  // Stored first, then applied: what is on disk is what the next launch will
  // try. A binding that parses but that some other app holds is still the
  // user's choice — it is reported as unavailable, not reverted behind them.
  const saved = writeSettings(app.getPath("userData"),
                              { shortcuts: { ...shortcuts, [action]: plan.accelerator } });
  return { shortcuts: saved.shortcuts, report: applyShortcuts(saved.shortcuts) };
});

ipcMain.handle("shortcuts:reset", async () => {
  const saved = writeSettings(app.getPath("userData"), { shortcuts: { ...DEFAULT_SHORTCUTS } });
  return { shortcuts: saved.shortcuts, report: applyShortcuts(saved.shortcuts) };
});

ipcMain.handle("recorder:stop", async () => {
  if (!sup) throw new Error("supervisor not running");
  const r = await sup.stopRecording();
  return { ok: true, info: r };
});


// ---- the library: one index over two kinds (STC-294) ----------------------

ipcMain.handle("library:list", async (_e, filter?: string) =>
  listLibrary(process.env, typeof filter === "string" ? filter : undefined));

/**
 * Cache a decorated thumbnail beside the document it was rendered from.
 *
 * In the take DIRECTORY, deliberately, and that choice is what makes the
 * ticket's delete criterion — *"delete removes the frame, shot.json and
 * thumbnail with no orphans"* — true by construction rather than by
 * remembering: `take:delete` trashes the whole directory, so the thumbnail
 * goes with it and an orphan is not merely unlikely but unreachable. A cache
 * in userData would need its own eviction, which is the orphan the criterion
 * names.
 *
 * The filename is fixed rather than supplied, so there is no name to traverse
 * with; what IS checked is that the bytes are actually a PNG. The renderer is
 * the sandboxed side, and "write these bytes into the user's take folder" is
 * worth exactly one magic-number check.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

ipcMain.handle("library:writeThumbnail", async (_e, dir: string, bytes: ArrayBuffer) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to write a path outside the recordings folder");
  }
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error("refusing to cache a thumbnail that is not a PNG");
  }
  await writeFile(join(dir, THUMBNAIL_FILE), buf);
  return true;
});

/**
 * Re-open a stored shot into the post-capture panel (STC-294).
 *
 * The payoff of keeping the decoration in JSON: the panel is handed the STORED
 * document, so the mode, the canvas and STC-297's redaction regions all come
 * back exactly as they were left, and the shot can be re-exported without
 * re-capturing. It is the same panel a fresh capture gets — not a second still
 * UI, which is what STC-293's Note and STC-300's gate both forbid.
 *
 * `settleAction: "none"` is the one difference and it matters: ignoring a
 * FRESH capture must still save it, because the panel is the only place it
 * exists; ignoring a re-opened one must do nothing at all, because it is
 * already on disk and a second copy is not what a glance meant.
 */
/** The stored document for one shot, so the library can render its decoration. */
ipcMain.handle("library:shot", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to read a path outside the recordings folder");
  }
  return parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
});

ipcMain.handle("still:reopen", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to open a path outside the recordings folder");
  }
  const shot = parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
  const { thumbnail } = readSettings(app.getPath("userData"));
  presentThumbnail({
    dir, shot, corner: thumbnail.corner, timeoutMs: thumbnail.timeoutMs,
    settleAction: "none",
    dist: here, rendererDir: join(here, "..", "renderer"),
  });
  return { ok: true };
});

/**
 * Copy a shot so a second decoration can be tried without re-capturing.
 *
 * The new directory gets a fresh timestamp from the same `newTakeDir` a
 * capture uses, so the duplicate sorts as what it is — made now. The copy and
 * its race-safety (STC-345: a double-click or two tiles duplicated in the
 * same second used to be able to collide on one destination) live in
 * `duplicateTake`; this handler is only validation and the IPC boundary.
 */
ipcMain.handle("still:duplicate", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to duplicate a path outside the recordings folder");
  }
  // Read it back through `parseShot` first: duplicating a document this build
  // cannot load would produce a second directory the library also refuses.
  parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
  const dest = await duplicateTake(process.env, dir, THUMBNAIL_FILE);
  return { ok: true, dir: dest };
});

ipcMain.handle("recorder:takes", async () => listTakes(process.env));

ipcMain.handle("take:label", async (_e, dir: string, label: string) => {
  await setTakeLabel(process.env, dir, label);
  return true;
});

ipcMain.handle("take:delete", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to delete a path outside the recordings folder");
  }
  if (!win) throw new Error("no window");

  // The only irreversible action in the app, so it asks first — and then does
  // not actually destroy anything: shell.trashItem moves the take to the Trash,
  // where a mistaken click is one restore away. Never unlink.
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Move this recording to the Trash?",
    detail: dir,
  });
  if (response !== 0) return { deleted: false };

  if (openTake === dir) openTake = undefined;
  await shell.trashItem(dir);
  return { deleted: true };
});

ipcMain.handle("preview:open", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to open a path outside the recordings folder");
  }
  openTake = dir;
  return true;
});

ipcMain.handle("preview:close", async () => { openTake = undefined; });

ipcMain.handle("preview:writeProject", async (_e, bytes: ArrayBuffer) => {
  if (!openTake) throw new Error("no take is open");
  const text = Buffer.from(bytes).toString("utf8");
  let doc: any;
  try { doc = JSON.parse(text); }
  catch { throw new Error("project.json is not JSON"); }
  // ONE list, imported (STC-318). This used to be a hand-rolled chain, and its
  // own comment claimed it "cannot share a constant with the transform's" —
  // untrue, this file already imports from @transform. The comment also
  // recorded that the pair had drifted once, when project-2 was minted; it
  // then drifted again when project-4 shipped, and for a day a take with a
  // non-default zoom could not be saved at all, silently. No test could see
  // it: the unit tests never cross this process line, and every document the
  // E2E tests wrote happened to be a v3.
  if (!isProjectVersion(doc?.version)) {
    throw new Error(`project.json version ${doc?.version} is not supported`);
  }
  await writeFile(join(openTake, "project.json"), text);
  return true;
});

ipcMain.handle("export:write", async (_e, name: string, bytes: ArrayBuffer) => {
  if (!openTake) throw new Error("no take is open");
  // The renderer chooses a filename; constrain it to a leaf name with a known
  // extension so it cannot traverse out of the take directory.
  if (!/^[A-Za-z0-9._-]+\.(mp4|json|png)$/.test(name) || name.includes("..")) {
    throw new Error(`refusing to write "${name}"`);
  }
  // Source media is never mutated. The leaf-name rule above still admitted
  // display.mp4, camera.mp4 and the sidecars — an export named after one of
  // them would have replaced the recording with its own rendering.
  if (TAKE_FILES.has(name) || name === "take.json") {
    throw new Error(`refusing to overwrite the take's own "${name}"`);
  }
  const dest = join(openTake, name);
  await writeFile(dest, Buffer.from(bytes));
  return dest;
});

/**
 * The one way a still leaves the app (STC-293).
 *
 * Every caller reaches disk and pasteboard through here: the preview's frame
 * grab (STC-298, migrated onto this in the same change) and the floating
 * thumbnail's own window (STC-296), each through its own preload but the same
 * handler. The ticket's Note forbids a second implementation, and the way
 * that rule stays true is that there is exactly one handler and it takes
 * composited pixels rather than an encoded image — an encoded image would
 * mean the caller had already chosen a format, which is half the decision
 * this path exists to own.
 *
 * The renderer sends RGBA because it has a canvas and no encoder; the helper
 * encodes because ImageIO is the only thing here that can write HEIC, embed a
 * Display P3 profile, and withhold a capture timestamp.
 */
ipcMain.handle("still:export", async (_e, req: {
  bytes: ArrayBuffer; width: number; height: number; alpha: boolean;
  colorSpace?: string;
  target: ExportTarget;
  options: Partial<ExportOptions>;
  info: { app?: string; title?: string; mode: string };
  /** A take directory, for the "beside the shot" default destination. */
  dir?: string;
}) => {
  if (!sup) throw new Error("supervisor not running");
  const stored = readSettings(app.getPath("userData")).still;

  // What the renderer may decide about this one export, and what only the
  // stored preference decides. In `still-io.ts` rather than inline here: a
  // closure in `ipcMain.handle` is unreachable from any test, and the first
  // version of this pinned the template to the stored one, which renamed
  // every saved frame.
  const options = resolveExportOptions(stored, req.options);

  // A take directory is the only fallback destination that may be named, and
  // it must be inside the recordings root — the renderer is sandboxed and
  // never gets to point the writer at an arbitrary path.
  // `insideTakesRoot`, not `startsWith`: this path is handed to the helper,
  // which CREATES directories and writes an image at it. A `..` segment or a
  // sibling folder with the same prefix both pass a prefix test.
  const fallbackDir = req.dir && insideTakesRoot(process.env, req.dir) ? req.dir : undefined;

  const still: CompositedStill = {
    bytes: req.bytes,
    width: req.width,
    height: req.height,
    alpha: req.alpha === true,
    colorSpace: colorSpaceFor(req.colorSpace),
  };
  // "Save As…" (STC-296's right-click menu). The renderer asked to choose; it
  // does not get to say WHAT was chosen. Main puts the panel up, and the path
  // that comes back is the privileged `explicitFile` — the same division
  // `still:writeShot` makes, where the renderer names regions and never a
  // document.
  let explicitFile: string | undefined;
  if (req.target.saveAs === true) {
    const parent = BrowserWindow.getFocusedWindow() ?? win;
    const suggested = plannedFileName(options, req.info, { width: req.width, height: req.height });
    const picked = await (parent
      ? dialog.showSaveDialog(parent, { title: "Save Still", defaultPath: suggested })
      : dialog.showSaveDialog({ title: "Save Still", defaultPath: suggested }));
    // Cancelling is an answer, not a failure: it must not fall through to a
    // silent save in the destination folder, which is the one outcome someone
    // who opened this dialog has ruled out.
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    explicitFile = picked.filePath;
  }

  try {
    const r = await exportStill((params) => sup!.exportStill(params),
                                { still, target: req.target, options, info: req.info,
                                  ...(explicitFile ? { explicitFile } : {}),
                                  ...(fallbackDir ? { fallbackDir } : {}) },
                                // `stored`, never the merged options: the
                                // destination folder and the strip are read
                                // from here, and both are main's alone.
                                stored, app.getPath("temp"));
    // Only a save is worth revealing. A copy's file lives in the cache and
    // exists so the pasteboard's URL points somewhere, not for the user.
    if (req.target.file && r.file) lastStillFile = r.file;
    return { ok: true, ...r };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "export-failed",
             detail: e?.detail ?? String(e?.message ?? e) };
  }
});

/**
 * The destination folder, chosen by the user.
 *
 * A folder picker rather than a save panel, deliberately: the ticket's default
 * path out of the app is "no interaction at all", so the place is chosen once
 * and every subsequent export is silent. A save panel per shot would be the
 * interaction the design is trying to remove.
 */
ipcMain.handle("still:chooseDestination", async () => {
  if (!win) throw new Error("no window");
  const current = readSettings(app.getPath("userData")).still.destination;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Where should stills be saved?",
    properties: ["openDirectory", "createDirectory"],
    ...(current ? { defaultPath: current } : {}),
    buttonLabel: "Choose",
  });
  if (canceled || !filePaths[0]) return { destination: current };
  const destination = filePaths[0];
  writeSettings(app.getPath("userData"), { still: { ...readSettings(app.getPath("userData")).still, destination } });
  return { destination };
});

/**
 * The floating thumbnail's right-click menu (STC-296 follow-up).
 *
 * Built here and popped up here: `thumbnailMenuTemplate` decides the contents
 * where a test can read them, and this turns them into the one thing no test
 * can — a real `Menu`. Answers with the chosen id, or `null` when the menu was
 * dismissed, so the renderer performs the action with the same code its own
 * buttons use.
 */
ipcMain.handle("thumbnail:menu", async (e, ctx: ThumbMenuContext) => {
  const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  return await new Promise<ThumbMenuId | null>((resolve) => {
    let answered = false;
    const answer = (id: ThumbMenuId | null) => { if (!answered) { answered = true; resolve(id); } };
    const menu = Menu.buildFromTemplate(thumbnailMenuTemplate({
      redacting: ctx?.redacting === true, busy: ctx?.busy === true,
    }).map((item) => item.type === "separator"
      ? { type: "separator" as const }
      : { label: item.label, enabled: item.enabled !== false, click: () => answer(item.id) }));
    // `callback` fires on dismissal too, and AFTER any click — so a menu closed
    // without a choice still settles the promise. Without it the renderer waits
    // forever on an `await` for a menu that is no longer on screen, which is
    // the unbounded-wait trap this repo keeps re-learning.
    menu.popup({ ...(owner ? { window: owner } : {}), callback: () => answer(null) });
  });
});

/**
 * Write the decorated file a drag-out will hand over (STC-296 follow-up).
 *
 * Goes through the SAME funnel as every other exit, using #98's
 * `explicitFile` exactly as it was built: main names the destination, the
 * renderer never does. The destination is the clipboard cache, for the reason
 * `CLIPBOARD_SUBDIR` exists — someone dragging a shot into Slack did not ask
 * for a copy to accumulate in their shots folder.
 *
 * A separate VERB rather than a flag on `ExportTarget`: a drag is not a save
 * and not a copy, and folding it into either would set `lastStillFile` — so
 * Reveal in Finder would jump to a file the user never asked to keep.
 */
ipcMain.handle("still:dragFile", async (_e, req: {
  bytes: ArrayBuffer; width: number; height: number; alpha: boolean;
  colorSpace?: string;
  options: Partial<ExportOptions>;
  info: { app?: string; title?: string; mode: string };
}) => {
  if (!sup) throw new Error("supervisor not running");
  const stored = readSettings(app.getPath("userData")).still;
  const options = resolveExportOptions(stored, req.options);
  const still: CompositedStill = {
    bytes: req.bytes, width: req.width, height: req.height,
    alpha: req.alpha === true, colorSpace: colorSpaceFor(req.colorSpace),
  };
  const cache = join(app.getPath("temp"), CLIPBOARD_SUBDIR);
  try {
    const r = await exportStill((params) => sup!.exportStill(params), {
      still, target: { file: true, clipboard: false }, options, info: req.info,
      explicitFile: join(cache, plannedFileName(options, req.info, still)),
    }, stored, app.getPath("temp"));
    // Deliberately NOT `lastStillFile`: see the note above.
    return { ok: true, file: r.file };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "export-failed",
             detail: e?.detail ?? String(e?.message ?? e) };
  }
});

/**
 * Hand the file to the window server (STC-296 follow-up).
 *
 * `startDrag` is reached through pointer events rather than an HTML5
 * `dragstart`, and that is the point: making the card `draggable` would put a
 * native drag in the same pixels as the swipe's pointer gesture, and the two
 * would race for every press. Electron lets `startDrag` be called from
 * anywhere, so the panel stays on one input model and `classifyDrag` remains
 * the only thing deciding what a press means.
 *
 * NOT `NSFilePromiseProvider`, per STC-293: a promise needs a live provider to
 * answer at paste time, the helper has answered and gone idle by then, and a
 * promise nobody answers hands the receiver a ZERO-BYTE file.
 */
ipcMain.on("still:startDrag", (e, file: string) => {
  if (typeof file !== "string" || !existsSync(file)) return;
  // macOS refuses an empty drag icon. Built from the file being dragged, so
  // what the cursor carries is what will land.
  const icon = nativeImage.createFromPath(file).resize({ width: 128 });
  if (icon.isEmpty()) return;
  e.sender.startDrag({ file, icon });
});

/**
 * Show a SHOT's own directory in the Finder.
 *
 * Distinct from `still:reveal`, which shows the last saved file: a thumbnail
 * that has not settled yet has saved nothing, and revealing some earlier
 * shot instead of the one under the pointer would be worse than refusing.
 * `insideTakesRoot` for the same reason every other renderer-named path gets
 * it — a prefix test passes a `..` segment.
 */
ipcMain.handle("still:revealShot", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideTakesRoot(process.env, dir) || !existsSync(dir)) return false;
  shell.showItemInFolder(dir);
  return true;
});

/**
 * Throw a shot away (STC-296's right-click Delete).
 *
 * To the TRASH, never `rm`, and with no confirmation. `recorder:deleteTake`
 * puts a modal in front of the same call and that is right there — a recording
 * is minutes of work and the library is a place you browse. A shot whose panel
 * is still on screen is seconds old with the pointer already on it, and the
 * Trash is what makes "no confirmation" safe rather than reckless.
 *
 * The caller is responsible for having stopped its own settle first: this
 * removes the directory the panel would otherwise export from.
 */
ipcMain.handle("still:deleteShot", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideTakesRoot(process.env, dir)) {
    return { ok: false, detail: "not a shot this app wrote" };
  }
  if (!existsSync(dir)) return { ok: true };
  try {
    await shell.trashItem(dir);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
});

/** Show the last SAVED still in the Finder. Takes no path — see `lastStillFile`. */
ipcMain.handle("still:reveal", async () => {
  if (!lastStillFile) return false;
  shell.showItemInFolder(lastStillFile);
  return true;
});

/** Back to "beside the shot", without needing a folder picker to express it. */
ipcMain.handle("still:clearDestination", async () => {
  const still = readSettings(app.getPath("userData")).still;
  writeSettings(app.getPath("userData"), { still: { ...still, destination: null } });
  return { destination: null };
});

/**
 * The captured frame's bytes, for the still panel to decorate.
 *
 * Guarded exactly like `preview:read`: a leaf name inside a directory the main
 * process is willing to name, never a path the renderer chose. The stills the
 * renderer may open are the ones under the recordings root, which is the only
 * place `still:capture` ever writes.
 */
ipcMain.handle("still:frame", async (_e, dir: string, name: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to read a path outside the recordings folder");
  }
  if (!/^[A-Za-z0-9._-]+\.png$/.test(name) || name.includes("..")) {
    throw new Error(`refusing to read "${name}"`);
  }
  const buf = await readFile(join(dir, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

/**
 * Store this shot's redaction regions (STC-297), so they survive the panel and
 * the app.
 *
 * The renderer sends REGIONS, never a document. That is the whole shape of
 * this handler: `shot.json` IS the still — the description is the artefact and
 * the pixels are derived (shot.ts's header) — so letting a sandboxed renderer
 * hand over a replacement document would let it rewrite the display, the crop,
 * the frame's filename and the capture time of a file the app then treats as
 * authoritative. Instead the stored document is read, the ONE field the panel
 * is allowed to change is replaced, and the result goes back through
 * `parseShot` before anything is written — so a region the schema would refuse
 * cannot reach the disk, and neither can a document this process did not
 * already have.
 *
 * The write is not atomic and deliberately is not: the alternative is a temp
 * file plus a rename in the take directory, and a half-written `shot.json`
 * from a crash mid-write costs the DECORATION, never the capture — `frame.png`
 * is untouched here and is what the shot actually is.
 */
ipcMain.handle("still:writeShot", async (_e, dir: string, redactions: unknown) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to write a path outside the recordings folder");
  }
  const file = join(dir, "shot.json");
  const stored = parseShot(JSON.parse(await readFile(file, "utf8")));
  const next = parseShot({
    ...stored,
    decoration: { ...stored.decoration, redactions },
  });
  // Through `shotForWrite`, which decides the VERSION: a shot with no
  // annotations stays shot-1 and must not carry the v2-only key, since shot-1
  // declares additionalProperties: false and a document that fails its own
  // schema is the defect this project has now paid for three times.
  await writeFile(file, JSON.stringify(shotForWrite(next), null, 2));
  // The library's cached thumbnail (STC-294) was rendered from the document
  // that just changed, so it now shows a decoration this shot no longer has.
  // Dropped rather than re-rendered: this process has no canvas, and the grid
  // renders a missing one the next time the tile is on screen. A failure here
  // costs a stale picture, never the regions that were just written.
  await rm(join(dir, THUMBNAIL_FILE), { force: true }).catch(() => {});
  return { ok: true, redactions: next.decoration.redactions.length };
});

ipcMain.handle("preview:read", async (_e, name: string) => {
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to read "${name}"`);
  const buf = await readFile(join(openTake, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle("preview:size", async (_e, name: string) => {
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to stat "${name}"`);
  return (await stat(join(openTake, name))).size;
});

/**
 * One slice of a take file.
 *
 * Reading a whole recording in a single IPC message means the buffer exists
 * twice at once — measured at ~949 MB of renderer heap for a 458 MB take — and
 * that peak, not the transfer (835 ms, fast), is what limits how long a take
 * can be. Slices land directly in a destination the renderer allocated once.
 */
ipcMain.handle("preview:chunk", async (_e, name: string, offset: number, length: number) => {
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to read "${name}"`);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
    throw new Error("bad chunk range");
  }
  const fh = await open(join(openTake, name), "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  } finally {
    await fh.close();
  }
});

/**
 * Share (STC-242) — the last step of the loop, and the smallest.
 *
 * Three handlers, and between them they are the whole feature: choose the
 * folder in the site repo once, copy the exported MP4 into it under a stable
 * name, and reveal it so the person can see what landed. No upload, no auth,
 * no third-party service — the ticket cut all of that once the destination was
 * decided, and what is left is a file copy that a `git push` in the other repo
 * turns into a published video.
 *
 * Every decision is in `share.ts`; these do the I/O and decide nothing.
 */
ipcMain.handle("share:chooseDestination", async () => {
  if (!win) throw new Error("no window");
  const current = readSettings(app.getPath("userData")).share.destination;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Which folder in the site repo holds the video?",
    properties: ["openDirectory", "createDirectory"],
    ...(current ? { defaultPath: current } : {}),
    buttonLabel: "Choose",
  });
  if (canceled || !filePaths[0]) return { destination: current };
  const destination = filePaths[0];
  const stored = readSettings(app.getPath("userData"));
  writeSettings(app.getPath("userData"), { share: { ...stored.share, destination } });
  return { destination };
});

/**
 * Copy the open take's export into the site folder.
 *
 * **It replaces what is there, and that is the point rather than a hazard
 * overlooked.** The published name comes from the slug, not the take, so the
 * page can embed a fixed path and a re-recorded demo re-publishes over itself
 * — see `DEFAULT_SLUG`. What is owed in exchange is honesty about it: the
 * result says `replaced` when a file was already there, so the UI reports
 * "Replaced" rather than "Wrote" and nobody discovers afterwards that a
 * previous video is gone. It is checked BEFORE the copy, because after it the
 * answer is always yes.
 *
 * No modal confirmation. The destination was chosen by hand, the name comes
 * from a slug the user typed, and replacing that exact file is the entire
 * intended operation — a dialog on every republish would be friction charged
 * for doing what was asked.
 */
ipcMain.handle("share:publish", async (): Promise<{
  ok: boolean; plan: PublishPlan["kind"]; message?: string;
  file?: string; name?: string; replaced?: boolean; snippet?: string;
}> => {
  if (!openTake) throw new Error("no take is open");
  const { share } = readSettings(app.getPath("userData"));
  const takeName = basename(openTake);
  const plan = planPublish({
    takeName,
    takeDir: openTake,
    exportExists: existsSync(join(openTake, exportMediaName(takeName))),
    destination: share.destination,
    slug: share.slug,
  });
  if (plan.kind !== "ready") {
    return { ok: false, plan: plan.kind, message: plan.message };
  }
  // Read before the write, or the answer is always "yes, it exists".
  const replaced = existsSync(plan.to);
  await copyFile(plan.from, plan.to);
  // The snippet's dimensions come from the MANIFEST the export wrote beside
  // the video (STC-308), not from the project as it stands now: the project is
  // editable after an export, so reading it here could describe the video as
  // whatever the user has since changed the output to. The manifest records
  // what was actually encoded. Absent or unreadable, the snippet keeps
  // `{width}` unsubstituted rather than inventing a number — a `width="0"`
  // pasted into someone's page is a wrong answer dressed as a real one.
  const size = await exportedSize(openTake, takeName);
  return {
    ok: true, plan: "ready", file: plan.to, name: plan.name, replaced,
    snippet: embedSnippet(share.embedTemplate ?? DEFAULT_EMBED_TEMPLATE, {
      src: publicSrc(share.slug), slug: share.slug, ...size,
    }),
  };
});

/** What the export actually encoded, from its own manifest, or nothing. */
async function exportedSize(dir: string, takeName: string):
    Promise<{ width?: number; height?: number }> {
  try {
    const doc = JSON.parse(await readFile(join(dir, exportManifestName(takeName)), "utf8"));
    const o = doc?.output;
    if (typeof o?.width === "number" && typeof o?.height === "number") {
      return { width: o.width, height: o.height };
    }
  } catch { /* no manifest, or not readable — fall through */ }
  return {};
}

/**
 * Reveal the published file, selected in Finder.
 *
 * `recorder:reveal` shows a take DIRECTORY and refuses anything outside the
 * recordings root, which is right for a take and wrong here: the published
 * file is deliberately outside that root, in the user's own site repo. So this
 * is its own handler with its own rule — it reveals only the exact path the
 * stored destination and slug produce, never a path the renderer names, which
 * is what keeps "open anything you like" from being one IPC call away.
 */
ipcMain.handle("share:reveal", async () => {
  const { share } = readSettings(app.getPath("userData"));
  if (!share.destination) return { ok: false, message: "No site folder chosen yet." };
  const file = join(share.destination, `${share.slug}.mp4`);
  if (!existsSync(file)) return { ok: false, message: "Nothing published yet." };
  shell.showItemInFolder(file);
  return { ok: true, file };
});

ipcMain.handle("recorder:reveal", async (_e, dir: string) => {
  // Only ever reveal something inside the recordings folder: `dir` arrives from
  // the renderer, and the renderer should not be able to open arbitrary paths.
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to reveal a path outside the recordings folder");
  }
  shell.showItemInFolder(dir);
});
