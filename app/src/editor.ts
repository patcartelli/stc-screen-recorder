/**
 * The editor window (STC-373) — preview, trim, export, legibility and share,
 * split out of the main window's in-page player. The timeline's two lanes
 * (Clip, Zoom) sit over one shared span; Clip stays read-only, Zoom is now
 * editable — tuning a derived window's crop and easing (STC-330), and
 * authoring a window with no derived counterpart at all (STC-331).
 *
 * `editor.ts` inherits `app/src/scrubber.ts`'s vocabulary verbatim — see that
 * module's header for the ten rules a timeline control here is held to.
 */
interface StillSettingsView {
  format: string; quality: number; scale: string;
  stripMetadata: boolean; template: string; destination: string | null;
}
interface AppSettings {
  still: StillSettingsView;
}
declare const editor: {
  openPreview: (dir: string) => Promise<boolean>;
  closePreview: () => Promise<void>;
  readTakeFile: (name: string) => Promise<ArrayBuffer>;
  takeFileSize: (name: string) => Promise<number>;
  readTakeChunk: (name: string, offset: number, length: number) => Promise<ArrayBuffer>;
  writeProject: (bytes: ArrayBuffer) => Promise<boolean>;
  writeExport: (name: string, bytes: ArrayBuffer) => Promise<string>;
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
  getSettings: () => Promise<AppSettings>;
  publish(): Promise<{
    ok: boolean; plan: string; message?: string;
    file?: string; name?: string; replaced?: boolean; snippet?: string;
  }>;
  chooseShareDestination(): Promise<{ destination: string | null }>;
  revealPublished(): Promise<{ ok: boolean; file?: string; message?: string }>;
};

import { loadSession, type LoadedSession } from "@transform/session";
import { PreviewPlayer } from "@transform/preview";
import { exportSession } from "@transform/export";
import type { Project, ZoomOverride } from "@transform/types";
import {
  parseProject, projectForWrite, exportWindow, estimateExportMs,
  clampTrim, isFullTake, minTrimNs,
} from "@transform/trim";
import { outputSizeFor, outputOptions, selectedOption, type OutputOption } from "@transform/output-size";
import type { Size } from "@transform/spaces";
import { render } from "@transform/render";
import {
  DEFAULT_TEXT_PT, EMBED_TARGETS, legibility, legibilitySentence, zoomFactorForCrop,
} from "@transform/legibility";
import { TRANSFORM_VERSION } from "@transform/transform-version";
import { zoomWindows, ZOOM_LEAD_NS, ZOOM_HOLD_NS, type ZoomPreset, type ZoomWindow } from "@transform/zoom";
import { windowId, overrideFor, rectFromGesture } from "@transform/zoom-override";
import type { Rect } from "@transform/spaces";
import {
  clampTrimFrame, decideKey, formatReadout, formatShuttle, frameAtFraction, frameToNs,
  fractionOfFrame, lastFrame, nsToFrame, rubberBandPx, tickStrideFrames, type ScrubAction,
} from "./scrubber.js";
import { exportManifestName, exportMediaName } from "./share.js";
import { clipActivity, zoomCurve } from "./timeline-activity.js";

const $ = (id: string) => document.getElementById(id)!;

function alertUser(text: string): void { $("alert").textContent = text; $("alert").classList.add("show"); }
function clearAlert(): void { $("alert").classList.remove("show"); }

const fmtClock = (ns: number) => {
  const s = Math.max(0, Math.round(ns / 1e9));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtEstimate = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `~${s}s to export`;
  return `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} to export`;
};

// ---- what to open, from the URL the window was loaded with -----------------

const params = new URLSearchParams(location.search);
const takeDir = params.get("dir") ?? "";
const takeName = params.get("name") ?? "";

// ---- state ------------------------------------------------------------------

let player: PreviewPlayer | undefined;
let scrubbing = false;
let openSession: LoadedSession | undefined;
let openProject: Project | undefined;
/** The take's capture size — the aspect every export size is derived from. */
let openCapture: Size | undefined;
/** The take's display geometry — legibility needs its width in POINTS (STC-318). */
let openDisplay: { pointWidth: number } | undefined;
/** The width the demo is shown at, in CSS px. A view setting, never stored on the take. */
let embedWidthPx = EMBED_TARGETS[0]!.widthPx;
let exportAbort: AbortController | undefined;

// ---- the shared [a, b] span the ruler and both lanes render from -----------
//
// Pan lives on the ruler; zoom anchors on the pointer (STC-373). Rather than
// re-deriving every frame<->px conversion for a zoomed, panned view, the span
// is expressed as a CSS transform on #timeline (and the two lane canvases
// beside it) that stretches the FULL-DURATION content so only [spanStart,
// spanEnd] shows in the viewport. `getBoundingClientRect()` reports the
// element's post-transform box, so every existing frame<->px helper in this
// file — written against the untransformed track — keeps working exactly as
// it did in the single in-page player.
let spanStart = 0;
let spanEnd = 0;
const MIN_SPAN_FRACTION = 1 / 64;

function resetSpan(): void {
  spanStart = 0;
  spanEnd = player?.durationNs ?? 0;
}

function applySpanTransform(): void {
  const durationNs = player?.durationNs ?? 0;
  const span = Math.max(1, spanEnd - spanStart);
  const scale = durationNs > 0 ? durationNs / span : 1;
  const translatePct = durationNs > 0 ? -(spanStart / span) * 100 : 0;
  const transform = `scaleX(${scale}) translateX(${translatePct}%)`;
  ($("timeline") as HTMLElement).style.transform = transform;
  ($("clip-canvas-wrap") as HTMLElement).style.transform = transform;
  ($("zoom-canvas-wrap") as HTMLElement).style.transform = transform;
  ($("ruler-content") as HTMLElement).style.transform = transform;
  // STC-331, found fixing this file: editor.html's own comment already
  // claimed "the shared transform on #override-blocks does the pan/zoom",
  // but this function never actually set it here — the CSS rule that makes
  // it a valid transform target was in place since STC-330, the line
  // applying one was not. #zoom-curve (the sibling canvas .zoomblock is
  // meant to overlay) WAS transformed, so any pan or zoom away from the
  // default full view put every block's click target out of registration
  // with the silhouette it is supposed to sit on. This phase's own
  // creation/resize gestures read time from the same transformed box
  // (frameAtClientX), so the misalignment would have reached further than
  // phase 1's read-only blocks ever did.
  ($("override-blocks") as HTMLElement).style.transform = transform;
  updateTicks();
}

/** Pan by a fraction of the CURRENT span (positive moves later in the take). */
function panSpan(deltaFraction: number): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  const span = spanEnd - spanStart;
  let start = spanStart + deltaFraction * span;
  start = Math.max(0, Math.min(durationNs - span, start));
  spanStart = start;
  spanEnd = start + span;
  applySpanTransform();
}

/** Zoom by `factor` (>1 zooms in), anchored so `anchorFraction` (0..1 of the
 *  current span) stays under the pointer. */
function zoomSpan(factor: number, anchorFraction: number): void {
  const durationNs = player?.durationNs ?? 0;
  if (durationNs <= 0) return;
  const span = spanEnd - spanStart;
  const minSpan = durationNs * MIN_SPAN_FRACTION;
  const nextSpan = Math.max(minSpan, Math.min(durationNs, span / factor));
  const anchorNs = spanStart + anchorFraction * span;
  let start = anchorNs - anchorFraction * nextSpan;
  start = Math.max(0, Math.min(durationNs - nextSpan, start));
  spanStart = start;
  spanEnd = start + nextSpan;
  applySpanTransform();
}

let panning = false;
let panLastX = 0;
$("ruler").addEventListener("pointerdown", (e) => {
  panning = true;
  panLastX = (e as PointerEvent).clientX;
  ($("ruler") as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
});
$("ruler").addEventListener("pointermove", (e) => {
  if (!panning) return;
  const r = $("ruler").getBoundingClientRect();
  const dx = (e as PointerEvent).clientX - panLastX;
  panLastX = (e as PointerEvent).clientX;
  if (r.width > 0) panSpan(-dx / r.width);
});
const stopPan = () => { panning = false; };
$("ruler").addEventListener("pointerup", stopPan);
$("ruler").addEventListener("pointercancel", stopPan);
$("ruler").addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = $("ruler").getBoundingClientRect();
  const anchor = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0.5;
  const factor = Math.exp(-e.deltaY * 0.0015);
  zoomSpan(factor, anchor);
}, { passive: false });

// ---- trim UI ----------------------------------------------------------------

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

  // Rule 4: what was cut is DIMMED, not fenced off.
  const head = $("cut-head") as HTMLElement;
  head.style.left = "0%";
  head.style.width = `${Math.max(0, inPct)}%`;
  const tail = $("cut-tail") as HTMLElement;
  tail.style.left = `${outPct}%`;
  tail.style.width = `${Math.max(0, 100 - outPct)}%`;
  updateTicks();

  const w = exportWindow(openProject, player.durationNs);
  const est = fmtEstimate(estimateExportMs(w.maxFrames));
  $("triminfo").textContent = isFullTake(openProject, player.durationNs)
    ? `Full take · ${fmtClock(player.durationNs)} · ${est}`
    : `${fmtClock(w.startNs)}–${fmtClock(w.endNs)} · ${fmtClock(w.endNs - w.startNs)} · ${est}`;
}

/**
 * The export grid on the track (STC-338 rule 9). See renderer.ts's original
 * for the reasoning.
 *
 * STC-378: a freshly created editor `BrowserWindow` is not guaranteed to have
 * given its content view a final layout size by the time `openTakeOrThrow`'s
 * boot sequence reaches this call — reproduced live and reproducibly on CI's
 * macOS runner (`#ticks` stuck `hidden` after the very first take opened in a
 * take), never once under Xvfb here despite repeated local runs, which is
 * presumably why STC-373 didn't catch it: this sandbox's window manager lays
 * a window out immediately on creation. The existing `resize` listener below
 * only self-heals if a genuine LATER resize follows, which an explicitly
 * `width`/`height`-constructed `BrowserWindow` need not ever produce. So a
 * non-positive width is not trusted on the first read: it gets a bounded
 * number of retries on successive animation frames — each one guarantees a
 * real layout/paint has happened since the last — before `#ticks` is
 * believed to have nothing legible to draw. Same family as STC-338's
 * "a measurement that cannot fail loudly will fail quietly and plausibly":
 * the fix there was to measure after a known reveal; there is no single
 * known reveal here, so this measures again rather than trusting one read.
 */
const MAX_TICK_LAYOUT_RETRIES = 5;
let tickLayoutRetriesLeft = MAX_TICK_LAYOUT_RETRIES;
function updateTicks(): void {
  const ticks = $("ticks") as HTMLElement;
  const width = $("timeline").getBoundingClientRect().width;
  if (width <= 0 && player && tickLayoutRetriesLeft > 0) {
    tickLayoutRetriesLeft--;
    requestAnimationFrame(updateTicks);
    return;
  }
  tickLayoutRetriesLeft = MAX_TICK_LAYOUT_RETRIES;
  const stride = player ? tickStrideFrames(player.durationNs, width) : null;
  if (!player || stride === null || width <= 0) {
    ticks.setAttribute("hidden", "");
    return;
  }
  ticks.removeAttribute("hidden");
  ticks.style.setProperty("--tick-px", `${(width / lastFrame(player.durationNs)) * stride}px`);
}

window.addEventListener("resize", () => { if (player) updateTicks(); });

async function persistProject(): Promise<void> {
  if (!openProject || !player) return;
  const doc = projectForWrite(openProject, player.durationNs);
  await editor.writeProject(
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

// ---- the Clip and Zoom lanes (STC-373) --------------------------------------

const LANE_BUCKETS = 480;

function drawClipLane(): void {
  const canvas = $("clip-activity") as HTMLCanvasElement;
  const wrap = $("clip-canvas-wrap") as HTMLElement;
  const w = Math.max(1, Math.round(wrap.getBoundingClientRect().width)) || LANE_BUCKETS;
  const h = 30;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession) return;
  const activity = clipActivity(openSession.events, player.durationNs, LANE_BUCKETS);
  const barW = w / activity.length;
  const style = getComputedStyle(document.documentElement).getPropertyValue("--clip").trim() || "#6a8fd8";
  ctx.fillStyle = style || "#6a8fd8";
  for (let i = 0; i < activity.length; i++) {
    const bh = Math.max(1, activity[i]! * (h - 4));
    ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
  }
}

function drawZoomLane(): void {
  const canvas = $("zoom-curve") as HTMLCanvasElement;
  const wrap = $("zoom-canvas-wrap") as HTMLElement;
  const w = Math.max(1, Math.round(wrap.getBoundingClientRect().width)) || LANE_BUCKETS;
  const h = 22;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  if (!player || !openSession || !openProject) return;
  const curve = zoomCurve(
    (tNs) => render(openProject!, openSession!, tNs).zoom.amount,
    player.durationNs,
    LANE_BUCKETS,
  );
  const style = getComputedStyle(document.documentElement).getPropertyValue("--zoom").trim() || "#d88a3b";
  // STC-330: a FILLED area, not a stroked line — the same sampled curve now
  // reads as one trapezoid per derived window (ease-in ramp, flat top,
  // ease-out ramp), with #override-blocks laying the click targets over it.
  // Nothing about the sampling changed; only how it is drawn.
  ctx.fillStyle = style || "#d88a3b";
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * w;
    // amount is not clamped to [0, 1] (zoom.ts's own note) — draw whatever
    // comes back, clipped to the lane's own height rather than pretending it
    // cannot exceed 1.
    const y = h - Math.max(0, Math.min(1, curve[i]!)) * (h - 2) - 1;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
}

function redrawLanes(): void { drawClipLane(); drawZoomLane(); layoutOverrideBlocks(); }
window.addEventListener("resize", redrawLanes);

// ---- manual zoom override (STC-330/331) — the block lane's editing half ---
//
// Selecting a block puts the preview into an EDIT mode: the player is made
// to draw the UNZOOMED frame for as long as editing lasts (by temporarily
// removing this window's own entry from the LIVE project.overrides it
// reads — PreviewPlayer holds that object by reference and re-reads it on
// every draw, so no second render path is needed), which is what lets a
// pointer pixel on #stage map straight to capture UV with no crop to invert.
// The rect and preset are held in a DRAFT until committed, so entering edit
// mode to just look and then leaving with no drag restores the original
// override exactly rather than deleting it as a side effect.
//
// STC-331 adds a SECOND kind of editing target: a window with no derived
// counterpart at all. `editingWindowId` (a derived window's own identity)
// and `editingManualId` (a manual override's own `id`) are mutually
// exclusive — never both set — and every shared piece of state below
// (draftRect, draftEasing, the rect tool, the preset picker, Done/Remove/
// Escape) works on whichever is currently open. What is NOT shared is
// timing: a manual window carries its own startNs/endNs (draftManualStart/
// End below), since there is no derived window to read them from.

let editingWindowId: string | null = null;
let editingManualId: string | null = null;
let draftRect: Rect | null = null;
let draftEasing: ZoomPreset | "" = "";
let draftManualStart = 0;
let draftManualEnd = 0;
let dragAnchorUv: { x: number; y: number } | null = null;
let resizingManualEdge: "start" | "end" | undefined;

/**
 * The floor under a manually authored window's own duration (STC-331).
 * Reused from stage 1 rather than invented: a window narrower than the
 * time its OWN spring needs just to arrive never finishes arriving, so the
 * lead time is the natural floor rather than an arbitrary pixel or frame
 * count.
 */
const MIN_MANUAL_WINDOW_NS = ZOOM_LEAD_NS;

/** Every manually authored window currently on the LIVE project — never includes the one being edited (see selectManualWindow's own note). */
function manualEntries(): Extract<ZoomOverride, { kind: "manual" }>[] {
  return (openProject?.overrides ?? []).filter((o): o is Extract<ZoomOverride, { kind: "manual" }> => o.kind === "manual");
}

function overridesWithoutWindow(overrides: Project["overrides"], id: string): NonNullable<Project["overrides"]> {
  return (overrides ?? []).filter((o) => !(o.kind === "geometry" && o.windowId === id));
}

function overridesWithoutManual(overrides: Project["overrides"], id: string): NonNullable<Project["overrides"]> {
  return (overrides ?? []).filter((o) => !(o.kind === "manual" && o.id === id));
}

/**
 * A click at `clickNs`, expanded into the locked stage-1 timing shape (300ms
 * lead, 2500ms hold) as a STARTING size — the ticket's own words. Mirrors
 * `zoom.ts`'s own derivation (`startNs = e.t - LEAD`, `endNs = e.t + HOLD`)
 * exactly, treating the click the way a real trigger event would be
 * treated, so the two ways a window can come to exist agree on what "300ms
 * lead, 2500ms hold" means. Independently clamped into [0, duration] rather
 * than clamped-then-shifted, matching `zoomWindows`'s own clamp — a click
 * in the take's first 300ms opens a window that starts at 0, shorter than
 * the shape, exactly as a real trigger there would.
 */
function defaultManualSpan(clickNs: number, durationNs: number): { startNs: number; endNs: number } {
  let startNs = Math.max(0, clickNs - ZOOM_LEAD_NS);
  let endNs = Math.min(durationNs, clickNs + ZOOM_HOLD_NS);
  if (endNs - startNs < MIN_MANUAL_WINDOW_NS) startNs = Math.max(0, endNs - MIN_MANUAL_WINDOW_NS);
  return { startNs, endNs };
}

function aspectWH(): number {
  return openCapture && openCapture.height > 0 ? openCapture.width / openCapture.height : 1;
}

/**
 * Client coordinates → CAPTURE UV. Valid only while editing, because that is
 * the one time #stage is guaranteed to be showing the whole frame at every
 * amount (see the header above) — a canvas pixel otherwise sits inside
 * whatever crop is currently playing, which this does not attempt to invert.
 */
function stageUv(clientX: number, clientY: number): { x: number; y: number } {
  const r = ($("stage") as HTMLCanvasElement).getBoundingClientRect();
  return {
    x: r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0,
    y: r.height > 0 ? Math.max(0, Math.min(1, (clientY - r.top) / r.height)) : 0,
  };
}

function drawOverrideBox(rect: Rect | null): void {
  const box = $("overridebox") as HTMLElement;
  if (!rect) { box.setAttribute("hidden", ""); return; }
  box.removeAttribute("hidden");
  box.style.left = `${rect.x * 100}%`;
  box.style.top = `${rect.y * 100}%`;
  box.style.width = `${rect.width * 100}%`;
  box.style.height = `${rect.height * 100}%`;
}

/** The DYNAMIC blocks only — derived windows and committed manual ones. The
 *  currently-edited manual window (new or existing) is NOT drawn here; it
 *  lives on the static #manualdraft element so its resize handles survive a
 *  rebuild mid-drag (updateManualDraftBlock's own note). */
function layoutOverrideBlocks(): void {
  const container = $("override-blocks-dynamic") as HTMLElement;
  container.replaceChildren();
  if (!player || !openSession) return;
  const d = player.durationNs || 1;
  for (const w of zoomWindows(openSession.events)) {
    const id = windowId(w);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "zoomblock";
    if (id === editingWindowId) btn.classList.add("selected");
    // The window being edited reads its OWN draft, not project.overrides —
    // that field has this window's entry removed for as long as editing
    // lasts (see the header above), so reading it here would show the dot
    // vanishing the instant a block is opened rather than when it is empty.
    const overridden = id === editingWindowId ? !!draftRect : !!overrideFor(openProject?.overrides, w);
    if (overridden) btn.classList.add("overridden");
    btn.style.left = `${(w.startNs / d) * 100}%`;
    btn.style.width = `${Math.max(0, ((w.endNs - w.startNs) / d) * 100)}%`;
    btn.setAttribute("aria-label", `Zoom window at ${fmtClock(w.startNs)}`);
    btn.addEventListener("click", () => {
      const p = id === editingWindowId ? closeOverrideEditor() : selectDerivedWindow(w);
      void p.catch((e: any) => alertUser(String(e?.message ?? e)));
    });
    container.appendChild(btn);
  }
  // Manual windows (STC-331): the one being edited is never in this list —
  // selectManualWindow strips it from project.overrides the same way a
  // derived window's geometry override is stripped, and a brand new one was
  // never in the array to begin with.
  for (const o of manualEntries()) {
    const btn = document.createElement("button");
    btn.type = "button";
    // Always "overridden": a manual window's existence IS its geometry, so
    // there is no un-overridden state for the dot to distinguish.
    btn.className = "zoomblock manual overridden";
    btn.style.left = `${(o.startNs / d) * 100}%`;
    btn.style.width = `${Math.max(0, ((o.endNs - o.startNs) / d) * 100)}%`;
    btn.setAttribute("aria-label", `Manual zoom window at ${fmtClock(o.startNs)}`);
    btn.addEventListener("click", () => {
      void selectManualWindow(o).catch((e: any) => alertUser(String(e?.message ?? e)));
    });
    container.appendChild(btn);
  }
}

/** Writes the current draft into project.overrides (replacing any prior
 *  entry for this window) and persists — an empty draft means "no override". */
async function commitDraft(): Promise<void> {
  if (!openProject || !editingWindowId) return;
  const withoutThis = overridesWithoutWindow(openProject.overrides, editingWindowId);
  openProject.overrides = draftRect
    ? [...withoutThis, {
        kind: "geometry" as const, windowId: editingWindowId, rect: draftRect,
        ...(draftEasing ? { easing: draftEasing } : {}),
      }]
    : withoutThis;
  await persistProject();
}

/**
 * Writes the current manual draft into project.overrides and persists.
 * `easing` is REQUIRED on the schema (types.ts's own note says why), so an
 * unresolved "Project default" picker selection is resolved to the
 * project's CURRENT preset at commit time — a snapshot, not a live link;
 * a manual window has no `undefined` to mean "whatever the project says",
 * unlike a geometry override which does. An empty draft (Remove pressed)
 * deletes the window outright — there is no "no override" state for a
 * manual window to fall back to, since its rect and timing ARE the window.
 */
async function commitManualDraft(): Promise<void> {
  if (!openProject || !editingManualId) return;
  const withoutThis = overridesWithoutManual(openProject.overrides, editingManualId);
  openProject.overrides = draftRect
    ? [...withoutThis, {
        kind: "manual" as const, id: editingManualId, startNs: draftManualStart, endNs: draftManualEnd,
        rect: draftRect, easing: draftEasing || openProject.zoom?.preset || "standard",
      }]
    : withoutThis;
  await persistProject();
}

/**
 * Repositions the static #manualdraft block/handles from draft state, or
 * hides it — called on every resize-drag tick, so it must never touch DOM
 * STRUCTURE (a rebuild mid-drag would drop the pointer capture the handle
 * currently being dragged holds).
 *
 * The `zoomblock` class is applied here, not in the HTML, and cleared
 * while hidden: a `hidden` attribute stops an element being PAINTED, not
 * matched by a class selector, so a `.zoomblock` element sitting `hidden`
 * in the DOM would still count as one to any query that does not also
 * check visibility — which is exactly how `.zoomblock` counts are read in
 * this file's own E2E suite.
 */
function updateManualDraftBlock(): void {
  const el = $("manualdraft") as HTMLElement;
  if (!editingManualId || !player) {
    el.setAttribute("hidden", "");
    el.className = "";
    return;
  }
  el.removeAttribute("hidden");
  el.className = "zoomblock manual selected";
  const d = player.durationNs || 1;
  el.style.left = `${(draftManualStart / d) * 100}%`;
  el.style.width = `${Math.max(0, ((draftManualEnd - draftManualStart) / d) * 100)}%`;
}

/** Shared tail of every way an editor can open: shows the rect tool and
 *  override bar, seeds the preset picker and Remove/Delete button, and
 *  refreshes both block layers. */
function openOverrideEditorUI(): void {
  ($("overridepreset") as HTMLSelectElement).value = draftEasing;
  const clear = $("overrideclear") as HTMLButtonElement;
  clear.disabled = !draftRect;
  clear.textContent = editingManualId ? "Delete window" : "Remove override";
  ($("overridehint") as HTMLElement).textContent = editingManualId
    ? "Drag a rect on the preview to zoom into it · drag the block's edges to change its timing"
    : "Drag a rect on the preview to zoom into it";
  ($("overridebar") as HTMLElement).removeAttribute("hidden");
  ($("rectoverlay") as HTMLElement).removeAttribute("hidden");
  drawOverrideBox(draftRect);
  layoutOverrideBlocks();
  updateManualDraftBlock();
}

async function commitCurrentEdit(): Promise<void> {
  if (editingWindowId) await commitDraft();
  else if (editingManualId) await commitManualDraft();
}

async function closeOverrideEditor(): Promise<void> {
  await commitCurrentEdit();
  editingWindowId = null;
  editingManualId = null;
  draftRect = null;
  draftEasing = "";
  draftManualStart = 0;
  draftManualEnd = 0;
  dragAnchorUv = null;
  resizingManualEdge = undefined;
  ($("overridebar") as HTMLElement).setAttribute("hidden", "");
  ($("rectoverlay") as HTMLElement).setAttribute("hidden", "");
  drawOverrideBox(null);
  layoutOverrideBlocks();
  updateManualDraftBlock();
}

async function selectDerivedWindow(w: ZoomWindow): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit(); // switching straight from one block to another
  const id = windowId(w);
  editingWindowId = id;
  const existing = overrideFor(openProject.overrides, w);
  draftRect = existing?.rect ?? null;
  draftEasing = existing?.easing ?? "";
  openProject.overrides = overridesWithoutWindow(openProject.overrides, id);
  openOverrideEditorUI();
  const mid = Math.min(player.durationNs, Math.round((w.startNs + w.endNs) / 2));
  await player.seek(mid);
}

/** Opens an EXISTING manual window (STC-331) for editing — the block-lane
 *  twin of selectDerivedWindow. Stripping its own entry from the live
 *  project.overrides is what removes it from layoutOverrideBlocks' list
 *  (manualEntries reads that same array), the same trick a geometry
 *  override's removal already relies on for the "editing shows unzoomed"
 *  behaviour. */
async function selectManualWindow(o: Extract<ZoomOverride, { kind: "manual" }>): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit();
  editingManualId = o.id;
  draftManualStart = o.startNs;
  draftManualEnd = o.endNs;
  draftRect = o.rect;
  draftEasing = o.easing;
  openProject.overrides = overridesWithoutManual(openProject.overrides, o.id);
  openOverrideEditorUI();
  const mid = Math.min(player.durationNs, Math.round((o.startNs + o.endNs) / 2));
  await player.seek(mid);
}

/**
 * Creates a brand new manual window (STC-331) — a drag into an empty
 * stretch of the override lane, per the ticket. `clickNs` is where the
 * gesture landed; the WINDOW is always the default stage-1 shape at that
 * point (defaultManualSpan's own note) — a drag does not set a custom
 * duration directly, only resizing the created block's edges afterward
 * does, exactly as the ticket states it ("as a starting size, then
 * resizable"). The rect defaults to the same centred square a bare click
 * on the stage would give a geometry override (rectFromGesture's a === b
 * case), since a manual window's rect is REQUIRED and there is no
 * "nothing yet" state for it to start from.
 */
async function createManualWindow(clickNs: number): Promise<void> {
  if (!player || !openProject) return;
  await commitCurrentEdit();
  const { startNs, endNs } = defaultManualSpan(clickNs, player.durationNs);
  editingManualId = crypto.randomUUID();
  draftManualStart = startNs;
  draftManualEnd = endNs;
  draftRect = rectFromGesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, aspectWH());
  draftEasing = "";
  openOverrideEditorUI();
  const mid = Math.min(player.durationNs, Math.round((startNs + endNs) / 2));
  await player.seek(mid);
}

$("override-blocks").addEventListener("click", (e) => {
  // A block (derived, manual, or the draft block/its handles) owns its own
  // click — this only fires for the lane's empty background, which is the
  // "empty stretch" the ticket means.
  if (e.target !== e.currentTarget || !player) return;
  const clickNs = frameToNs(frameAtClientX((e as MouseEvent).clientX), player.durationNs);
  void createManualWindow(clickNs).catch((err: any) => alertUser(String(err?.message ?? err)));
});

function onManualHandleDown(edge: "start" | "end", e: PointerEvent): void {
  e.preventDefault();
  e.stopPropagation();
  resizingManualEdge = edge;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onManualHandleMove(e: PointerEvent): void {
  if (!resizingManualEdge || !player) return;
  const wanted = frameToNs(frameAtClientX(e.clientX), player.durationNs);
  if (resizingManualEdge === "start") {
    draftManualStart = Math.max(0, Math.min(wanted, draftManualEnd - MIN_MANUAL_WINDOW_NS));
  } else {
    draftManualEnd = Math.min(player.durationNs, Math.max(wanted, draftManualStart + MIN_MANUAL_WINDOW_NS));
  }
  updateManualDraftBlock();
}
function onManualHandleUp(): void { resizingManualEdge = undefined; }
$("manualhandle-start").addEventListener("pointerdown", (e) => onManualHandleDown("start", e as PointerEvent));
$("manualhandle-end").addEventListener("pointerdown", (e) => onManualHandleDown("end", e as PointerEvent));
$("manualhandle-start").addEventListener("pointermove", (e) => onManualHandleMove(e as PointerEvent));
$("manualhandle-end").addEventListener("pointermove", (e) => onManualHandleMove(e as PointerEvent));
$("manualhandle-start").addEventListener("pointerup", onManualHandleUp);
$("manualhandle-end").addEventListener("pointerup", onManualHandleUp);
$("manualhandle-start").addEventListener("pointercancel", onManualHandleUp);
$("manualhandle-end").addEventListener("pointercancel", onManualHandleUp);

$("rectoverlay").addEventListener("pointerdown", (e) => {
  if (!editingWindowId && !editingManualId) return;
  const pe = e as PointerEvent;
  (pe.currentTarget as HTMLElement).setPointerCapture(pe.pointerId);
  dragAnchorUv = stageUv(pe.clientX, pe.clientY);
  // A bare pointerdown with no move is already a valid gesture — the click
  // default (rectFromGesture's own a === b case) — so the box appears
  // immediately rather than waiting for a move that may never come.
  draftRect = rectFromGesture(dragAnchorUv, dragAnchorUv, aspectWH());
  drawOverrideBox(draftRect);
});
$("rectoverlay").addEventListener("pointermove", (e) => {
  if (!dragAnchorUv) return;
  const pe = e as PointerEvent;
  draftRect = rectFromGesture(dragAnchorUv, stageUv(pe.clientX, pe.clientY), aspectWH());
  drawOverrideBox(draftRect);
});
const endOverrideDrag = () => {
  if (!dragAnchorUv) return;
  dragAnchorUv = null;
  ($("overrideclear") as HTMLButtonElement).disabled = !draftRect;
  layoutOverrideBlocks(); // the "overridden" dot follows a fresh drag immediately, not just on Done
};
$("rectoverlay").addEventListener("pointerup", endOverrideDrag);
$("rectoverlay").addEventListener("pointercancel", endOverrideDrag);

$("overridepreset").addEventListener("change", () => {
  draftEasing = ($("overridepreset") as HTMLSelectElement).value as ZoomPreset | "";
});
$("overrideclear").addEventListener("click", () => {
  draftRect = null;
  void closeOverrideEditor().catch((e: any) => alertUser(String(e?.message ?? e)));
});
$("overridedone").addEventListener("click", () => {
  void closeOverrideEditor().catch((e: any) => alertUser(String(e?.message ?? e)));
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || (!editingWindowId && !editingManualId)) return;
  e.preventDefault();
  void closeOverrideEditor().catch((err: any) => alertUser(String(err?.message ?? err)));
});

// ---- export size --------------------------------------------------------

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
  const previous = { ...openProject.output };
  openProject.output.width = opt.size.width;
  openProject.output.height = opt.size.height;

  try {
    await persistProject();
  } catch (e) {
    openProject.output.width = previous.width;
    openProject.output.height = previous.height;
    updateOutputSizeUI();
    throw e;
  }

  updateOutputSizeUI();
  if (player.viewSize) await player.setViewSize(viewSizeForEmbed());
  else await player.outputResized();
  updateLegibilityUI();
}

$("outsize").addEventListener("change", () => {
  if (!openProject || !openCapture) return;
  const id = ($("outsize") as HTMLSelectElement).value;
  const opt = outputOptions(openCapture).find((o) => o.id === id);
  if (!opt || opt.upscales) { updateOutputSizeUI(); return; }
  void setOutputSize(opt).catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- legibility + viewer's eye (STC-318), inside the export dialog ---------

function updateLegibilityUI(): void {
  if (!openProject || !openDisplay || !player || !openSession) return;
  const sel = $("embedtarget") as HTMLSelectElement;
  if (sel.options.length === 0) {
    for (const t of EMBED_TARGETS) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = `${t.label} · ${t.widthPx}px`;
      sel.append(o);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom width";
    sel.append(custom);
  }
  const known = EMBED_TARGETS.find((t) => t.widthPx === embedWidthPx);
  sel.value = known?.id ?? "custom";
  ($("embedwidth") as HTMLInputElement).value = String(embedWidthPx);
  ($("textpt") as HTMLInputElement).value = String(openProject.textPt ?? DEFAULT_TEXT_PT);

  const fs = render(openProject, openSession, player.currentNs);
  const l = legibility(openDisplay, openProject.textPt ?? DEFAULT_TEXT_PT,
                       embedWidthPx, zoomFactorForCrop(fs.zoom.crop.width));
  const out = $("legibility");
  // Warns below 9pt; never blocks (STC-373's own scope line) — the export
  // button beside it stays enabled either way.
  out.textContent = legibilitySentence(l);
  out.classList.toggle("warn", l.verdict === "warn");

  ($("vieweye") as HTMLInputElement).checked = player.viewSize !== null;
}

function viewSizeForEmbed(): Size | null {
  if (!openProject) return null;
  return outputSizeFor(openProject.output, embedWidthPx);
}

function applyStageDisplay(): void {
  const stage = $("stage") as HTMLCanvasElement;
  const view = player?.viewSize ?? null;
  if (view) {
    stage.style.setProperty("--vieweye-w", `${embedWidthPx}px`);
    stage.dataset.vieweye = "";
  } else {
    stage.style.removeProperty("--vieweye-w");
    delete stage.dataset.vieweye;
  }
}

async function setEmbedWidth(px: number): Promise<void> {
  embedWidthPx = Math.max(80, Math.min(4096, Math.round(px)));
  updateLegibilityUI();
  if (player?.viewSize) await player.setViewSize(viewSizeForEmbed());
  applyStageDisplay();
}

$("embedtarget").addEventListener("change", () => {
  const id = ($("embedtarget") as HTMLSelectElement).value;
  const t = EMBED_TARGETS.find((x) => x.id === id);
  if (t) void setEmbedWidth(t.widthPx).catch((e: any) => alertUser(String(e?.message ?? e)));
  else updateLegibilityUI();
});

$("embedwidth").addEventListener("change", () => {
  void setEmbedWidth(Number(($("embedwidth") as HTMLInputElement).value))
    .catch((e: any) => alertUser(String(e?.message ?? e)));
});

$("textpt").addEventListener("change", () => {
  if (!openProject) return;
  const v = Number(($("textpt") as HTMLInputElement).value);
  if (Number.isFinite(v) && v > 0 && v <= 144) openProject.textPt = v;
  updateLegibilityUI();
  void persistProject().catch((e: any) => alertUser(String(e?.message ?? e)));
});

$("vieweye").addEventListener("change", () => {
  if (!player) return;
  const on = ($("vieweye") as HTMLInputElement).checked;
  void player.setViewSize(on ? viewSizeForEmbed() : null)
    .then(() => { applyStageDisplay(); updateLegibilityUI(); })
    .catch((e: any) => alertUser(String(e?.message ?? e)));
});

// ---- the export dialog -------------------------------------------------

const exportDialog = $("exportdialog") as HTMLDialogElement;
$("openexport").addEventListener("click", () => {
  if (!exportDialog.open) exportDialog.showModal();
});
$("closeexport").addEventListener("click", () => exportDialog.close());

// ---- opening and closing the take -------------------------------------

const VIDEO_CHUNK_BYTES = 32 * 1024 * 1024;

async function readVideo(name = "display.mp4"): Promise<ArrayBuffer> {
  const size = await editor.takeFileSize(name);
  const out = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += VIDEO_CHUNK_BYTES) {
    const length = Math.min(VIDEO_CHUNK_BYTES, size - offset);
    out.set(new Uint8Array(await editor.readTakeChunk(name, offset, length)), offset);
  }
  return out.buffer;
}

async function openTakeOrThrow(dir: string): Promise<void> {
  await closeTake();
  await editor.openPreview(dir);

  const dec = new TextDecoder();
  const [anchors, events, mp4, projectRaw] = await Promise.all([
    editor.readTakeFile("anchors.json").then((b) => JSON.parse(dec.decode(b))),
    editor.readTakeFile("events.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => ({ version: 1, events: [] })),
    readVideo(),
    editor.readTakeFile("project.json").then((b) => JSON.parse(dec.decode(b)))
      .catch(() => null),
  ]);
  const cameraMp4 = anchors.files?.camera ? await readVideo(anchors.files.camera) : undefined;
  const session = await loadSession({ anchors, events, displayMp4: mp4, cameraMp4 });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );

  openSession = session;
  openProject = project;
  openCapture = { width: anchors.capture.width, height: anchors.capture.height };
  openDisplay = { pointWidth: anchors.display.pointWidth };
  player = new PreviewPlayer($("stage") as HTMLCanvasElement, session, project);
  const scrub = $("scrub") as HTMLInputElement;
  scrub.max = String(lastFrame(player.durationNs));
  scrub.value = "0";
  player.onTime = (tNs, playing) => {
    const frame = nsToFrame(tNs, player!.durationNs);
    $("clock").textContent = formatReadout(frame, player!.durationNs);
    ($("playpause") as HTMLButtonElement).textContent = playing ? "Pause" : "Play";
    $("shuttle").textContent = formatShuttle(player!.rate);
    if (!scrubbing) scrub.value = String(frame);
  };
  await player.seek(player.firstRenderableNs);
  resetSpan();
  updateTrimUI();
  updateOutputSizeUI();
  updateLegibilityUI();
  applySpanTransform();
  redrawLanes();
}

async function closeTake(): Promise<void> {
  exportAbort?.abort();
  $("framestatus").setAttribute("hidden", "");
  // Not commitDraft()+closeOverrideEditor(): the take (and its project) are
  // going away regardless, and persisting a draft against a project about to
  // be discarded would be a write nobody asked for. Just drop the state.
  editingWindowId = null;
  draftRect = null;
  draftEasing = "";
  dragAnchorUv = null;
  player?.close();
  player = undefined;
  openSession = undefined;
  openProject = undefined;
  openCapture = undefined;
  openDisplay = undefined;
  applyStageDisplay();
  await editor.closePreview();
}

$("playpause").addEventListener("click", () => {
  if (!player) return;
  player.isPlaying ? player.pause() : player.play(1);
  updateShuttleUI();
});
$("closepreview").addEventListener("click", () => window.close());
$("scrub").addEventListener("pointerdown", () => { scrubbing = true; });
$("scrub").addEventListener("pointerup", () => { scrubbing = false; });
$("scrub").addEventListener("pointercancel", () => { scrubbing = false; });
$("scrub").addEventListener("input", () => {
  if (!player) return;
  void player.seek(frameToNs(Number(($("scrub") as HTMLInputElement).value), player.durationNs));
});

// ---- keyboard grammar (STC-338 rule 8) --------------------------------

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return type !== "range" && type !== "checkbox" && type !== "button";
}

const RANGE_NATIVE_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "PageUp", "PageDown", "Home", "End",
]);

window.addEventListener("keydown", (e) => {
  if (!player || !openProject) return;
  if (e.target === $("scrub") && RANGE_NATIVE_KEYS.has(e.key)) e.preventDefault();
  const action = decideKey(
    {
      key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey,
      ctrlKey: e.ctrlKey, altKey: e.altKey,
      inTextField: isTextField(document.activeElement),
    },
    { frame: currentFrame(), durationNs: player.durationNs, rate: player.rate },
  );
  if (!action) return;
  e.preventDefault();
  applyScrubAction(action);
});

function currentFrame(): number {
  return player ? nsToFrame(player.currentNs, player.durationNs) : 0;
}

function applyScrubAction(action: ScrubAction): void {
  if (!player || !openProject) return;
  switch (action.kind) {
    case "seek":
      if (player.rate !== 0) player.pause();
      void player.seek(frameToNs(action.frame, player.durationNs));
      break;
    case "shuttle":
      action.rate === 0 ? player.pause() : player.play(action.rate);
      updateShuttleUI();
      break;
    case "mark": {
      const t = player.currentNs;
      const min = minTrimNs(openProject.output.fps);
      if (action.which === "in") {
        const end = openProject.trim?.endNs ?? player.durationNs;
        setTrim(t, t + min > end ? player.durationNs : end, true);
      } else {
        const start = openProject.trim?.startNs ?? 0;
        setTrim(t < start + min ? 0 : start, t, true);
      }
      break;
    }
  }
}

function updateShuttleUI(): void {
  $("shuttle").textContent = formatShuttle(player?.rate ?? 0);
  ($("playpause") as HTMLButtonElement).textContent = player?.isPlaying ? "Pause" : "Play";
}

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

function frameAtClientX(clientX: number): number {
  const r = $("timeline").getBoundingClientRect();
  const t = r.width <= 0 ? 0 : (clientX - r.left) / r.width;
  return frameAtFraction(t, player?.durationNs ?? 0);
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
  const durationNs = player.durationNs;
  const startFrame = nsToFrame(openProject.trim?.startNs ?? 0, durationNs);
  const endFrame = nsToFrame(openProject.trim?.endNs ?? durationNs, durationNs);
  const wanted = frameAtClientX(e.clientX);
  const opposite = dragging === "in" ? endFrame : startFrame;
  const { clamped, held } = clampTrimFrame(dragging, wanted, opposite, durationNs);

  if (dragging === "in") setTrim(frameToNs(clamped, durationNs), frameToNs(endFrame, durationNs), false);
  else setTrim(frameToNs(startFrame, durationNs), frameToNs(clamped, durationNs), false);

  const handle = $(dragging === "in" ? "trim-in" : "trim-out");
  if (held) {
    const r = $("timeline").getBoundingClientRect();
    const clampedX = r.left + fractionOfFrame(clamped, durationNs) * r.width;
    const excess = dragging === "in" ? e.clientX - clampedX : clampedX - e.clientX;
    const band = rubberBandPx(excess) * (dragging === "in" ? 1 : -1);
    handle.classList.add("held");
    handle.style.marginLeft = `${-5 + band}px`;
  } else {
    handle.classList.remove("held");
    handle.style.marginLeft = "";
  }
}

function onHandleUp(): void {
  if (!dragging) return;
  for (const id of ["trim-in", "trim-out"]) {
    $(id).classList.remove("held");
    $(id).style.marginLeft = "";
  }
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

// ---- export -------------------------------------------------------------

async function runExport(): Promise<void> {
  if (!openSession || !openProject || exportAbort) return;
  player?.pause();
  exportAbort = new AbortController();

  const bar = $("exportbar");
  const progress = $("exportprogress") as HTMLProgressElement;
  const status = $("exportstatus");
  bar.removeAttribute("hidden");
  ($("export") as HTMLButtonElement).disabled = true;
  ($("outsize") as HTMLSelectElement).disabled = true;
  progress.value = 0;
  status.textContent = "Exporting…";
  clearAlert();

  const started = performance.now();
  const exporting: Project = structuredClone(openProject);
  try {
    const result = await exportSession(openSession, exporting, {
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

    const name = exportMediaName(takeName);
    await editor.writeExport(name, result.encoded!.buffer as ArrayBuffer);
    const lastNs = openSession.frames[openSession.frames.length - 1] ?? 0;
    await editor.writeExport(exportManifestName(takeName), new TextEncoder().encode(JSON.stringify({
      version: 1,
      transform: { version: TRANSFORM_VERSION },
      frames: result.frames,
      preEncodeHash: result.hash,
      encodedBytes: result.encodedBytes,
      output: exporting.output,
      trim: projectForWrite(exporting, lastNs).trim ?? null,
      legibility: openDisplay ? (() => {
        const l = legibility(openDisplay!, exporting.textPt ?? DEFAULT_TEXT_PT, embedWidthPx);
        return { textPt: l.textPt, embedWidthPx: l.embedWidthPx, textPx: l.textPx, verdict: l.verdict };
      })() : null,
      exportDurationMs: result.durationMs,
    }, null, 2)).buffer as ArrayBuffer);

    status.textContent = `Done — ${result.frames} frames, ${(result.encodedBytes / 1e6).toFixed(1)} MB`;
  } catch (e: any) {
    status.textContent = "Failed.";
    alertUser(`Export failed: ${e?.message ?? e}`);
  } finally {
    exportAbort = undefined;
    ($("export") as HTMLButtonElement).disabled = false;
    ($("outsize") as HTMLSelectElement).disabled = false;
  }
}

$("export").addEventListener("click", () => void runExport());
$("cancelexport").addEventListener("click", () => exportAbort?.abort());

// ---- share ----------------------------------------------------------------

function shareStatus(text: string): void { $("sharestatus").textContent = text; }

async function publish(): Promise<void> {
  const btn = $("share") as HTMLButtonElement;
  btn.disabled = true;
  shareStatus("Copying…");
  try {
    const r = await editor.publish();
    if (!r.ok) { shareStatus(r.message ?? "Could not share."); return; }
    const verb = r.replaced ? "Replaced" : "Wrote";
    shareStatus(`${verb} ${r.name}. Snippet copied.`);
    if (r.snippet) await navigator.clipboard.writeText(r.snippet).catch(() => {
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
  const { destination } = await editor.chooseShareDestination();
  shareStatus(destination ? `Site folder: ${destination}` : "No site folder chosen.");
})());
$("revealshared").addEventListener("click", () => void (async () => {
  const r = await editor.revealPublished();
  if (!r.ok) shareStatus(r.message ?? "Nothing published yet.");
})());

// ---- the current frame as a still (STC-298/293) ----------------------------

function frameStatus(text: string): void {
  const el = $("framestatus");
  el.textContent = text;
  el.removeAttribute("hidden");
}

function frameTemplate(tNs: number): string {
  return `frame-${takeName}-${Math.round(tNs / 1e6)}ms`;
}

let frameBusy = false;
async function withFrame(action: "copy" | "save"): Promise<void> {
  if (!player || frameBusy) return;
  frameBusy = true;
  try {
    const { tNs, rgba, width, height } = await player.captureFrame();
    const settings = (await editor.getSettings()).still;
    const r = await editor.exportStill({
      bytes: rgba, width, height, alpha: false, colorSpace: "srgb",
      target: { file: action === "save", clipboard: action === "copy" },
      options: { ...settings, template: frameTemplate(tNs) },
      info: { app: takeName, mode: "frame" },
      ...(takeDir ? { dir: takeDir } : {}),
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
document.addEventListener("keydown", (e) => {
  if (!player || !(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
  if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
  if (e.key === "C" || e.key === "c") { e.preventDefault(); void withFrame("copy"); }
  if (e.key === "S" || e.key === "s") { e.preventDefault(); void withFrame("save"); }
});

// ---- boot -------------------------------------------------------------

window.addEventListener("beforeunload", () => { void editor.closePreview(); });

void (async () => {
  if (!takeDir) {
    alertUser("No take was given to open.");
    return;
  }
  try {
    await openTakeOrThrow(takeDir);
  } catch (e: any) {
    alertUser(`Could not open "${takeName || takeDir}".\n${e?.message ?? e}`);
  }
})();
