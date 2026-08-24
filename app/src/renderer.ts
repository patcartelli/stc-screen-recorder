/** UI: a record button, live telemetry, and anything that went wrong stated plainly. */
interface Take {
  dir: string; name: string; durationMs: number;
  width: number; height: number; events: number; bytes: number;
}
declare const recorder: {
  status(): Promise<{ state: string; pid?: number }>;
  takes(): Promise<{ takes: Take[]; invalid: { name: string; reason: string }[] }>;
  start(): Promise<{ ok: boolean; dir?: string; code?: string; detail?: string }>;
  stop(): Promise<{ ok: boolean; info?: any }>;
  reveal(dir: string): Promise<void>;
  on(event: string, cb: (p: any) => void): () => void;
};

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
    title.textContent = t.name;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${fmtDuration(t.durationMs)} · ${t.width}×${t.height} · ` +
                       `${t.events} events · ${fmtSize(t.bytes)}`;
    left.append(title, meta);
    const btn = document.createElement("button");
    btn.textContent = "Show";
    btn.addEventListener("click", () => recorder.reveal(t.dir));
    row.append(left, btn);
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
