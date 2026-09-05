/** UI: a record button, live telemetry, and anything that went wrong stated plainly. */
interface Take {
  dir: string; name: string; durationMs: number;
  width: number; height: number; events: number; bytes: number; label?: string;
  camera?: { present: boolean; device?: string; pipStartsAfterMs: number };
}
declare const recorder: {
  getSettings: () => Promise<{ camera: boolean }>;
  setSettings: (p: { camera?: boolean }) => Promise<{ camera: boolean }>;
  status(): Promise<{ state: string; pid?: number }>;
  takes(): Promise<{ takes: Take[]; invalid: { name: string; reason: string }[] }>;
  labelTake(dir: string, label: string): Promise<boolean>;
  deleteTake(dir: string): Promise<{ deleted: boolean }>;
  openPreview(dir: string): Promise<boolean>;
  closePreview(): Promise<void>;
  readTakeFile(name: string): Promise<ArrayBuffer>;
  takeFileSize(name: string): Promise<number>;
  readTakeChunk(name: string, offset: number, length: number): Promise<ArrayBuffer>;
  writeProject(bytes: ArrayBuffer): Promise<boolean>;
  writeExport(name: string, bytes: ArrayBuffer): Promise<string>;
  copyFrame(bytes: ArrayBuffer): Promise<{ width: number; height: number }>;
  captureStill(): Promise<{
    ok: boolean; cancelled?: boolean; dir?: string; kind?: string;
    file?: string; shot?: any; warning?: string; code?: string; detail?: string;
  }>;
  start(): Promise<{ ok: boolean; dir?: string; code?: string; detail?: string }>;
  stop(): Promise<{ ok: boolean; info?: any }>;
  reveal(dir: string): Promise<void>;
  on(event: string, cb: (p: any) => void): () => void;
};

import { loadSession, type LoadedSession } from "@transform/session";
import { PreviewPlayer } from "@transform/preview";
import { exportSession } from "@transform/export";
import type { Project } from "@transform/types";
import {
  parseProject, projectForWrite, exportWindow, estimateExportMs,
  clampTrim, isFullTake, minTrimNs,
} from "@transform/trim";
import { TRANSFORM_VERSION } from "@transform/transform-version";

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
    const r = await recorder.captureStill();
    if (r.cancelled) return;
    if (!r.ok) {
      alertUser(r.code === "no-displays"
        ? "Screen Recording permission is required.\nGrant it in System Settings › Privacy & Security › Screen & System Audio Recording, then try again."
        : r.code === "still-unsupported"
        ? "Still capture needs macOS 14 or newer."
        : `Could not capture: ${r.code}\n${r.detail ?? ""}`);
      return;
    }
    const px = r.shot?.frame ? `${r.shot.frame.width} × ${r.shot.frame.height}` : "";
    stillStatus(`Captured ${r.kind === "window" ? "window" : "region"} ${px} → ${r.dir?.split("/").pop() ?? ""}`);
    if (r.warning) alertUser(r.warning);
    await refreshTakes();
  } catch (e: any) {
    alertUser(`Could not capture: ${e?.message ?? e}`);
  } finally {
    stillBtn.disabled = false;
  }
});

recordBtn.addEventListener("click", async () => {
  recordBtn.disabled = true;
  clearAlert();
  try {
    if (!recording) {
      const r = await recorder.start();
      if (!r.ok) {
        alertUser(r.code === "no-displays"
          ? "Screen Recording permission is required.\nGrant it in System Settings › Privacy & Security › Screen & System Audio Recording, then try again."
          : `Could not start: ${r.code}\n${r.detail ?? ""}`);
        setState("idle");
      } else {
        recording = true;
        // Reset per take, and say "opening…" rather than "—": the camera opens
        // off the critical path, so there IS a window where it is neither
        // absent nor live, and that window is the whole complaint (STC-287).
        setCamera(cameraBox.checked ? "opening…" : "off");
      // The device is opened at start and closed at stop, so the setting must
      // not appear changeable mid-take — it would misdescribe the recording.
      cameraBox.disabled = true;
        currentDir = r.dir;
        recordBtn.textContent = "Stop";
        setState("recording");
      }
    } else {
      await recorder.stop();
      recording = false;
      cameraBox.disabled = false;
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
 * `event-tap-unavailable` is the one that matters most: the captured pixels
 * carry no cursor by design (showsCursor is false, the transform draws it from
 * events.json), so a take recorded without the tap has NO cursor anywhere and
 * looked identical to a good one — the rule that the cursor is never only in
 * the video was being broken silently, and the library's "0 events" was the
 * only trace. `stream-stopped` is a display stream that died mid-take. It used
 * to leave the helper in "recording" with frames simply stopping until Stop
 * was pressed; since STC-306 the helper ends the take itself, so this warning
 * is followed by a `recording-ended` with the same reason.
 */
const RECORDING_FAULTS: Record<string, string> = {
  "event-tap-unavailable":
    "Cursor input is NOT being recorded: the recorder could not install its input tap, " +
    "so this take will have no cursor at all. Grant Input Monitoring in System Settings › " +
    "Privacy & Security, then record again.",
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
  if (INFORMATIONAL_WARNINGS.has(code)) return;
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

async function openPreview(take: Take): Promise<void> {
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

async function openPreviewOrThrow(take: Take): Promise<void> {
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
  $("player").removeAttribute("hidden");
}

async function closePreview(): Promise<void> {
  exportAbort?.abort();
  $("framestatus").setAttribute("hidden", "");
  player?.close();
  player = undefined;
  openSession = undefined;
  openProject = undefined;
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

    const name = `export-${openTakeName}.mp4`;
    await recorder.writeExport(name, result.encoded!.buffer as ArrayBuffer);
    const lastNs = openSession.frames[openSession.frames.length - 1] ?? 0;
    await recorder.writeExport(`export-${openTakeName}.json`, new TextEncoder().encode(JSON.stringify({
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

/** `frame-<take>-<ms>ms.png`: the take it came from and where in it, in the filename. */
function frameFileName(tNs: number): string {
  return `frame-${openTakeName}-${Math.round(tNs / 1e6)}ms.png`;
}

let frameBusy = false;
async function withFrame(action: "copy" | "save"): Promise<void> {
  if (!player || frameBusy) return;
  frameBusy = true;
  try {
    const { tNs, png } = await player.captureFrame();
    if (action === "copy") {
      const { width, height } = await recorder.copyFrame(png);
      frameStatus(`Copied frame at ${fmtClock(tNs)} (${width}×${height})`);
    } else {
      const dest = await recorder.writeExport(frameFileName(tNs), png);
      frameStatus(`Saved frame at ${fmtClock(tNs)} → ${dest.split("/").pop()}`);
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

// ---- library -------------------------------------------------------------

async function refreshTakes(): Promise<void> {
  const { takes, invalid } = await recorder.takes();
  const host = $("takes");
  host.textContent = "";

  if (!takes.length && !invalid.length) {
    const p = document.createElement("div");
    p.id = "empty";
    p.textContent = "No recordings yet.";
    host.append(p);
    return;
  }

  for (const t of takes) {
    const row = document.createElement("div");
    row.className = "take";
    const left = document.createElement("div");
    const title = document.createElement("div");
    // Show the label when there is one, but keep the timestamp visible: it is
    // how the take is identified on disk and in every path the app hands out.
    title.textContent = t.label ? `${t.label}` : t.name;
    title.className = "take-title";
    title.title = t.dir;
    if (t.label) {
      const stamp = document.createElement("span");
      stamp.className = "stamp";
      stamp.textContent = ` ${t.name}`;
      title.append(stamp);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${fmtDuration(t.durationMs)} · ${t.width}×${t.height} · ` +
                       `${t.events} events · ${fmtSize(t.bytes)}`;
    // STC-287. A camera take whose PiP arrives a beat late looks broken, and a
    // camera that recorded NOTHING looked identical to no camera at all. Both
    // are now stated on the take itself, where someone wondering "did the
    // camera work?" is actually looking.
    if (t.camera) {
      const cam = document.createElement("div");
      cam.className = "meta";
      if (!t.camera.present) {
        cam.textContent = "Camera: recorded no frames — this take has no picture-in-picture";
      } else {
        const who = t.camera.device ?? "camera";
        cam.textContent = t.camera.pipStartsAfterMs > 0
          ? `Camera: ${who} · picture-in-picture starts ${(t.camera.pipStartsAfterMs / 1000).toFixed(1)}s in`
          : `Camera: ${who}`;
      }
      left.append(title, meta, cam);
    } else {
      left.append(title, meta);
    }
    const openBtn = document.createElement("button");
    openBtn.textContent = "Preview";
    openBtn.addEventListener("click", () => void openPreview(t));
    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.className = "rename";
    renameBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "labelinput";
      input.value = t.label ?? "";
      input.placeholder = "Name this recording";
      input.maxLength = 120;
      const commit = async () => {
        const v = input.value.trim();
        input.replaceWith(title);
        if (v && v !== t.label) {
          try { await recorder.labelTake(t.dir, v); await refreshTakes(); }
          catch (e: any) { alertUser(String(e?.message ?? e)); }
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") input.replaceWith(title);
      });
      input.addEventListener("blur", () => void commit());
      title.replaceWith(input);
      input.focus();
      input.select();
    });
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "delete";
    delBtn.addEventListener("click", async () => {
      try {
        const r = await recorder.deleteTake(t.dir);
        if (r.deleted) { if (player) await closePreview(); await refreshTakes(); }
      } catch (e: any) { alertUser(String(e?.message ?? e)); }
    });
    const btn = document.createElement("button");
    btn.textContent = "Show";
    btn.addEventListener("click", () => recorder.reveal(t.dir));
    const actions = document.createElement("div");
    actions.append(openBtn, renameBtn, btn, delBtn);
    actions.style.display = "flex";
    actions.style.gap = "6px";
    row.append(left, actions);
    host.append(row);
  }

  // Broken takes are shown, not hidden: a recording that silently disappears
  // from the list is indistinguishable from one that was deleted.
  for (const b of invalid) {
    const row = document.createElement("div");
    row.className = "broken";
    row.textContent = `${b.name} — ${b.reason}`;
    host.append(row);
  }
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
