import {
  parseShot, DECORATION_MODES, type DecorationMode, type Redaction, type Shot,
} from "@transform/shot";
import { decorationForMode, layoutStill, pxPerPointOf } from "@transform/still-decorate";
import { renderStill, sampleRedactionFills } from "@transform/still-render";
import { normaliseRegion, undoLast } from "@transform/still-redact";
import {
  classifyDrag, discardDirection, isDiscardSwipe, parseCorner, swipeOffset,
} from "./thumbnail.js";
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
 * Multiple captures stacking rather than replacing is the one follow-up left
 * — see CLAUDE.md. The right-click menu (`thumbnail-menu.ts`),
 * swipe-to-discard and drag-out have landed. Format, quality and scale are NOT controls here either: they are
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
        /** The user closed the Save As panel without choosing. */
        cancelled?: boolean;
      }>;
      menu(ctx: { redacting: boolean; busy: boolean }): Promise<string | null>;
      revealShot(dir: string): Promise<boolean>;
      deleteShot(dir: string): Promise<{ ok: boolean; detail?: string }>;
      dragFile(req: Record<string, unknown>): Promise<{ ok: boolean; file?: string; detail?: string }>;
      startDrag(file: string): void;
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
/** Which way this panel leaves the screen — see `discardDirection`. */
const corner = parseCorner(params.get("corner"));

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
/**
 * `save-as` is a save that asks first. It is a third ACTION rather than an
 * option on `save`, because the two differ in what the user has already told
 * the app: a plain save has a destination and needs no interaction, and the
 * whole design of this panel is that the silent path stays silent.
 */
type ExportAction = "copy" | "save" | "save-as";

async function runExport(action: ExportAction): Promise<boolean> {
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
    target: {
      file: action !== "copy",
      clipboard: action === "copy",
      // main puts the panel up and keeps the path it gets back; this side only
      // ever says that a choice was wanted (STC-296's right-click menu).
      ...(action === "save-as" ? { saveAs: true } : {}),
    },
    options,
    info: { ...(decorated.window?.app ? { app: decorated.window.app } : {}),
            ...(decorated.window?.title ? { title: decorated.window.title } : {}),
            mode: currentMode },
    dir,
  });
  // Cancelling the save panel is a decision, not a fault. Saying "Could not
  // save as: undefined" to someone who pressed Cancel would be the app
  // reporting their own answer back to them as an error.
  if (r.cancelled) { setStatus(""); return false; }
  if (!r.ok) {
    setStatus(`Could not ${action === "copy" ? "copy" : "save"}: ${r.detail ?? r.code ?? "unknown error"}`);
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
  // The drag file is now wrong in the way that matters most: it still has
  // whatever the box was drawn over legible in it.
  void refreshDragFile();
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
  try { if (settleAction !== "none") await runExport(settleAction); }
  finally { window.thumb.event({ kind: "done" }); }
}

// ---- wiring ----------------------------------------------------------------

card.addEventListener("click", (e) => {
  // A swipe ends with a click event too, and expanding a panel the user has
  // just thrown at the edge of the screen would be the opposite of what they
  // did. `swiped` is cleared on the next pointerdown, not here, because the
  // click arrives after pointerup.
  if (swiped) return;
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
modeSel.addEventListener("change", () => {
  currentMode = modeSel.value as DecorationMode;
  // `draw` first: the file is rendered FROM the composite, so refreshing it
  // before the redraw would write the previous preset.
  void draw().then(refreshDragFile);
});

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

// ---- swipe to discard (STC-296 follow-up) ----------------------------------

/** The gesture in progress, in client pixels. */
let swipeFrom: { x: number; y: number } | undefined;
/**
 * The decorated file a drag would hand over, written AHEAD of the gesture.
 *
 * It has to exist before `startDrag` is called, and the export is not fast
 * enough to happen inside one: measured, the 33 MB RGBA scratch write alone —
 * before any IPC or any encode — is around a quarter of a second, and a drag
 * that began by freezing for that long is not a drag. So it is written in the
 * background while the panel sits there, which is time the app is doing
 * nothing anyway.
 *
 * `undefined` means not ready. A drag that starts before it is REFUSES rather
 * than handing over something else: the acceptance criterion is that a drop
 * produces the decorated file, and an undecorated one would satisfy the
 * gesture while failing the requirement — the worst of the two failures,
 * because it looks like it worked.
 */
let dragFile: string | undefined;
/** Bumped by every change that invalidates the file above. */
let dragGeneration = 0;

/**
 * Write (or rewrite) the file a drag would carry.
 *
 * Every preset change and every redaction makes the previous one wrong, so
 * this runs again on each — and the generation counter is what stops a slow
 * earlier render landing after a fast later one and handing over the shot as
 * it used to look. Redaction makes that concrete: a stale file is one with
 * somebody's address still legible in it.
 */
async function refreshDragFile(): Promise<void> {
  if (!composite) return;
  const mine = ++dragGeneration;
  dragFile = undefined;
  const decorated = currentShot();
  const layout = layoutStill(decorated);
  const plan = planRender({ ...(await window.thumb.getSettings()).still },
                          { layout, pxPerPoint: pxPerPointOf(decorated) });
  const ctx = composite.getContext("2d", { alpha: true });
  const data = ctx!.getImageData(0, 0, composite.width, composite.height).data;
  const r = await window.thumb.dragFile({
    bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    width: composite.width, height: composite.height, alpha: plan.alpha,
    colorSpace: shot.display.colorSpace ?? "",
    options: {},
    info: { ...(decorated.window?.app ? { app: decorated.window.app } : {}),
            ...(decorated.window?.title ? { title: decorated.window.title } : {}),
            mode: currentMode },
  });
  if (mine !== dragGeneration) return;
  if (r.ok && r.file) dragFile = r.file;
}
/**
 * The last gesture threw the shot away.
 *
 * Read by the `click` handler, which fires AFTER `pointerup` — so it is
 * cleared on the next `pointerdown` rather than at the end of the swipe, or
 * the click that concludes a swipe would expand the panel the user has just
 * discarded.
 */
let swiped = false;

card.addEventListener("pointerdown", (e) => {
  swiped = false;
  // Only the collapsed thumbnail swipes. Expanded, the card is a panel of
  // controls and — in redact mode — a drag surface with a completely
  // different meaning, and one drag cannot mean both.
  if (expanded || settling) return;
  swipeFrom = { x: e.clientX, y: e.clientY };
  // Transition off while the card tracks the pointer; back on for the release
  // so both outcomes animate. See `#card.dragging` in thumbnail.html.
  card.classList.add("dragging");
  card.setPointerCapture(e.pointerId);
});

card.addEventListener("pointermove", (e) => {
  if (!swipeFrom) return;
  const dx = e.clientX - swipeFrom.x;
  const dy = e.clientY - swipeFrom.y;
  if (classifyDrag(dx, dy, corner) === "drag-out") {
    // The OS takes the pointer from here, so this gesture is over as far as
    // the panel is concerned — released or dropped, no pointerup will mean
    // anything to us.
    const file = dragFile;
    swipeFrom = undefined;
    card.classList.remove("dragging");
    card.style.transform = "";
    card.style.opacity = "";
    // Not ready yet: say so rather than dragging the wrong picture. See
    // `dragFile`'s note — an undecorated file would look like success.
    if (!file) { setStatus("Still preparing — try again in a moment."); return; }
    swiped = true;
    window.thumb.startDrag(file);
    return;
  }
  const off = swipeOffset(dx, dy, corner);
  // Follows the pointer only outward; a drag the wrong way leaves it put, so
  // "you cannot discard in that direction" needs no explaining.
  card.style.transform = off === 0 ? "" : `translateX(${off * discardDirection(corner)}px)`;
  // Fading as it goes is what makes the threshold legible without a number on
  // screen: by the time it is faint, releasing will throw it away.
  card.style.opacity = off === 0 ? "" : String(Math.max(0.25, 1 - off / 260));
});

card.addEventListener("pointerup", (e) => {
  const from = swipeFrom;
  if (!from) return;
  swipeFrom = undefined;
  card.classList.remove("dragging");
  const dx = e.clientX - from.x;
  const dy = e.clientY - from.y;
  if (!isDiscardSwipe(dx, dy, corner)) {
    // Short of the threshold: back to its corner, and the click that follows
    // is a real click, so it still expands.
    card.style.transform = "";
    card.style.opacity = "";
    return;
  }
  swiped = true;
  void discard();
});

// A cancelled pointer (another window taking it, the panel being hidden for a
// capture) is not a release: put the panel back rather than leaving it
// stranded mid-gesture with no pointerup ever coming.
card.addEventListener("pointercancel", () => {
  if (!swipeFrom) return;
  swipeFrom = undefined;
  card.classList.remove("dragging");
  card.style.transform = "";
  card.style.opacity = "";
});

/**
 * Throw the shot away — the swipe's outcome, and the same thing the
 * right-click Delete does: to the Trash, not `rm`.
 *
 * `settling` FIRST, before anything is awaited, for the same reason Delete
 * does it: the timeout can fire while the trash call is in flight, and a
 * settle that got through would export the shot being discarded.
 */
async function discard(): Promise<void> {
  settling = true;
  card.style.transform = `translateX(${420 * discardDirection(corner)}px)`;
  card.style.opacity = "0";
  const r = await window.thumb.deleteShot(dir);
  if (!r.ok) {
    // Nothing was thrown away, so the panel comes back rather than vanishing
    // and leaving the user to guess whether the shot survived.
    settling = false;
    swiped = false;
    card.style.transform = "";
    card.style.opacity = "";
    setStatus(`Could not discard: ${r.detail ?? "unknown error"}`);
    return;
  }
  window.thumb.event({ kind: "done" });
}

/**
 * The right-click menu (STC-296's follow-up).
 *
 * The menu is built and popped up by MAIN — `thumbnail-menu.ts` decides its
 * contents, `main.ts` turns them into a real `Menu`. This side reports the
 * gesture and performs whichever id comes back, so the five actions are the
 * same code paths the panel's own buttons use rather than a second set that
 * could drift from them.
 *
 * Available collapsed as well as expanded: the ticket puts the menu on the
 * thumbnail, and a shot whose panel has not been clicked yet is exactly when
 * "copy it and get on with what I was doing" is worth most.
 */
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void (async () => {
    const id = await window.thumb.menu({ redacting, busy });
    if (id === null) return;
    if (id === "copy" || id === "save-as") {
      if (busy) return;
      busy = true;
      setStatus(id === "copy" ? "Copying…" : "Saving…");
      const ok = await runExport(id);
      busy = false;
      // Same rule the Save button follows: a save ends the interaction, a copy
      // does not. Cancelling the panel returns false, so it correctly does not
      // close either.
      if (ok && id === "save-as") { settling = true; window.thumb.event({ kind: "done" }); }
      return;
    }
    if (id === "redact") { expand(); setRedacting(!redacting); return; }
    if (id === "reveal") {
      // The shot's own directory, not `still:reveal`'s last SAVED file: a panel
      // that has not been settled yet has never saved anything, and revealing
      // some earlier shot instead would be worse than doing nothing.
      if (!await window.thumb.revealShot(dir)) setStatus("Nothing to show yet.");
      return;
    }
    // The same `discard()` the swipe uses. Two ways to throw a shot away that
    // disagreed about where it went would be the defect, not the second
    // gesture, and the cheapest way for them not to disagree is one function.
    if (id === "delete") await discard();
  })();
});

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
  // Only NOW, and deliberately not awaited: the panel is on screen and idle
  // for its whole timeout, so the export that a drag would otherwise have to
  // wait for happens in time nobody is using. Nothing downstream waits on it
  // — a drag that beats it is refused rather than served the wrong file.
  void refreshDragFile();
})();
