import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage } from "electron";
import { readSettings, writeSettings, type Settings } from "./settings.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile, stat, open } from "node:fs/promises";
import { HelperSupervisor } from "./supervisor.js";
import { newTakeDir, takesRoot, listTakes, setTakeLabel } from "./takes.js";

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
  win = new BrowserWindow({
    width: 520, height: 680, title: "stc recorder",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(join(here, "..", "renderer", "index.html"));
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
  if (process.platform !== "darwin") app.quit();
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
  (sup ? sup.shutdown() : Promise.resolve()).catch(() => {}).finally(() => app.quit());
});

ipcMain.handle("recorder:getSettings", async (): Promise<Settings> =>
  readSettings(app.getPath("userData")));

ipcMain.handle("recorder:setSettings", async (_e, patch: Partial<Settings>): Promise<Settings> =>
  writeSettings(app.getPath("userData"), patch ?? {}));

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

ipcMain.handle("recorder:stop", async () => {
  if (!sup) throw new Error("supervisor not running");
  const r = await sup.stopRecording();
  return { ok: true, info: r };
});

ipcMain.handle("recorder:takes", async () => listTakes(process.env));

ipcMain.handle("take:label", async (_e, dir: string, label: string) => {
  await setTakeLabel(process.env, dir, label);
  return true;
});

ipcMain.handle("take:delete", async (_e, dir: string) => {
  const root = takesRoot(process.env);
  if (!dir.startsWith(root) || dir === root) {
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
  const root = takesRoot(process.env);
  if (!dir.startsWith(root)) throw new Error("refusing to open a path outside the recordings folder");
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
  // v1 and v2 both accepted. This gate is in the main process and cannot share a
  // constant with the transform's; it was missed when project-2 was minted and
  // rejected every document the renderer wrote, so project.json silently never
  // appeared. Same shape as STC-262's anchors gate in takes.ts.
  if (doc?.version !== 1 && doc?.version !== 2 && doc?.version !== 3) {
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
 * A still onto the pasteboard (STC-298). Main owns the clipboard as it owns
 * every other OS surface; the renderer hands over PNG bytes and nothing else.
 */
ipcMain.handle("frame:copy", async (_e, bytes: ArrayBuffer) => {
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error("the frame could not be decoded as an image");
  clipboard.writeImage(image);
  return image.getSize();
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

ipcMain.handle("recorder:reveal", async (_e, dir: string) => {
  // Only ever reveal something inside the recordings folder: `dir` arrives from
  // the renderer, and the renderer should not be able to open arbitrary paths.
  const root = takesRoot(process.env);
  if (!dir.startsWith(root)) throw new Error("refusing to reveal a path outside the recordings folder");
  shell.showItemInFolder(dir);
});
