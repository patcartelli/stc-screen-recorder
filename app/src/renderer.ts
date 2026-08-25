/** UI: a record button, live telemetry, and anything that went wrong stated plainly. */
interface Take {
  dir: string; name: string; durationMs: number;
  width: number; height: number; events: number; bytes: number; label?: string;
}
declare const recorder: {
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

const $ = (id: string) => document.getElementById(id)!;
const recordBtn = $("record") as HTMLButtonElement;
let recording = false;
let currentDir: string | undefined;

function setState(text: string): void { $("state").textContent = text; }
function alertUser(text: string): void { $("alert").textContent = text; $("alert").classList.add("show"); }
function clearAlert(): void { $("alert").classList.remove("show"); }

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
        currentDir = r.dir;
        recordBtn.textContent = "Stop";
        setState("recording");
      }
    } else {
      await recorder.stop();
      recording = false;
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
  $("elapsed").textContent = s.elapsedMs != null ? `${(s.elapsedMs / 1000).toFixed(1)}s` : "—";
});

recorder.on("helper:recording-ended", (i) => {
  // The helper stopped by itself — most often a display change. The file is
  // valid; what would be wrong is leaving the button saying "Stop".
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  refreshTakes();
  alertUser(i.reason === "display-reconfigured"
    ? "Display configuration changed, so the recording was stopped.\nWhat was captured up to that point was saved."
    : `Recording stopped by the recorder (${i.reason}).\nWhat was captured up to that point was saved.`);
  if (i.dir) recorder.reveal(i.dir);
});

recorder.on("helper:recording-lost", (i) => {
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  alertUser(`The recorder quit while recording — that take was not saved.\n${i.dir ?? ""}`);
});

recorder.on("helper:respawned", () => setState("recovered — helper restarted"));
recorder.on("helper:gave-up", () => { recordBtn.disabled = true; alertUser("The recorder keeps failing to start. Restart the app."); });
recorder.on("helper:warning", (l) => { if (l.code === "display-change-during-recording") alertUser("Display configuration changed — the recording was stopped."); });

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
async function readVideo(): Promise<ArrayBuffer> {
  const size = await recorder.takeFileSize("display.mp4");
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += VIDEO_CHUNK_BYTES) {
    const length = Math.min(VIDEO_CHUNK_BYTES, size - offset);
    out.set(new Uint8Array(await recorder.readTakeChunk("display.mp4", offset, length)), offset);
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
  const session = await loadSession({ anchors, events, displayMp4: mp4 });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
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
    left.append(title, meta);
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

recorder.status().then((s) => { setState(s.state); if (s.pid) $("pid").textContent = String(s.pid); });
refreshTakes();
