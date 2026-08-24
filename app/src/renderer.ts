/** UI: a record button, live telemetry, and anything that went wrong stated plainly. */
declare const recorder: {
  status(): Promise<{ state: string; pid?: number }>;
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
      if (currentDir) await recorder.reveal(currentDir);
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

recorder.on("helper:recording-lost", (i) => {
  recording = false;
  recordBtn.textContent = "Record";
  setState("idle");
  alertUser(`The recorder quit while recording — that take was not saved.\n${i.dir ?? ""}`);
});

recorder.on("helper:respawned", () => setState("recovered — helper restarted"));
recorder.on("helper:gave-up", () => { recordBtn.disabled = true; alertUser("The recorder keeps failing to start. Restart the app."); });
recorder.on("helper:warning", (l) => { if (l.code === "display-change-during-recording") alertUser("Display configuration changed — the recording was stopped."); });

recorder.status().then((s) => { setState(s.state); if (s.pid) $("pid").textContent = String(s.pid); });
