import {
  parseShot, DECORATION_MODES, type DecorationMode, type Redaction, type Shot,
} from "@transform/shot";
import { decorationForMode, layoutStill, pxPerPointOf } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { normaliseRegion, undoLast } from "@transform/still-redact";
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
 * here IS how a capture gets decorated, and Redact (STC-297) is the only
 * place a capture can be made safe to share at all. Redact mode grows the
 * window rather than opening a second one: the panel is already the surface
 * the shot belongs to, and a still EDITOR is a different ticket.
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
      writeShot(dir: string, redactions: unknown): Promise<{ ok: boolean; redactions: number }>;
      event(ev: { kind: "painted" | "expanded" | "done" } | { kind: "redact"; on: boolean }): void;
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
const redactBtn = $("redact") as HTMLButtonElement;
const undoBtn = $("undo") as HTMLButtonElement;
const doneRedactBtn = $("donedact") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
const dir = params.get("dir") ?? "";
// "none" is the re-opened case (STC-294): close without exporting, because
// the shot is already on disk and a second copy is not what a glance meant.
const settleParam = params.get("settleAction");
const settleAction = settleParam === "copy" ? "copy"
                   : settleParam === "none" ? "none"
                   : "save";
const shot: Shot = parseShot(JSON.parse(params.get("shot") ?? "null"));
/**
 * The "skip the panel" preference (STC-296): this window is never shown at
 * all, so it composites and exports itself the instant it can rather than
 * waiting on a "painted" round trip through main first — there is nothing to
 * animate or expand into, so nothing to wait for.
 */
const silent = params.get("silent") === "1";

/** How big the collapsed, expanded and redacting canvases are allowed to be, in CSS px. */
const COLLAPSED_BOX = { width: 200, height: 118 };
const EXPANDED_BOX = { width: 280, height: 130 };
const REDACT_BOX = { width: 500, height: 300 };

/**
 * The smallest drag that is a region, in VIEW pixels (STC-297).
 *
 * Expressed here rather than in capture pixels because this is the space the
 * person is actually dragging in: four capture pixels of a 4K shot is a
 * fraction of one pixel on screen, and a minimum smaller than the pointer can
 * resolve is not a minimum. Three is enough to tell a drag from a click and
 * small enough to still box a single word.
 */
const MIN_DRAG_VIEW_PX = 3;

let frame: ImageBitmap | undefined;
let currentMode: DecorationMode = shot.decoration.mode;
/** The full-resolution composite, kept apart from the (scaled-down) view canvas. */
let composite: HTMLCanvasElement | undefined;
let expanded = false;
let settling = false;
let busy = false;
/**
 * The regions, seeded from the document rather than from nothing: a shot that
 * already carries redactions (one written by a previous session — STC-297
 * persists them) opens with them, which is what "stays adjustable" needs.
 */
let regions: Redaction[] = [...shot.decoration.redactions];
let redacting = false;
/**
 * Where the capture sits inside the VIEW canvas, in view pixels. Set by every
 * draw, and the only thing that can turn a pointer position into a region:
 * the canvas shows the whole composite (padding, background and all), so the
 * capture is a rect inside it rather than the whole of it.
 */
let contentInView: { x: number; y: number; width: number; height: number } | undefined;
let dragFrom: { x: number; y: number } | undefined;

function setStatus(text: string): void { statusEl.textContent = text; }

/** The modes this SHOT can actually wear — see `renderer.ts`'s identical rule. */
function availableModes(): readonly DecorationMode[] {
  return shot.frame.alpha ? DECORATION_MODES : (["selected-area"] as const);
}

/**
 * The shot as the panel currently describes it: the chosen mode, and whatever
 * regions have been drawn (STC-297).
 *
 * One function because the preview and the export must not be able to differ.
 * They used to build this expression twice, which is exactly the shape of the
 * bug where a redaction shows in the panel and is missing from the file.
 */
function currentShot(): Shot {
  return parseShot({
    ...shot,
    decoration: decorationForMode(currentMode, { ...shot.decoration, redactions: regions }),
  });
}

async function draw(): Promise<void> {
  if (!frame) return;
  const decorated = currentShot();
  const layout = layoutStill(decorated);
  const pxPerPoint = pxPerPointOf(decorated);
  const settings = (await window.thumb.getSettings()).still;
  const plan = planRender(settings, { layout, pxPerPoint });

  const out = document.createElement("canvas");
  // `plan.layout`, not `layout`: `planRender` SCALES the layout for a 1x export
  // of a 2x capture, and sizing the canvas from the unscaled one left the
  // picture drawn into the top-left corner of a canvas twice as big — an
  // export padded with empty space, and (once regions exist) a drag that maps
  // to the wrong pixels. Invisible at the default `native` scale, which is why
  // it survived STC-296.
  out.width = plan.layout.canvas.width;
  out.height = plan.layout.canvas.height;
  const ctx = out.getContext("2d", { alpha: true, colorSpace: colorSpaceFor(shot.display.colorSpace) as never });
  if (!ctx) return;
  // The fills are sampled from the FRAME, not from the composite: the frame is
  // what the regions are normalised against, and reading the composite would
  // mean reading pixels a previous fill had already replaced.
  const redactionFills = sampleRedactionFills(frame, shot.frame, decorated.decoration.redactions);
  renderStill(ctx as never, { frame, redactionFills }, plan.layout);
  composite = out;

  const box = redacting ? REDACT_BOX : expanded ? EXPANDED_BOX : COLLAPSED_BOX;
  const fit = Math.min(1, box.width / out.width, box.height / out.height);
  canvas.width = Math.max(1, Math.round(out.width * fit));
  canvas.height = Math.max(1, Math.round(out.height * fit));
  // The scale the canvas ACTUALLY ended up at, not the one asked for: the
  // rounding above is a fraction of a pixel, and a mapping derived from the
  // request rather than the result is the kind of nearly-right that survives
  // every test and lands a box a pixel off.
  const scale = canvas.width / out.width;
  const c = plan.layout.content;
  contentInView = {
    x: c.x * scale, y: c.y * scale, width: c.width * scale, height: c.height * scale,
  };
  paintView();
}

/**
 * Put the composite on the visible canvas, with the in-progress drag on top.
 *
 * Split from `draw` so a pointermove costs one `drawImage` of an
 * already-rendered canvas rather than a full recomposite — at redact size,
 * recompositing a 4K still per mouse move would make the marquee lag the
 * pointer, which is the one thing a drag interaction cannot do.
 */
function paintView(marquee?: { x: number; y: number; width: number; height: number }): void {
  if (!composite) return;
  const view = canvas.getContext("2d", { alpha: true });
  if (!view) return;
  view.clearRect(0, 0, canvas.width, canvas.height);
  view.drawImage(composite, 0, 0, canvas.width, canvas.height);
  if (!marquee) return;
  view.save();
  view.strokeStyle = "#ffffff";
  view.lineWidth = 1;
  view.setLineDash([4, 3]);
  view.strokeRect(marquee.x + 0.5, marquee.y + 0.5, marquee.width, marquee.height);
  view.restore();
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
  const decorated = currentShot();
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

// ---- redaction (STC-297) ---------------------------------------------------

/**
 * Store the regions on the shot document.
 *
 * Written on every change rather than on the way out, because there is no
 * reliable way out: the panel can be replaced by the next capture or settled
 * by its own timeout, and a redaction the user drew and watched appear must
 * not depend on them then finding the right button. Failures are reported and
 * not thrown — the regions are already in the composite either way, so a
 * failed write costs the ADJUSTABILITY of this shot later, never the fill in
 * the file being exported now.
 */
async function persistRegions(): Promise<void> {
  try {
    await window.thumb.writeShot(dir, regions);
  } catch (e: any) {
    setStatus(`Redacted, but could not store it: ${e?.message ?? e}`);
  }
}

/** Pointer position in VIEW pixels, which is the space the marquee is drawn in. */
function viewPoint(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  // Through the element's CSS size, not its backing size: the canvas is laid
  // out with `max-width`, so the two differ whenever the panel is smaller than
  // the composite wants to be.
  return {
    x: (e.clientX - rect.left) * (canvas.width / (rect.width || 1)),
    y: (e.clientY - rect.top) * (canvas.height / (rect.height || 1)),
  };
}

function setRedacting(on: boolean): void {
  if (redacting === on) return;
  redacting = on;
  dragFrom = undefined;
  card.classList.toggle("redacting", on);
  window.thumb.event({ kind: "redact", on });
  setStatus(on ? "Drag a box over anything private." : "");
  void draw();
}

canvas.addEventListener("pointerdown", (e) => {
  if (!redacting || !contentInView) return;
  e.preventDefault();
  e.stopPropagation();
  dragFrom = viewPoint(e);
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener("pointermove", (e) => {
  if (!redacting || !dragFrom) return;
  const to = viewPoint(e);
  paintView({
    x: Math.min(dragFrom.x, to.x), y: Math.min(dragFrom.y, to.y),
    width: Math.abs(to.x - dragFrom.x), height: Math.abs(to.y - dragFrom.y),
  });
});

canvas.addEventListener("pointerup", (e) => {
  if (!redacting || !dragFrom || !contentInView) return;
  const from = dragFrom;
  dragFrom = undefined;
  const to = viewPoint(e);
  // Both points are made relative to the CAPTURE inside the view, and
  // normalised against it — so padding, a canvas preset and the output scale
  // are all already accounted for, and the region lands on the same pixels
  // whatever the panel happens to be showing.
  const region = normaliseRegion(
    { x: from.x - contentInView.x, y: from.y - contentInView.y },
    { x: to.x - contentInView.x, y: to.y - contentInView.y },
    { width: contentInView.width, height: contentInView.height },
    MIN_DRAG_VIEW_PX,
  );
  if (!region) { paintView(); return; }
  regions = [...regions, region];
  void draw();
  void persistRegions();
  setStatus(`${regions.length} ${regions.length === 1 ? "box" : "boxes"}.`);
});

/** Ends the interaction: exports (per `settleAction`) and tells main to destroy the window. */
async function settle(): Promise<void> {
  if (settling) return;
  settling = true;
  try {
    if (settleAction !== "none") {
      // Waits for the frame to be decoded and drawn — see `ready`. A settle
      // can arrive before any of that has happened (a capture replacing this
      // panel moments after it was created), and exporting nothing because
      // there was nothing composited YET is how a burst quietly loses shots.
      // `ready` rejecting means the frame could not be loaded at all, which is
      // a genuine "nothing to export" rather than a race, so it falls through
      // to `done` exactly as before.
      //
      // Guarded on `composite` rather than awaited unconditionally, and that
      // is load-bearing: the `silent` path calls `settle()` from INSIDE the
      // same IIFE that `ready` is the promise for, so an unconditional await
      // would have it wait on itself forever. By then `draw()` has run, so
      // there is nothing to wait for.
      if (!composite) await ready.catch(() => {});
      await runExport(settleAction);
    }
  } finally { window.thumb.event({ kind: "done" }); }
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

redactBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setRedacting(!redacting);
});

undoBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (regions.length === 0) return;
  regions = undoLast(regions);
  void draw();
  void persistRegions();
  setStatus(regions.length === 0
    ? "No boxes." : `${regions.length} ${regions.length === 1 ? "box" : "boxes"}.`);
});

doneRedactBtn.addEventListener("click", (e) => { e.stopPropagation(); setRedacting(false); });

closeBtn.addEventListener("click", (e) => { e.stopPropagation(); void settle(); });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !expanded) return;
  // Escape backs out of redact mode rather than out of the panel: someone
  // halfway through covering an address reaches for it to cancel the drag,
  // and having that settle-and-close the shot instead would be the panel
  // punishing the most instinctive key on the board.
  if (redacting) { setRedacting(false); return; }
  void settle();
});

// The timeout fired (or a new capture is about to replace this panel). Main
// has already hidden the window; this finishes the save in the background,
// exactly what "timeout dismissal must never block on a render" requires.
window.thumb.onSettle(() => { void settle(); });

/**
 * Resolves once there is something to export.
 *
 * A settle that arrives before the frame has been fetched and decoded used to
 * find `composite` undefined, and `runExport`'s `if (!composite) return false`
 * turned that into a silent no-op: the panel reported "done", main destroyed
 * it, and the capture was never exported. STC-301's gate 4 measured it — five
 * captures in quick succession produced five shots on disk but only THREE
 * export requests and two files. Nothing was destroyed (the take directory is
 * written by the helper before any panel exists) but the user's chosen settle
 * action silently did not happen, which is the quiet half of "nothing is lost
 * by doing nothing".
 *
 * So settle WAITS for this rather than giving up. It is a promise rather than
 * a flag because the wait has to be joinable from the settle path, which can
 * arrive at any point during the load.
 */
const ready: Promise<void> = (async () => {
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
