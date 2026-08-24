import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { HelperSupervisor } from "./supervisor.js";
import { newTakeDir, takesRoot } from "./takes.js";

/**
 * Electron main process. Owns the helper: it is spawned as a CHILD of this
 * process, which is what gives it this app's TCC identity — one grant, against
 * the signed bundle the user recognises, rather than a second opaque helper
 * appearing in System Settings (PHASE-0 §6, demonstrated in increment 2).
 */

const here = dirname(fileURLToPath(import.meta.url));
const HELPER = join(here, "..", "..", "helper", "build", "stc-helper");

let win: BrowserWindow | undefined;
let sup: HelperSupervisor | undefined;

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520, height: 620, title: "stc recorder",
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
  sup.on("helper:warning", (l) => send("helper:warning", l));
}

app.whenReady().then(() => {
  startSupervisor();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", async () => {
  await sup?.shutdown();
  if (process.platform !== "darwin") app.quit();
});

// Devices are released on a deliberate quit, not left to process teardown.
app.on("before-quit", async () => { await sup?.shutdown(); });

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
    const r = await sup.startRecording(dir);
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

ipcMain.handle("recorder:reveal", async (_e, dir: string) => {
  if (!win) return;
  await dialog.showMessageBox(win, { message: "Recording saved", detail: dir, buttons: ["OK"] });
});
