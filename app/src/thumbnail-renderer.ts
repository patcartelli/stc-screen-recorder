import { parseShot, DECORATION_MODES, type DecorationMode, type Shot } from "@transform/shot";
import { decorationForMode, layoutStill, pxPerPointOf } from "@transform/still-decorate";
import { renderStill } from "@transform/still-render";
import { colorSpaceFor, planRender, stillIsBlocked, type ExportOptions } from "@transform/still-export";

/**
 * The floating thumbnail's view (STC-296). It draws the shot and reports
 * clicks; every DECISION about what the shot means or where it goes is
 * `still-decorate.ts` / `still-export.ts` / `still-io.ts`'s, the same split
 * every other view in this app keeps.
 *
 * ## This is the whole still UI in v1 (the ticket's own words)
 *
 * There is no editor behind this panel until STC-300, so the preset picker
 * here IS how a capture gets decorated. Redact is a stub — STC-297 is a
 * separate, unstarted ticket — and disabled rather than hidden, so its place
 * in the layout is settled now instead of shifting everything once it lands.
 *
 * ## What is deliberately not here
 *
 * True OS drag-out (`NSFilePromiseProvider`), a right-click menu, and
 * multiple captures stacking rather than replacing are follow-up work — see
 * CLAUDE.md. Format, quality and scale are NOT controls here either: they are
 * `still` settings, read once from the stored preference, the same as every
 * other exit out of the app. Only the decoration MODE is a per-shot choice,
 * because the ticket names it as one ("the five output modes as a preset
 * picker") and the other three are not.
 */

declare global {
  interface Window {
    thumb: {
      getFrame(dir: string, name: string): Promise<ArrayBuffer>;
      getSettings(): Promise<{ still: ExportOptions & { destination: string | null } }>;
      exportStill(req: Record<string, unknown>): Promise<{
        ok: boolean; file?: string; bytes?: number; clipboard?: string[];
        code?: string; detail?: string;
      }>;
      reveal(): Promise<boolean>;
      event(ev: { kind: "painted" | "expanded" | "done" }): void;
      onSettle(cb: () => void): () => void;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;
const card = $("card");
const canvas = $("thumbcanvas") as HTMLCanvasElement;
const modeSel = $("mode") as HTMLSelectElement;
const statusEl = $("status");
const copyBtn = $("copy") as HTMLButtonElement;
const saveBtn = $("save") as HTMLButtonElement;
const closeBtn = $("close") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
const dir = params.get("dir") ?? "";
const settleAction = params.get("settleAction") === "copy" ? "copy" : "save";
const shot: Shot = parseShot(JSON.parse(params.get("shot") ?? "null"));
/**
 * The "skip the panel" preference (STC-296): this window is never shown at
 * all, so it composites and exports itself the instant it can rather than
 * waiting on a "painted" round trip through main first — there is nothing to
 * animate or expand into, so nothing to wait for.
 */
const silent = params.get("silent") === "1";

/** How big the collapsed and expanded canvases are allowed to be, in CSS px. */
const COLLAPSED_BOX = { width: 200, height: 118 };
const EXPANDED_BOX = { width: 280, height: 130 };

let frame: ImageBitmap | undefined;
let currentMode: DecorationMode = shot.decoration.mode;
/** The full-resolution composite, kept apart from the (scaled-down) view canvas. */
let composite: HTMLCanvasElement | undefined;
let expanded = false;
let settling = false;
let busy = false;

function setStatus(text: string): void { statusEl.textContent = text; }

/** The modes this SHOT can actually wear — see `renderer.ts`'s identical rule. */
function availableModes(): readonly DecorationMode[] {
  return shot.frame.alpha ? DECORATION_MODES : (["selected-area"] as const);
}

async function draw(): Promise<void> {
  if (!frame) return;
  const decorated: Shot = parseShot({ ...shot, decoration: decorationForMode(currentMode, shot.decoration) });
  const layout = layoutStill(decorated);
  const pxPerPoint = pxPerPointOf(decorated);
  const settings = (await window.thumb.getSettings()).still;
  const plan = planRender(settings, { layout, pxPerPoint });

  const out = document.createElement("canvas");
  out.width = layout.canvas.width;
  out.height = layout.canvas.height;
  const ctx = out.getContext("2d", { alpha: true, colorSpace: colorSpaceFor(shot.display.colorSpace) as never });
  if (!ctx) return;
  renderStill(ctx as never, { frame }, plan.layout);
  composite = out;

  const box = expanded ? EXPANDED_BOX : COLLAPSED_BOX;
  const fit = Math.min(1, box.width / out.width, box.height / out.height);
  canvas.width = Math.max(1, Math.round(out.width * fit));
  canvas.height = Math.max(1, Math.round(out.height * fit));
  const view = canvas.getContext("2d", { alpha: true });
  view?.clearRect(0, 0, canvas.width, canvas.height);
  view?.drawImage(out, 0, 0, canvas.width, canvas.height);
}

/**
 * `settings` read once per export — not cached — so a preference changed in
 * the main window's own settings block between shots is honoured.
 *
 * Only the FORMAT is ever overridden here, and only to keep pixels rather
 * than to fill them: a stored format that cannot carry this mode's
 * transparency (JPEG under `window-only`/`window-shadow`) falls back to PNG
 * rather than flattening onto a guessed colour — this panel has no colour
 * picker, and "keep everything, in a format that can" needs no guess at all.
 */
async function runExport(action: "copy" | "save"): Promise<boolean> {
  if (!composite) return false;
  const settings = (await window.thumb.getSettings()).still;
  let options: ExportOptions = { ...settings };
  const decorated: Shot = parseShot({ ...shot, decoration: decorationForMode(currentMode, shot.decoration) });
  const layout = layoutStill(decorated);
  const pxPerPoint = pxPerPointOf(decorated);
  let plan = planRender(options, { layout, pxPerPoint });
  let fellBackToPng = false;
  if (stillIsBlocked(plan)) {
    options = { ...options, format: "png" };
    plan = planRender(options, { layout, pxPerPoint });
    fellBackToPng = true;
  }

  const ctx = composite.getContext("2d", { alpha: true });
  const data = ctx!.getImageData(0, 0, composite.width, composite.height).data;
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

  const r = await window.thumb.exportStill({
    bytes, width: composite.width, height: composite.height, alpha: plan.alpha,
    colorSpace: shot.display.colorSpace ?? "",
    target: { file: action === "save", clipboard: action === "copy" },
    options,
    info: { ...(decorated.window?.app ? { app: decorated.window.app } : {}),
            ...(decorated.window?.title ? { title: decorated.window.title } : {}),
            mode: currentMode },
    dir,
  });
  if (!r.ok) {
    setStatus(`Could not ${action}: ${r.detail ?? r.code ?? "unknown error"}`);
    return false;
  }
  setStatus((action === "copy" ? "Copied" : `Saved ${r.file?.split("/").pop() ?? ""}`)
    + (fellBackToPng ? " (as PNG — this style needs transparency)" : ""));
  return true;
}

function expand(): void {
  if (expanded) return;
  expanded = true;
  card.classList.add("expanded");
  window.thumb.event({ kind: "expanded" });
  void draw();
}

/** Ends the interaction: exports (per `settleAction`) and tells main to destroy the window. */
async function settle(): Promise<void> {
  if (settling) return;
  settling = true;
  try { await runExport(settleAction); }
  finally { window.thumb.event({ kind: "done" }); }
}

// ---- wiring ----------------------------------------------------------------

card.addEventListener("click", (e) => {
  // Once expanded, the card is a panel with its own controls; only the
  // collapsed thumbnail itself is a single big click target.
  if (!expanded && e.target !== copyBtn && e.target !== saveBtn) expand();
});

for (const m of availableModes()) {
  const opt = document.createElement("option");
  opt.value = m;
  opt.textContent = m.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  modeSel.append(opt);
}
modeSel.value = currentMode;
modeSel.addEventListener("click", (e) => e.stopPropagation());
modeSel.addEventListener("change", () => { currentMode = modeSel.value as DecorationMode; void draw(); });

copyBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (busy) return;
  busy = true;
  setStatus("Copying…");
  await runExport("copy");
  busy = false;
});

saveBtn.addEventListener("click", async (e) => {
  e.stopPropagation();
  if (busy || settling) return;
  busy = true;
  setStatus("Saving…");
  const ok = await runExport("save");
  busy = false;
  // A save is usually the end of the interaction; a copy is not (someone may
  // still want to save afterwards), which is why only this path auto-closes.
  if (ok) { settling = true; window.thumb.event({ kind: "done" }); }
});

closeBtn.addEventListener("click", (e) => { e.stopPropagation(); void settle(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && expanded) void settle();
});

// The timeout fired (or a new capture is about to replace this panel). Main
// has already hidden the window; this finishes the save in the background,
// exactly what "timeout dismissal must never block on a render" requires.
window.thumb.onSettle(() => { void settle(); });

void (async () => {
  const bytes = await window.thumb.getFrame(dir, shot.frame.file);
  frame = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  await draw();
  // A silent panel is never shown, so there is nothing to paint FOR — settle
  // immediately, with no rAF and no round trip through main.
  if (silent) { void settle(); return; }
  // Painted — safe to show without a flash of empty content.
  requestAnimationFrame(() => {
    card.classList.add("in");
    window.thumb.event({ kind: "painted" });
  });
})();
