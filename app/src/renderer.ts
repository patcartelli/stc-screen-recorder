/** UI: a record button, live telemetry, and anything that went wrong stated plainly. */
interface DisplayInfo {
  id: number; main: boolean; name?: string;
  pointW: number; pointH: number; pixelW: number; pixelH: number;
  originX?: number; originY?: number;
}
interface StillSettingsView {
  format: string; quality: number; scale: string;
  stripMetadata: boolean; template: string; destination: string | null;
}
interface ThumbnailSettingsView {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  timeoutMs: number;
  settleAction: "save" | "copy";
  skip: boolean;
}
interface AppSettings {
  camera: boolean;
  displayId: number | null;
  /** STC-292. */
  shutterSound: boolean;
  /** STC-293. */
  still: StillSettingsView;
  /** STC-296. */
  thumbnail: ThumbnailSettingsView;
}
interface Take {
  dir: string; name: string; durationMs: number;
  width: number; height: number; events: number; bytes: number; label?: string;
  camera?: { present: boolean; device?: string; pipStartsAfterMs: number };
}
interface StillResult {
  ok: boolean; cancelled?: boolean; dir?: string; kind?: string;
  file?: string; shot?: any; warning?: string; code?: string; detail?: string;
  source?: string;
}
declare const recorder: {
  getSettings: () => Promise<AppSettings>;
  setSettings: (p: Partial<AppSettings>) => Promise<AppSettings>;
  devices(): Promise<{ displays?: DisplayInfo[]; stalled?: boolean; detail?: string }>;
  status(): Promise<{ state: string; pid?: number }>;
  takes(): Promise<{ takes: Take[]; invalid: { name: string; reason: string }[] }>;
  library(filter?: string): Promise<LibraryList>;
  writeThumbnail(dir: string, bytes: ArrayBuffer): Promise<boolean>;
  getFrame(dir: string, name: string): Promise<ArrayBuffer>;
  getShot(dir: string): Promise<Shot>;
  reopenStill(dir: string): Promise<{ ok: boolean }>;
  duplicateStill(dir: string): Promise<{ ok: boolean; dir: string }>;
  labelTake(dir: string, label: string): Promise<boolean>;
  deleteTake(dir: string): Promise<{ deleted: boolean }>;
  openPreview(dir: string): Promise<boolean>;
  closePreview(): Promise<void>;
  readTakeFile(name: string): Promise<ArrayBuffer>;
  takeFileSize(name: string): Promise<number>;
  readTakeChunk(name: string, offset: number, length: number): Promise<ArrayBuffer>;
  writeProject(bytes: ArrayBuffer): Promise<boolean>;
  writeExport(name: string, bytes: ArrayBuffer): Promise<string>;
  captureStill(action?: CaptureAction): Promise<StillResult>;
  getShortcuts(): Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  setShortcut(action: CaptureAction, accelerator: string | null):
    Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  resetShortcuts(): Promise<{ shortcuts: Shortcuts; report: ShortcutReport[] }>;
  // `copyFrame` used to sit here (STC-298) and is gone: it was a second
  // encoder and a second clipboard, and the preview's frame grab goes through
  // `exportStill` like every other way out of the app now (STC-293).
  exportStill(req: {
    bytes: ArrayBuffer; width: number; height: number; alpha: boolean; colorSpace?: string;
    target: { file: boolean; clipboard: boolean };
    options: { format: string; quality: number; scale: string;
               stripMetadata: boolean; template: string; flattenColor?: string };
    info: { app?: string; title?: string; mode: string };
    dir?: string;
  }): Promise<{
    ok: boolean; file?: string; bytes?: number; clipboard?: string[];
    width?: number; height?: number; format?: string; alpha?: boolean;
    premultiplied?: boolean; metadata?: string; code?: string; detail?: string;
  }>;
  chooseStillDestination(): Promise<{ destination: string | null }>;
  clearStillDestination(): Promise<{ destination: string | null }>;
  start(): Promise<{ ok: boolean; dir?: string; code?: string; detail?: string }>;
  stop(): Promise<{ ok: boolean; info?: any }>;
  reveal(dir: string): Promise<void>;
  publish(): Promise<{
    ok: boolean; plan: PublishPlan["kind"]; message?: string;
    file?: string; name?: string; replaced?: boolean; snippet?: string;
  }>;
  chooseShareDestination(): Promise<{ destination: string | null }>;
  revealPublished(): Promise<{ ok: boolean; file?: string; message?: string }>;
  on(event: string, cb: (p: any) => void): () => void;
};

import {
  ACTION_LABELS, CAPTURE_ACTIONS, acceleratorFromKeyStroke, explainShortcut,
  formatAccelerator, parseAccelerator,
  type CaptureAction, type ShortcutReport, type Shortcuts,
} from "./hotkeys.js";
import { loadSession, type LoadedSession } from "@transform/session";
import { PreviewPlayer } from "@transform/preview";
import { exportSession } from "@transform/export";
import type { Project } from "@transform/types";
import {
  parseProject, projectForWrite, exportWindow, estimateExportMs,
  clampTrim, isFullTake, minTrimNs,
} from "@transform/trim";
import {
  outputOptions, selectedOption, type OutputOption,
} from "@transform/output-size";
import type { Size } from "@transform/spaces";
import { TRANSFORM_VERSION } from "@transform/transform-version";
import { renderLibrary, type LibraryCallbacks } from "./library-view.js";
import type { LibraryItem, LibraryList } from "./library-items.js";
import { exportManifestName, exportMediaName, type PublishPlan } from "./share.js";
import { decorationForMode, layoutStill } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { colorSpaceFor } from "@transform/still-export";
import type { Shot } from "@transform/shot";

const $ = (id: string) => document.getElementById(id)!;
const recordBtn = $("record") as HTMLButtonElement;
const stillBtn = $("capturestill") as HTMLButtonElement;
const cameraBox = $("camera") as HTMLInputElement;
let recording = false;

/**
 * Opt-in, default off, sticky. The stored preference is the authority — main
 * reads it again at `start`, so this control only proposes changes.
 *
 * Disabled while recording: the helper opens the device at start and closes it
 * at stop, so a mid-take flip would misdescribe what is being recorded.
 */
void (async () => {
  try {
    cameraBox.checked = (await recorder.getSettings()).camera;
  } catch {
    cameraBox.checked = false;
  }
})();

cameraBox.addEventListener("change", async () => {
  try {
    const saved = await recorder.setSettings({ camera: cameraBox.checked });
    // Show what was actually stored, not what was clicked.
    cameraBox.checked = saved.camera;
  } catch (e) {
    cameraBox.checked = !cameraBox.checked;
    alertUser(`Could not save the camera setting: ${String(e)}`);
  }
});

/**
 * Which display to record (STC-247). "Automatic" is the phase-1 behaviour —
 * whichever display the helper lists first — and the only choice a
 * single-display machine ever needs. The list comes from the helper's own
 * `devices` enumeration, so what is offered is exactly what it can capture;
 * it is refreshed when the helper comes up and whenever a display is plugged
 * in or out while idle. A stored choice whose display is gone is shown as
 * such rather than silently dropped: `start` would then be refused with
 * `display-not-found`, and the user should see why before pressing Record.
 */
const displaySel = $("display") as HTMLSelectElement;
let storedDisplayId: number | null = null;

function displayLabel(d: DisplayInfo): string {
  const name = d.name ?? `Display ${d.id}`;
  return `${name} ${Math.round(d.pointW)}×${Math.round(d.pointH)}${d.main ? " (main)" : ""}`;
}

async function refreshDisplays(): Promise<void> {
  let displays: DisplayInfo[] = [];
  try {
    const r = await recorder.devices();
    displays = Array.isArray(r.displays) ? r.displays : [];
  } catch {
    displays = [];
  }
  const wanted = storedDisplayId;
  displaySel.replaceChildren();
  const auto = document.createElement("option");
  auto.value = ""; auto.textContent = "Automatic";
  displaySel.append(auto);
  for (const d of displays) {
    const o = document.createElement("option");
    o.value = String(d.id); o.textContent = displayLabel(d);
    displaySel.append(o);
  }
  if (wanted != null && !displays.some((d) => d.id === wanted)) {
    const o = document.createElement("option");
    o.value = String(wanted); o.textContent = `Display ${wanted} (not connected)`;
    displaySel.append(o);
  }
  displaySel.value = wanted == null ? "" : String(wanted);
}

void (async () => {
  try {
    storedDisplayId = (await recorder.getSettings()).displayId;
  } catch {
    storedDisplayId = null;
  }
  await refreshDisplays();
})();

displaySel.addEventListener("change", async () => {
  const chosen = displaySel.value === "" ? null : Number(displaySel.value);
  try {
    const saved = await recorder.setSettings({ displayId: chosen });
    // Show what was actually stored, not what was clicked.
    storedDisplayId = saved.displayId;
  } catch (e) {
    alertUser(`Could not save the display setting: ${String(e)}`);
  }
  await refreshDisplays();
});

/** The camera and display are fixed at start and released at stop, so neither
 * setting may look changeable mid-take. */
function lockSettings(locked: boolean): void {
  cameraBox.disabled = locked;
  displaySel.disabled = locked;
}
let currentDir: string | undefined;

function setState(text: string): void { $("state").textContent = text; }
function alertUser(text: string): void { $("alert").textContent = text; $("alert").classList.add("show"); }
function clearAlert(): void { $("alert").classList.remove("show"); }
function stillStatus(text?: string): void {
  const el = $("stillstatus");
  if (!text) { el.setAttribute("hidden", ""); el.textContent = ""; return; }
  el.textContent = text;
  el.removeAttribute("hidden");
}

const KIND_WORDS: Record<string, string> = {
  region: "region", window: "window", display: "full display",
};

/**
 * Say what a capture did, wherever it came from.
 *
 * Shared by the button and by `still:captured`, which is how a hotkey or
 * menu-bar capture reaches an open window (STC-292). One function because the
 * two must not drift: a shot taken by hotkey is the same shot, and reporting it
 * differently would make the window's account of the take library depend on
 * which door the user came through.
 */
async function reportStill(r: StillResult): Promise<void> {
  if (r.cancelled) return;
  if (!r.ok) {
    alertUser(r.code === "no-displays"
      ? "Screen Recording permission is required.\nGrant it in System Settings › Privacy & Security › Screen & System Audio Recording, then try again."
      : r.code === "still-unsupported"
      ? "Still capture needs macOS 14 or newer."
      : r.code === "overlay-open"
      ? "A capture is already in progress."
      : `Could not capture: ${r.code}\n${r.detail ?? ""}`);
    return;
  }
  const px = r.shot?.frame ? `${r.shot.frame.width} × ${r.shot.frame.height}` : "";
  stillStatus(`Captured ${KIND_WORDS[r.kind ?? ""] ?? "still"} ${px} → ${r.dir?.split("/").pop() ?? ""}`);
  if (r.warning) alertUser(r.warning);
  await refreshTakes();
  // The floating thumbnail (STC-296) is presented from the MAIN process, not
  // from here: a capture from the global hotkey or the menu bar has no window
  // waiting on this function at all, and the panel has to appear either way.
  // This function's job is only to keep an OPEN window's own account (the
  // status line, the take list) truthful about a capture it did not ask for.
}

/**
 * Capture a still (STC-290). The overlay owns the whole interaction, so there
 * is nothing to do here but ask for it and say what came back.
 *
 * The button is disabled for the duration: the overlay is modal in effect —
 * it covers every display — and a second press behind it would queue a second
 * capture the user cannot see themselves asking for. Cancelling is a normal
 * outcome and says nothing, the way dismissing macOS's own crosshair does.
 */
stillBtn.addEventListener("click", async () => {
  stillBtn.disabled = true;
  clearAlert();
  stillStatus();
  try {
    await reportStill(await recorder.captureStill("region"));
  } catch (e: any) {
    alertUser(`Could not capture: ${e?.message ?? e}`);
  } finally {
    stillBtn.disabled = false;
  }
});

// A capture that started somewhere this window was not: a global hotkey or the
// menu bar. The shot is on disk whether or not anyone is watching — this only
// keeps an open window from showing a stale take list and no explanation.
recorder.on("still:captured", (r: StillResult) => { void reportStill(r); });

/**
 * Why a take did not start, said in terms of what it costs and what to do.
 *
 * A map rather than the ternary chain this replaced: there are two permission
 * refusals now, they read almost identically to a user ("something about
 * privacy settings"), and they send you to DIFFERENT panes. A chain that grows
 * one arm per grant is how the second one ends up phrased as an afterthought
 * of the first.
 *
 * Neither says "try again" without saying what to change first — a start that
 * refused for a missing grant will refuse identically until the grant exists,
 * and inviting a retry is how someone presses Record four times and concludes
 * the app is broken.
 */
const START_FAULTS: Record<string, string> = {
  "no-displays":
    "Screen Recording permission is required.\nGrant it in System Settings › " +
    "Privacy & Security › Screen & System Audio Recording, then try again.",
  // STC-315. This used to be a WARNING, arriving after the take was already
  // running: the recording went ahead with no cursor track at all, and since
  // the pixels never carry a pointer (the transform draws it from events.json)
  // the resulting file looked like every other take and had no cursor
  // anywhere. It is a refusal now — nothing was recorded — so the sentence has
  // to say that first, before the fix, or a user reads "grant this" and
  // assumes the take they just made is fine.
  "event-tap-unavailable":
    "Nothing was recorded — the take did not start.\n\nThe recorder could not " +
    "watch your mouse, and the cursor is never captured in the video itself: it " +
    "is drawn afterwards from what the tap records. A take without it would have " +
    "no cursor at all, so it is refused rather than made.\n\nGrant Input " +
    "Monitoring in System Settings › Privacy & Security › Input Monitoring, then " +
    "press Record again.",
};

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  clearAlert();
  try {
    if (!recording) {
      const r = await recorder.start();
      if (!r.ok) {
        alertUser(START_FAULTS[String(r.code)] ?? `Could not start: ${r.code}\n${r.detail ?? ""}`);
        setState("idle");
      } else {
        recording = true;
        // Reset per take, and say "opening…" rather than "—": the camera opens
        // off the critical path, so there IS a window where it is neither
        // absent nor live, and that window is the whole complaint (STC-287).
        setCamera(cameraBox.checked ? "opening…" : "off");
      // The device is opened at start and closed at stop, so the setting must
      // not appear changeable mid-take — it would misdescribe the recording.
      lockSettings(true);
        currentDir = r.dir;
        recordBtn.textContent = "Stop";
        setState("recording");
      }
    } else {
      await recorder.stop();
      recording = false;
      lockSettings(false);
      recordBtn.textContent = "Record";
      setState("idle");
      await refreshTakes();
    }
  } catch (e: any) {
    alertUser(String(e?.message ?? e));
  } finally {
    recordBtn.disabled = false;
  }
});

recorder.on("helper:ready", (l) => {
  $("pid").textContent = String(l.pid ?? "—");
  // A (re)started helper can enumerate; a respawned one may see a different
  // set of displays than the last one did.
  void refreshDisplays();
  if (!recording) setState("idle");
  recordBtn.disabled = false;
});

recorder.on("helper:stats", (s) => {
  // The heartbeat runs from boot, not just while recording — that is the whole
  // point of it, so surface it. An idle helper that has stopped beating is a
  // wedged helper, and the panel should not look identical either way.
  $("alive").textContent = s.state ?? "—";
  $("frames").textContent = s.frames ?? "—";
  $("dropped").textContent = s.dropped ?? "—";
  $("events").textContent = s.events ?? "—";
  // STC-309: shape changes are counted inside `events` too; shown apart so a
  // take with no pointer motion still reads as one.
  $("cursorEvents").textContent = s.cursorEvents ?? "—";
  $("elapsed").textContent = s.elapsedMs != null ? `${(s.elapsedMs / 1000).toFixed(1)}s` : "—";
});

/**
 * Why the helper ended a take on its own, in the user's terms. Anything not
 * named here is shown by its reason code rather than dropped.
 */
const ENDED_BY_HELPER: Record<string, string> = {
  "display-reconfigured": "Display configuration changed, so the recording was stopped.",
  // STC-306: SCStream reported itself dead under a live take. The helper
  // stops cleanly rather than sitting in "recording" with no frames arriving.
  "stream-stopped": "The display capture stopped unexpectedly, so the recording was stopped.",
};

recorder.on("helper:recording-ended", (i) => {
  // The helper stopped by itself — a display change, or a display stream that
  // died. The file is valid; what would be wrong is leaving the button saying
  // "Stop".
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  refreshTakes();
  const why = ENDED_BY_HELPER[String(i.reason)] ?? `Recording stopped by the recorder (${i.reason}).`;
  alertUser(`${why}\nWhat was captured up to that point was saved.`);
  if (i.dir) recorder.reveal(i.dir);
});

recorder.on("helper:recording-lost", (i) => {
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  alertUser(`The recorder quit while recording — that take was not saved.\n${i.dir ?? ""}`);
});

/**
 * STC-287: the camera's whole lifecycle used to be invisible.
 *
 * It opens off the critical path (Capture.swift, deliberately — startRunning()
 * blocks and must not delay every `started` reply), so it goes live roughly a
 * second after recording begins. Measured across five real takes, the PiP is
 * absent for 1.26–1.39 s of playback.
 *
 * The helper has always announced this — `camera-started` with the device name,
 * and warnings for every failure. Nothing listened. So a user who ticked Camera
 * got no confirmation it worked, no notice when it did NOT, and a PiP that
 * appeared a beat late and read as a glitch. The gap is inherent; being unable
 * to tell a working camera from a broken one was not.
 */
function setCamera(text: string): void { $("camera-state").textContent = text; }

recorder.on("helper:camera-started", (l) => {
  setCamera(String(l.device ?? "live"));
});

recorder.on("helper:respawned", () => setState("recovered — helper restarted"));
recorder.on("helper:gave-up", () => { recordBtn.disabled = true; alertUser("The recorder keeps failing to start. Restart the app."); });
/**
 * Camera failures the user must actually see. Every one of these was already
 * being emitted and silently dropped: the handler below matched exactly one
 * code and ignored the rest, so a camera that could not open, or that opened
 * and delivered nothing, looked identical to one that worked.
 */
const CAMERA_FAULTS: Record<string, string> = {
  "camera-failed": "The camera could not be opened, so this take has no picture-in-picture.",
  "virtual-camera-only":
    "Only a virtual camera was available. It was not used, so this take has no " +
    "picture-in-picture — connect a real camera and record again.",
  "device-disconnected": "A capture device was disconnected during the recording.",
  // STC-286. The one that looked exactly like success: the camera opens,
  // reports its name, and delivers nothing. Confirmed in clamshell on real
  // hardware — camera-started with "FaceTime HD Camera", then a 0-byte
  // camera.mp4. Until this warning existed the app showed the device name for
  // the whole take and only admitted the truth afterwards, in the library.
  "camera-no-frames":
    "The camera opened but is not sending any frames, so this take will have no " +
    "picture-in-picture. A closed laptop lid, a covered lens, or another app using " +
    "the camera all look like this.",
};

/**
 * Warnings that are not about the camera but still decide whether a take is
 * what the user thinks it is.
 *
 * `event-tap-unavailable` used to be the entry that mattered most here and is
 * deliberately NOT one any more: since STC-315 a take that cannot record the
 * cursor does not start, so the helper answers the `start` request with that
 * code instead of warning about a recording already underway. Its wording
 * lives in START_FAULTS, where it can say "nothing was recorded" — which is
 * the fact a warning phrased for a live take could not state. Leaving a copy
 * here would be a message that can no longer fire, describing a take that can
 * no longer exist.
 *
 * `stream-stopped` is a display stream that died mid-take. It used to leave the
 * helper in "recording" with frames simply stopping until Stop was pressed;
 * since STC-306 the helper ends the take itself, so this warning is followed
 * by a `recording-ended` with the same reason.
 */
const RECORDING_FAULTS: Record<string, string> = {
  "stream-stopped":
    "The display capture stopped unexpectedly, so the recording is being stopped. " +
    "What was captured up to this point is kept.",
  "av-runtime-error": "A capture device reported an error during the recording.",
};

/**
 * Emitted by the helper's watchers whenever ANY display changes, recording or
 * not. While recording it is accompanied by display-change-during-recording,
 * which is the one that says what happened to the take; alone it is an idle
 * machine's monitor being plugged in, and not worth an alert.
 */
const INFORMATIONAL_WARNINGS = new Set(["display-reconfigured"]);

recorder.on("helper:warning", (l) => {
  const code = String(l.code);
  if (code === "display-change-during-recording") {
    alertUser("Display configuration changed — the recording was stopped.");
    return;
  }
  if (INFORMATIONAL_WARNINGS.has(code)) {
    // An idle display change is not an alert, but it is a new list of
    // displays; the picker must not go on offering one that was unplugged.
    if (code === "display-reconfigured") void refreshDisplays();
    return;
  }
  const camera = CAMERA_FAULTS[code];
  if (camera) {
    // Both: the row is the at-a-glance state, the alert is the thing that
    // cannot be missed. A silent failure is what this whole change exists to
    // remove. "no frames" is not the same as "failed to open", and the row
    // said the device name right up until this fired. Name the state, not
    // just the code.
    setCamera(code === "camera-no-frames" ? "no frames" : `failed — ${code}`);
    alertUser(l.detail ? `${camera}\n\n${l.detail}` : camera);
    return;
  }
  // Everything else is shown too. This handler used to match a handful of
  // codes and drop the rest, which is how a take with no cursor track looked
  // like a good one; a warning the helper thought worth a reliable-channel
  // line is not one the UI gets to discard.
  const text = RECORDING_FAULTS[code] ?? `The recorder reported a problem: ${code}`;
  alertUser(l.detail ? `${text}\n\n${l.detail}` : text);
});

const fmtDuration = (ms: number) => {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const fmtSize = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;

// ---- preview -------------------------------------------------------------

let player: PreviewPlayer | undefined;
let scrubbing = false;
let openSession: LoadedSession | undefined;
let openProject: Project | undefined;
let openTakeName = "";
/** The open take's directory, so a saved frame can land beside its recording. */
let openTakeDir = "";
/**
 * The take's capture size — the aspect ratio every export size is derived from,
 * and the ceiling above which an option would be inventing pixels.
 *
 * Held apart from `openProject.output`, which is the CHOSEN size and moves.
 * Reading the aspect back off the output once it had been changed would let a
 * second change compound the first's rounding.
 */
let openCapture: Size | undefined;
let exportAbort: AbortController | undefined;

const fmtClock = (ns: number) => {
  const s = Math.max(0, Math.round(ns / 1e9));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtEstimate = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `~${s}s to export`;
  return `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} to export`;
};

function updateTrimUI(): void {
  if (!player || !openProject) return;
  const d = player.durationNs || 1;
  const start = openProject.trim?.startNs ?? 0;
  const end = openProject.trim?.endNs ?? player.durationNs;
  const inPct = (start / d) * 100;
  const outPct = (end / d) * 100;
  ($("trim-in") as HTMLElement).style.left = `${inPct}%`;
  ($("trim-out") as HTMLElement).style.left = `${outPct}%`;
  const kept = $("kept") as HTMLElement;
  kept.style.left = `${inPct}%`;
  kept.style.width = `${Math.max(0, outPct - inPct)}%`;

  const w = exportWindow(openProject, player.durationNs);
  const est = fmtEstimate(estimateExportMs(w.maxFrames));
  $("triminfo").textContent = isFullTake(openProject, player.durationNs)
    ? `Full take · ${fmtClock(player.durationNs)} · ${est}`
    : `${fmtClock(w.startNs)}–${fmtClock(w.endNs)} · ${fmtClock(w.endNs - w.startNs)} · ${est}`;
}

async function persistProject(): Promise<void> {
  if (!openProject || !player) return;
  const doc = projectForWrite(openProject, player.durationNs);
  await recorder.writeProject(
    new TextEncoder().encode(JSON.stringify(doc, null, 2)).buffer as ArrayBuffer,
  );
}

function setTrim(startNs: number, endNs: number, persist: boolean): void {
  if (!openProject || !player) return;
  const next = clampTrim(startNs, endNs, player.durationNs, openProject.output.fps);
  if (next.startNs === 0 && next.endNs === player.durationNs) delete openProject.trim;
  else openProject.trim = next;
  updateTrimUI();
  if (persist) void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}

/**
 * The export-size row (STC-335).
 *
 * A size the options do not offer — every take hand-edited under the old
 * `project.json` workaround carries one — is shown as its own entry and
 * SELECTED, so opening such a take neither misreports its setting nor loses it
 * on the next save. Picking something else is the user discarding it, which is
 * a different thing from the app discarding it for them.
 */
function updateOutputSizeUI(): void {
  if (!openProject || !openCapture) return;
  const sel = $("outsize") as HTMLSelectElement;
  const out = openProject.output;
  const opts = outputOptions(openCapture);
  const known = selectedOption(openCapture, out);

  sel.replaceChildren();
  if (!known) {
    const o = document.createElement("option");
    o.value = "custom";
    o.textContent = `Custom · ${out.width}×${out.height}`;
    sel.append(o);
  }
  for (const opt of opts) {
    const o = document.createElement("option");
    o.value = opt.id;
    o.textContent = opt.label;
    // Offered and refused, rather than absent: a preset that vanished on a
    // small capture reads as a bug in the list rather than a fact about the
    // take.
    o.disabled = opt.upscales;
    if (opt.upscales) o.textContent += " — larger than the capture";
    sel.append(o);
  }
  sel.value = known ? known.id : "custom";

  const note = $("outsizenote");
  note.textContent = known?.id === "capture" || (!known && sameAsCapture(out))
    ? "No rescale."
    : `Capture is ${openCapture.width}×${openCapture.height}.`;
}

const sameAsCapture = (out: Size) =>
  !!openCapture && out.width === openCapture.width && out.height === openCapture.height;

async function setOutputSize(opt: OutputOption): Promise<void> {
  if (!openProject || !player) return;
  // `output.fps` is untouched: 60 is the settled export rate and this control
  // is about size only. Rebuilding the object would be the quiet way to drop it.
  openProject.output.width = opt.size.width;
  openProject.output.height = opt.size.height;
  updateOutputSizeUI();
  // The canvas is sized in the player's constructor and `composite` reads the
  // project every draw, so the player has to be told or it draws the new size
  // onto the old canvas.
  await player.outputResized();
  await persistProject();
}

$("outsize").addEventListener("change", () => {
  if (!openProject || !openCapture) return;
  const id = ($("outsize") as HTMLSelectElement).value;
  const opt = outputOptions(openCapture).find((o) => o.id === id);
  // "custom" has no option to apply — re-selecting it is a no-op, not a reset
  // to the capture size.
  if (!opt || opt.upscales) { updateOutputSizeUI(); return; }
  void setOutputSize(opt).catch((e: any) => alertUser(String(e?.message ?? e)));
});

async function openPreview(take: Openable): Promise<void> {
  try {
    await openPreviewOrThrow(take);
  } catch (e: any) {
    // loadSession and the demuxer write specific, actionable messages — an
    // offset disagreement, an unsupported version, a file with no frames.
    // Swallowing them leaves a button that does nothing, which is the least
    // debuggable failure the app can have.
    await closePreview();
    alertUser(`Could not open "${take.label ?? take.name}".\n${e?.message ?? e}`);
  }
}

/** Slice size: big enough that the per-message overhead is noise, small enough
 *  that the transient copy is a rounding error against the take itself. */
const VIDEO_CHUNK_BYTES = 32 * 1024 * 1024;

/**
 * Reads display.mp4 into ONE buffer allocated up front.
 *
 * A single-message read makes the file exist twice at the same instant — the
 * copy IPC delivers plus the copy the renderer keeps — which measured ~949 MB
 * of heap for a 458 MB take. Assembling slices into a pre-allocated destination
 * keeps the peak at roughly the file size plus one slice.
 */
async function readVideo(name = "display.mp4"): Promise<ArrayBuffer> {
  const size = await recorder.takeFileSize(name);
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += VIDEO_CHUNK_BYTES) {
    const length = Math.min(VIDEO_CHUNK_BYTES, size - offset);
    out.set(new Uint8Array(await recorder.readTakeChunk(name, offset, length)), offset);
  }
  return out.buffer;
}

async function openPreviewOrThrow(take: Openable): Promise<void> {
  await closePreview();
  await recorder.openPreview(take.dir);

  // Bytes come over IPC from the take main deliberately opened; the renderer
  // never names a path.
  const dec = new TextDecoder();
  const [anchors, events, mp4, projectRaw] = await Promise.all([
    recorder.readTakeFile("anchors.json").then((b) => JSON.parse(dec.decode(b))),
    recorder.readTakeFile("events.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => ({ version: 1, events: [] })),
    readVideo(),
    recorder.readTakeFile("project.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => null),
  ]);
  // Chunked like the display track, and only when the take's own anchors claim
  // a camera: loadSession refuses a file the anchors do not claim, and refuses
  // a claim with no file. Skipping this made every camera take unopenable in
  // the app — the sequencing constraint increment 4b exists to discharge.
  const cameraMp4 = anchors.files?.camera ? await readVideo(anchors.files.camera) : undefined;
  const session = await loadSession({ anchors, events, displayMp4: mp4, cameraMp4 });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  // The take's own camera decides whether a PiP is on by default. Without this
  // an app-recorded camera take previews with pip: null — nothing writes a
  // project.json at record time.
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );

  openSession = session;
  openProject = project;
  openTakeName = take.name;
  openTakeDir = take.dir;
  openCapture = { width: anchors.capture.width, height: anchors.capture.height };
  player = new PreviewPlayer($("stage") as HTMLCanvasElement, session, project);
  const scrub = $("scrub") as HTMLInputElement;
  player.onTime = (tNs, playing) => {
    $("clock").textContent = `${fmtClock(tNs)} / ${fmtClock(player!.durationNs)}`;
    ($("playpause") as HTMLButtonElement).textContent = playing ? "Pause" : "Play";
    if (!scrubbing) scrub.value = String(Math.round((tNs / (player!.durationNs || 1)) * 1000));
  };
  // Revealed only once a frame has actually been drawn, so a failure part-way
  // through never leaves a half-open player on screen.
  // Open on the first frame that actually renders, not on t=0. A take's first
  // frame lands a couple of hundred milliseconds in (capture starts after the
  // command), so seeking to zero is correct by the contract — "no frame yet" —
  // and shows the user a black rectangle that looks like a broken player.
  await player.seek(player.firstRenderableNs);
  updateTrimUI();
  updateOutputSizeUI();
  $("player").removeAttribute("hidden");
}

async function closePreview(): Promise<void> {
  exportAbort?.abort();
  $("framestatus").setAttribute("hidden", "");
  player?.close();
  player = undefined;
  openSession = undefined;
  openProject = undefined;
  openCapture = undefined;
  $("player").setAttribute("hidden", "");
  await recorder.closePreview();
}

$("playpause").addEventListener("click", () => {
  if (!player) return;
  player.isPlaying ? player.pause() : player.play();
  ($("playpause") as HTMLButtonElement).textContent = player.isPlaying ? "Pause" : "Play";
});
$("closepreview").addEventListener("click", () => void closePreview());
$("scrub").addEventListener("pointerdown", () => { scrubbing = true; });
$("scrub").addEventListener("pointerup", () => { scrubbing = false; });
$("scrub").addEventListener("input", () => {
  if (!player) return;
  // Fire and forget: the source supersedes stale requests, so a drag does not
  // queue up dozens of decodes.
  void player.seek((Number(($("scrub") as HTMLInputElement).value) / 1000) * player.durationNs);
});

$("markin").addEventListener("click", () => {
  if (!player || !openProject) return;
  const t = player.currentNs;
  const end = openProject.trim?.endNs ?? player.durationNs;
  const min = minTrimNs(openProject.output.fps);
  setTrim(t, t + min > end ? player.durationNs : end, true);
});
$("markout").addEventListener("click", () => {
  if (!player || !openProject) return;
  const t = player.currentNs;
  const start = openProject.trim?.startNs ?? 0;
  const min = minTrimNs(openProject.output.fps);
  setTrim(t < start + min ? 0 : start, t, true);
});
$("resettrim").addEventListener("click", () => {
  if (!player) return;
  setTrim(0, player.durationNs, true);
});

function nsAtClientX(clientX: number): number {
  const r = $("timeline").getBoundingClientRect();
  const t = r.width <= 0 ? 0 : (clientX - r.left) / r.width;
  return Math.round(Math.max(0, Math.min(1, t)) * (player?.durationNs ?? 0));
}

let dragging: "in" | "out" | undefined;
function onHandleDown(which: "in" | "out", e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  dragging = which;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onHandleMove(e: PointerEvent): void {
  if (!dragging || !player || !openProject) return;
  const t = nsAtClientX(e.clientX);
  const start = openProject.trim?.startNs ?? 0;
  const end = openProject.trim?.endNs ?? player.durationNs;
  if (dragging === "in") setTrim(t, end, false);
  else setTrim(start, t, false);
}
function onHandleUp(): void {
  if (!dragging) return;
  dragging = undefined;
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
}
$("trim-in").addEventListener("pointerdown", (e) => onHandleDown("in", e as PointerEvent));
$("trim-out").addEventListener("pointerdown", (e) => onHandleDown("out", e as PointerEvent));
$("trim-in").addEventListener("pointermove", (e) => onHandleMove(e as PointerEvent));
$("trim-out").addEventListener("pointermove", (e) => onHandleMove(e as PointerEvent));
$("trim-in").addEventListener("pointerup", onHandleUp);
$("trim-out").addEventListener("pointerup", onHandleUp);
$("trim-in").addEventListener("pointercancel", onHandleUp);
$("trim-out").addEventListener("pointercancel", onHandleUp);

// ---- export --------------------------------------------------------------

async function runExport(): Promise<void> {
  if (!openSession || !openProject || exportAbort) return;
  player?.pause();
  exportAbort = new AbortController();

  const bar = $("exportbar");
  const progress = $("exportprogress") as HTMLProgressElement;
  const status = $("exportstatus");
  bar.removeAttribute("hidden");
  ($("export") as HTMLButtonElement).disabled = true;
  progress.value = 0;
  status.textContent = "Exporting…";
  clearAlert();

  const started = performance.now();
  try {
    const result = await exportSession(openSession, openProject, {
      // Hashing costs a full pixel read-back per frame and exists for the
      // gates. It is on here so the manifest can record a verifiable hash —
      // an export nobody can check is an export nobody can trust.
      hash: true,
      signal: exportAbort.signal,
      onProgress: (done, total) => {
        progress.value = Math.round((done / total) * 1000);
        const elapsed = (performance.now() - started) / 1000;
        const rate = done / Math.max(elapsed, 0.001);
        const left = Math.max(0, Math.round((total - done) / Math.max(rate, 0.001)));
        status.textContent = `${done} / ${total} frames · ~${left}s left`;
      },
    });

    if (result.cancelled) { status.textContent = "Cancelled."; return; }

    // Both names come from `share.ts` rather than being built here. STC-242's
    // publish path has to FIND this exact file afterwards, from another
    // process — two copies of one filename rule is the defect CLAUDE.md
    // records fixing four times in one session, and `share.test.ts` greps this
    // file to keep the second copy from coming back.
    const name = exportMediaName(openTakeName);
    await recorder.writeExport(name, result.encoded!.buffer as ArrayBuffer);
    const lastNs = openSession.frames[openSession.frames.length - 1] ?? 0;
    await recorder.writeExport(exportManifestName(openTakeName), new TextEncoder().encode(JSON.stringify({
      version: 1,
      // Which transform computed the hash below. Without it the manifest could
      // verify an export against itself and never say what made it (STC-308).
      transform: { version: TRANSFORM_VERSION },
      frames: result.frames,
      preEncodeHash: result.hash,
      encodedBytes: result.encodedBytes,
      output: openProject.output,
      trim: projectForWrite(openProject, lastNs).trim ?? null,
      exportDurationMs: result.durationMs,
    }, null, 2)).buffer as ArrayBuffer);

    status.textContent = `Done — ${result.frames} frames, ${(result.encodedBytes / 1e6).toFixed(1)} MB`;
    await refreshTakes();
  } catch (e: any) {
    status.textContent = "Failed.";
    alertUser(`Export failed: ${e?.message ?? e}`);
  } finally {
    exportAbort = undefined;
    ($("export") as HTMLButtonElement).disabled = false;
  }
}

$("export").addEventListener("click", () => void runExport());

/**
 * Share (STC-242) — the last step of the loop.
 *
 * The renderer names no path and holds no destination: it asks main to
 * publish, and renders whatever main says happened. Every refusal already
 * carries its own sentence from `planPublish`, so there is no message-building
 * here and no second copy of the wording — the same rule `hotkeys.ts` follows
 * for every sentence the user is shown.
 */
function shareStatus(text: string): void {
  $("sharestatus").textContent = text;
}

async function publish(): Promise<void> {
  const btn = $("share") as HTMLButtonElement;
  btn.disabled = true;
  shareStatus("Copying…");
  try {
    const r = await recorder.publish();
    if (!r.ok) { shareStatus(r.message ?? "Could not share."); return; }
    // "Replaced" rather than "Wrote" when something was already there. The
    // stable slug means re-publishing OVERWRITES by design, and the design
    // being deliberate is not a reason to be quiet about it — a person who
    // did not expect it should learn so from the app, not from `git status`.
    const verb = r.replaced ? "Replaced" : "Wrote";
    shareStatus(`${verb} ${r.name}. Snippet copied.`);
    if (r.snippet) await navigator.clipboard.writeText(r.snippet).catch(() => {
      // The file is the deliverable; the snippet is a convenience. A clipboard
      // that refuses must not read as a failed publish.
      shareStatus(`${verb} ${r.name}. (Could not copy the snippet.)`);
    });
  } catch (e: any) {
    shareStatus(`Failed: ${e?.message ?? e}`);
  } finally {
    btn.disabled = false;
  }
}

$("share").addEventListener("click", () => void publish());
$("sharedest").addEventListener("click", () => void (async () => {
  const { destination } = await recorder.chooseShareDestination();
  shareStatus(destination ? `Site folder: ${destination}` : "No site folder chosen.");
})());
$("revealshared").addEventListener("click", () => void (async () => {
  const r = await recorder.revealPublished();
  if (!r.ok) shareStatus(r.message ?? "Nothing published yet.");
})());

// ---- the current frame as a still (STC-298) -------------------------------
//
// Deliberately small: no shot.json, no still take, no editor. The frame the
// playhead is on — composited by the same render() and compositor the video
// export uses, on the export's own 60 fps grid — copied or saved as a PNG.
// Named "frame" everywhere so it cannot be mistaken for exporting the video.

function frameStatus(text: string): void {
  const el = $("framestatus");
  el.textContent = text;
  el.removeAttribute("hidden");
}

/**
 * `frame-<take>-<ms>ms`: the take it came from and where in it.
 *
 * A template rather than a finished name, because the extension belongs to the
 * chosen format and the collision suffix belongs to the destination folder —
 * both of which are `still-export.ts`'s to decide. The literal text carries no
 * `{token}`, which is legal: a template with no tokens is a constant name, and
 * the uniqueness pass still makes it collision-free.
 */
function frameTemplate(tNs: number): string {
  return `frame-${openTakeName}-${Math.round(tNs / 1e6)}ms`;
}

let frameBusy = false;
/**
 * The preview's frame grab, on the ONE way out (STC-298, migrated to STC-293).
 *
 * It used to encode a PNG in the canvas and hand it to `clipboard.writeImage`,
 * which was a second encoder and a second clipboard — exactly what STC-293's
 * Note forbids ("no second implementation hiding in the thumbnail"). It now
 * sends composited RGBA through `still:export` like everything else, so it
 * inherits the format choice, the destination folder, the filename template
 * and the multi-representation pasteboard for free.
 *
 * A video frame is opaque and sRGB, so it never meets the flatten fork — the
 * transparency modes are a property of a window capture, not of a recording.
 */
async function withFrame(action: "copy" | "save"): Promise<void> {
  if (!player || frameBusy) return;
  frameBusy = true;
  try {
    const { tNs, rgba, width, height } = await player.captureFrame();
    const settings = (await recorder.getSettings()).still;
    const r = await recorder.exportStill({
      bytes: rgba, width, height, alpha: false, colorSpace: "srgb",
      target: { file: action === "save", clipboard: action === "copy" },
      options: { ...settings, template: frameTemplate(tNs) },
      info: { app: openTakeName, mode: "frame" },
      // Beside the recording, matching what this button did before: a frame
      // grabbed out of a take belongs with the take unless the user has named
      // a stills folder, and `still:export` honours that preference for them.
      ...(openTakeDir ? { dir: openTakeDir } : {}),
    });
    if (!r.ok) throw new Error(r.detail ?? r.code ?? "export failed");
    if (action === "copy") {
      frameStatus(`Copied frame at ${fmtClock(tNs)} (${r.width}×${r.height}`
        + `${r.clipboard?.length ? `, ${r.clipboard.join(" + ")}` : ""})`);
    } else {
      frameStatus(`Saved frame at ${fmtClock(tNs)} → ${r.file?.split("/").pop() ?? ""}`);
    }
  } catch (e: any) {
    alertUser(`Could not ${action} the frame: ${e?.message ?? e}`);
  } finally {
    frameBusy = false;
  }
}
$("copyframe").addEventListener("click", () => void withFrame("copy"));
$("saveframe").addEventListener("click", () => void withFrame("save"));
// ⌘⇧C / ⌘⇧S (Ctrl on other platforms), only while a take is open and the
// keystroke is not inside a text field — the label input must keep its own.
document.addEventListener("keydown", (e) => {
  if (!player || !(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
  if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
  if (e.key === "C" || e.key === "c") { e.preventDefault(); void withFrame("copy"); }
  if (e.key === "S" || e.key === "s") { e.preventDefault(); void withFrame("save"); }
});
$("cancelexport").addEventListener("click", () => exportAbort?.abort());

// ---- still capture preferences ---------------------------------------------
//
// What used to be the still panel (STC-293) is gone: the decorated still
// itself — style picker, redact, copy, save — is the floating thumbnail's own
// compact window now (STC-296, "the whole still UI in v1";
// app/renderer/thumbnail.html, app/src/thumbnail-renderer.ts). What remains
// here is the two things that are genuinely PREFERENCES rather than per-shot
// controls: the destination folder, and where and how long the thumbnail
// shows itself. Both are read through the same `recorder:getSettings` /
// `recorder:setSettings` every other preference in this window uses.

function showDestination(dest: string | null): void {
  $("stilldest").textContent = dest ?? "beside the shot";
}

const thumbCornerSel = $("thumbcorner") as HTMLSelectElement;
const thumbTimeoutInput = $("thumbtimeout") as HTMLInputElement;
const thumbSettleSel = $("thumbsettle") as HTMLSelectElement;
const thumbSkipBox = $("thumbskip") as HTMLInputElement;

async function loadStillPreferences(): Promise<void> {
  const { still, thumbnail } = await recorder.getSettings();
  showDestination(still.destination);
  thumbCornerSel.value = thumbnail.corner;
  thumbTimeoutInput.value = String(Math.round(thumbnail.timeoutMs / 1000));
  thumbSettleSel.value = thumbnail.settleAction;
  thumbSkipBox.checked = thumbnail.skip;
}

/** Every control here changes ONE field; the rest of `thumbnail` is read fresh and kept. */
async function patchThumbnail(patch: Partial<AppSettings["thumbnail"]>): Promise<void> {
  const current = (await recorder.getSettings()).thumbnail;
  await recorder.setSettings({ thumbnail: { ...current, ...patch } });
}

$("stillchoosedest").addEventListener("click", async () => {
  showDestination((await recorder.chooseStillDestination()).destination);
});
$("stillcleardest").addEventListener("click", async () => {
  showDestination((await recorder.clearStillDestination()).destination);
});
thumbCornerSel.addEventListener("change", () => {
  void patchThumbnail({ corner: thumbCornerSel.value as AppSettings["thumbnail"]["corner"] });
});
thumbTimeoutInput.addEventListener("change", () => {
  const seconds = Number(thumbTimeoutInput.value);
  // An out-of-range or unparsable value is left for `readSettings`'s own
  // floor to correct rather than validated twice — the same rule every other
  // preference in this window follows for its own stored validator.
  if (Number.isFinite(seconds)) void patchThumbnail({ timeoutMs: Math.round(seconds * 1000) });
});
thumbSettleSel.addEventListener("change", () => {
  void patchThumbnail({ settleAction: thumbSettleSel.value as AppSettings["thumbnail"]["settleAction"] });
});
thumbSkipBox.addEventListener("change", () => void patchThumbnail({ skip: thumbSkipBox.checked }));

// ---- library -------------------------------------------------------------

/** What the preview needs of a take: enough to name it and find it. */
type Openable = { dir: string; name: string; label?: string };

/** Which kind filter is showing. The adapter validates it; this only remembers it. */
let libraryFilter = "all";

/**
 * The longest edge a cached library thumbnail is rendered at.
 *
 * A thumbnail is a PREVIEW, and downscaling it is fine — the rule that nothing
 * in the still path resamples the capture is about the EXPORT, where a
 * resampled premultiplied edge is the dark fringe the whole still path exists
 * to avoid. Here the alternative is caching a 4K PNG per tile.
 */
const THUMB_MAX_EDGE = 480;

/**
 * Draw one still's decorated result into `img`, and cache it beside the shot.
 *
 * Through the SAME `layoutStill` + `renderStill` the panel and the export use.
 * A second rendering path is what STC-293's Note forbids and would be the
 * quiet way for the grid to show something the export does not produce — the
 * ticket's own wording is that thumbnails render *"the decorated result, not
 * the raw capture, so the grid shows what the user will get"*, which is only
 * true if it is literally the same code.
 */
async function renderThumbnail(item: LibraryItem, img: HTMLImageElement): Promise<void> {
  const shot = await recorder.getShot(item.dir);
  const bytes = await recorder.getFrame(item.dir, shot.frame.file);
  const frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    // The stored decoration, filled in from the mode's presets exactly as the
    // panel does — so a shot never opened since capture still shows what it
    // would export.
    const decorated = { ...shot, decoration: decorationForMode(shot.decoration.mode, shot.decoration) };
    const layout = layoutStill(decorated);
    const fit = Math.min(1, THUMB_MAX_EDGE / Math.max(layout.canvas.width, layout.canvas.height));

    const full = document.createElement("canvas");
    full.width = layout.canvas.width;
    full.height = layout.canvas.height;
    const ctx = full.getContext("2d", {
      alpha: true, colorSpace: colorSpaceFor(shot.display.colorSpace) as never,
    });
    if (!ctx) throw new Error("no 2d context for a thumbnail");
    // Sampled from the FRAME, not the composite: the regions are normalised
    // against the frame, and reading the composite would read pixels a
    // previous fill had already replaced.
    const fills = sampleRedactionFills(frame, shot.frame, decorated.decoration.redactions);
    renderStill(ctx as never, { frame, redactionFills: fills }, layout);

    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(full.width * fit));
    small.height = Math.max(1, Math.round(full.height * fit));
    small.getContext("2d")!.drawImage(full, 0, 0, small.width, small.height);

    const blob = await new Promise<Blob | null>((res) => small.toBlob(res, "image/png"));
    if (!blob) throw new Error("could not encode a thumbnail");
    img.src = URL.createObjectURL(blob);
    // Cached AFTER it is on screen: a failed write costs the cache, never the
    // picture the user is already looking at.
    try { await recorder.writeThumbnail(item.dir, await blob.arrayBuffer()); }
    catch { /* an uncached tile simply renders again next time */ }
  } finally {
    // ~30 MB at 4K, and 500 of them is the tab-killer this repo already
    // documents. Closed on every path, including the failing one.
    frame.close();
  }
}

/** Show a cached thumbnail, decoding it in the main process's stead. */
async function showCachedThumbnail(item: LibraryItem, img: HTMLImageElement,
                                   file: string): Promise<void> {
  const bytes = await recorder.getFrame(item.dir, file);
  img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

const libraryCallbacks: LibraryCallbacks = {
  async act(id, item) {
    try {
      // Dispatch by ACTION, never by kind — the ticket's fourth acceptance
      // criterion. Which actions an item offers was decided by the adapter, so
      // an id that cannot apply to this item never reaches here.
      if (id === "open") await openItem(item);
      else if (id === "duplicate") { await recorder.duplicateStill(item.dir); await refreshTakes(); }
      else if (id === "reveal") await recorder.reveal(item.dir);
      else if (id === "delete") {
        const r = await recorder.deleteTake(item.dir);
        if (r.deleted) {
          if (player && openTakeDir === item.dir) await closePreview();
          await refreshTakes();
        }
      }
    } catch (e: any) { alertUser(String(e?.message ?? e)); }
  },
  async rename(item, label) {
    try { await recorder.labelTake(item.dir, label); await refreshTakes(); }
    catch (e: any) { alertUser(String(e?.message ?? e)); }
  },
  async setFilter(id) { libraryFilter = id; await refreshTakes(); },
  async paintThumbnail(item, img) {
    if (item.thumbnail.source === "file") {
      await showCachedThumbnail(item, img, item.thumbnail.file);
    } else if (item.thumbnail.source === "render") {
      await renderThumbnail(item, img);
    }
  },
};

/**
 * Open whatever this item is.
 *
 * The one place the two kinds' destinations differ, and it is a MAIN-process
 * decision rather than a view's: a recording goes to the in-window player, a
 * still goes back into the post-capture panel with its decoration intact. The
 * view asked for "open" and does not know which happened.
 *
 * Told apart by what the adapter said the item HAS — a still is the thing with
 * a thumbnail to render or cached — rather than by its kind. That reads as a
 * dodge and is not: the criterion is that the presentation layer must not
 * encode kind rules, and "the ones with pictures open in the picture window"
 * is a rule about the interface, which is where it is allowed to live.
 */
async function openItem(item: LibraryItem): Promise<void> {
  if (item.thumbnail.source === "none") {
    await openPreview({ dir: item.dir, name: item.id, label: item.label });
    return;
  }
  await recorder.reopenStill(item.dir);
}

async function refreshTakes(): Promise<void> {
  const list = await recorder.library(libraryFilter);
  libraryFilter = list.filter;
  renderLibrary($("takes"), list, libraryCallbacks);
}


recorder.status().then((s) => {
  setState(s.state);
  if (s.pid) $("pid").textContent = String(s.pid);
  // A helper that could not be spawned at all fails in milliseconds — every
  // restart the supervisor allows has already been used up before this page
  // exists, so the gave-up event above was emitted to nobody. Read the state
  // instead of relying on having been there when it changed.
  if (s.state === "failed") {
    recordBtn.disabled = true;
    alertUser("The recorder keeps failing to start. Restart the app.");
  }
});
refreshTakes();

// ---- capture shortcuts (STC-292) ------------------------------------------
//
// Rebinding, and the one thing the ticket asks for that a silent failure would
// ruin: a shortcut that did not bind must SAY so. The grammar, the reserved
// list and the wording all live in `hotkeys.ts` — this draws the answer and
// records keystrokes, and decides nothing on its own.

const shortcutList = $("shortcuts");
let shortcutState: { shortcuts: Shortcuts; report: ShortcutReport[] } | undefined;
/** Which row is waiting for a keystroke, if any. */
let listening: CaptureAction | undefined;

function reportFor(action: CaptureAction): ShortcutReport | undefined {
  return shortcutState?.report.find((r) => r.action === action);
}

function renderShortcuts(): void {
  shortcutList.replaceChildren();
  for (const action of CAPTURE_ACTIONS) {
    const row = document.createElement("div");
    row.className = "shortcut";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ACTION_LABELS[action];

    const keys = document.createElement("button");
    keys.className = "keys";
    keys.id = `shortcut-${action}`;
    const bound = shortcutState?.shortcuts[action] ?? null;
    keys.textContent = listening === action ? "Press keys…" : formatAccelerator(bound);
    if (listening === action) keys.classList.add("listening");
    keys.addEventListener("click", () => {
      listening = listening === action ? undefined : action;
      renderShortcuts();
    });

    const clear = document.createElement("button");
    clear.className = "clear";
    clear.textContent = "Clear";
    clear.disabled = bound == null;
    clear.addEventListener("click", () => { void applyShortcut(action, null); });

    const why = document.createElement("span");
    why.className = "why";
    why.id = `shortcutwhy-${action}`;
    const r = reportFor(action);
    const message = r ? explainShortcut(r) : undefined;
    if (message) why.textContent = message;
    else if (r?.registered) { why.textContent = "Active"; why.classList.add("ok"); }

    row.append(name, keys, clear, why);
    shortcutList.append(row);
  }
}

async function applyShortcut(action: CaptureAction, accelerator: string | null): Promise<void> {
  listening = undefined;
  try {
    shortcutState = await recorder.setShortcut(action, accelerator);
  } catch (e) {
    alertUser(`Could not set that shortcut: ${String(e)}`);
  }
  renderShortcuts();
}

/**
 * Records the chord.
 *
 * Capture phase and `stopImmediatePropagation` because the preview's own
 * ⌘⇧C / ⌘⇧S bindings are listening on the same document, and a user binding a
 * capture shortcut must not also trigger one. `code` rather than `key`: on
 * macOS ⌥⇧1 arrives as an unrelated glyph, so a layout-independent name is the
 * only one that can be replayed as an accelerator.
 *
 * A press that is only modifiers is not an answer — the chord is still being
 * pressed — so the field keeps waiting rather than binding ⌘ on its own.
 */
document.addEventListener("keydown", (e) => {
  if (!listening) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.code === "Escape") { listening = undefined; renderShortcuts(); return; }
  const accelerator = acceleratorFromKeyStroke({
    code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey,
    altKey: e.altKey, shiftKey: e.shiftKey,
  });
  if (accelerator === null) return;
  const action = listening;
  // Checked here as well as in main so the field can refuse instantly, without
  // a round trip that would briefly show the binding as accepted.
  const parsed = parseAccelerator(accelerator);
  if (!parsed.ok) {
    listening = undefined;
    shortcutState = shortcutState && {
      shortcuts: shortcutState.shortcuts,
      report: shortcutState.report.map((r) => r.action === action
        ? { ...r, accelerator, problem: parsed.problem, registered: false,
            ...(parsed.token ? { token: parsed.token } : {}) }
        : r),
    };
    renderShortcuts();
    return;
  }
  void applyShortcut(action, parsed.accelerator);
}, true);

/**
 * Whether a capture makes a noise.
 *
 * Here rather than only in System Settings because a capture started by a
 * hotkey is the one the sound exists for, and someone who wants it quiet
 * should not have to know that macOS keeps the switch under "Play user
 * interface sound effects". It only ever silences: ticked, the sound still
 * follows the Mac's own setting and alert volume.
 */
const shutterBox = $("shuttersound") as HTMLInputElement;

void (async () => {
  try {
    shutterBox.checked = (await recorder.getSettings()).shutterSound;
  } catch {
    // The default is ON, so a failed read must not present as silence.
    shutterBox.checked = true;
  }
})();

shutterBox.addEventListener("change", async () => {
  try {
    // Show what was actually stored, not what was clicked.
    shutterBox.checked = (await recorder.setSettings({ shutterSound: shutterBox.checked })).shutterSound;
  } catch (e) {
    shutterBox.checked = !shutterBox.checked;
    alertUser(`Could not save the shutter sound setting: ${String(e)}`);
  }
});

($("resetshortcuts") as HTMLButtonElement).addEventListener("click", async () => {
  listening = undefined;
  try {
    shortcutState = await recorder.resetShortcuts();
  } catch (e) {
    alertUser(`Could not restore the default shortcuts: ${String(e)}`);
  }
  renderShortcuts();
});

void (async () => {
  try {
    shortcutState = await recorder.getShortcuts();
  } catch {
    shortcutState = undefined;
  }
  renderShortcuts();
})();

void loadStillPreferences().catch(() => {});
