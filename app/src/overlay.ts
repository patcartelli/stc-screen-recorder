import type {
  DisplayInfo, Handle, Point, Rect, SelectionOutcome, SelectionState, WindowInfo,
} from "./selection.js";
import { pixelSize, rectContains } from "./selection.js";

/**
 * The overlay's view (STC-290). It draws state and reports input; it decides
 * nothing.
 *
 * Every gesture is sent to the main process as a GLOBAL point and comes back as
 * a state to draw, so the marquee is the same object on every display and a
 * drag can cross a bezel. The one thing this file is allowed to work out for
 * itself is hit-testing — whether a press landed on a resize handle, inside the
 * marquee, or on bare desktop — because that is a question about what is on
 * screen, which is exactly what a view knows and the reducer does not.
 */

declare global {
  interface Window {
    overlay: {
      send(event: unknown): void;
      onState(cb: (payload: OverlayPayload) => void): () => void;
    };
  }
}

interface OverlayPayload {
  display?: DisplayInfo;
  displays: DisplayInfo[];
  windows: WindowInfo[];
  state: SelectionState;
  /** What would be captured right now, so the readout can show the truth. */
  preview?: SelectionOutcome;
}

const $ = (id: string) => document.getElementById(id)!;
const marquee = $("marquee"), highlight = $("highlight");
const sizeChip = $("size"), titleChip = $("title"), legend = $("legend");

/** Where this window's display sits in the global space. Set on first state. */
let origin: Point = { x: 0, y: 0 };
let current: OverlayPayload | undefined;
const handles = new Map<Handle, HTMLElement>();

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** How near a handle a press has to land. Generous: these are small targets. */
const HANDLE_GRAB_PADDING = 8;

for (const h of HANDLES) {
  const el = document.createElement("div");
  el.className = `handle ${h}`;
  el.style.display = "none";
  document.body.appendChild(el);
  handles.set(h, el);
}

const toGlobal = (e: { clientX: number; clientY: number }): Point =>
  ({ x: origin.x + e.clientX, y: origin.y + e.clientY });
const toLocal = (r: Rect): Rect =>
  ({ x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height });

const send = (event: unknown) => window.overlay.send(event);
const mods = (e: PointerEvent | KeyboardEvent) => ({ shift: e.shiftKey, alt: e.altKey });

/** Handle positions for a marquee, in this window's own coordinates. */
function handlePoint(r: Rect, h: Handle): Point {
  const midX = r.x + r.width / 2, midY = r.y + r.height / 2;
  const right = r.x + r.width, bottom = r.y + r.height;
  switch (h) {
    case "nw": return { x: r.x, y: r.y };
    case "n": return { x: midX, y: r.y };
    case "ne": return { x: right, y: r.y };
    case "e": return { x: right, y: midY };
    case "se": return { x: right, y: bottom };
    case "s": return { x: midX, y: bottom };
    case "sw": return { x: r.x, y: bottom };
    case "w": return { x: r.x, y: midY };
  }
}

/**
 * Which handle a press is grabbing, if any. Nearest wins rather than first, so
 * the corners keep their own targets where two hit boxes overlap on a marquee
 * small enough for that to happen.
 */
function handleAt(local: Rect, p: Point): Handle | undefined {
  let best: Handle | undefined;
  let bestDist = HANDLE_GRAB_PADDING;
  for (const h of HANDLES) {
    const c = handlePoint(local, h);
    const d = Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y));
    if (d <= bestDist) { best = h; bestDist = d; }
  }
  return best;
}

function place(el: HTMLElement, r: Rect): void {
  el.style.left = `${r.x}px`;
  el.style.top = `${r.y}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.display = "block";
}

/**
 * Keep a chip on screen. A readout that runs off the edge of the display is
 * the one case where the number the user is trying to read is the number they
 * cannot see, so it flips to the inside near an edge rather than being clipped.
 */
function placeChip(el: HTMLElement, x: number, y: number, below: boolean): void {
  el.style.display = "block";
  const w = el.offsetWidth, h = el.offsetHeight;
  const margin = 8;
  let left = x, top = below ? y + margin : y - h - margin;
  if (top < margin) top = y + margin;
  if (top + h > window.innerHeight - margin) top = Math.max(margin, y - h - margin);
  left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function hide(...els: HTMLElement[]): void {
  for (const el of els) el.style.display = "none";
}

function renderLegend(mode: string): void {
  legend.innerHTML = mode === "window"
    ? `<kbd>Click</kbd> capture window <span class="sep">·</span>` +
      `<kbd>Space</kbd> region <span class="sep">·</span><kbd>Esc</kbd> cancel`
    : `<kbd>Drag</kbd> region <span class="sep">·</span>` +
      `<kbd>Space</kbd> window <span class="sep">·</span>` +
      `<kbd>↵</kbd> capture <span class="sep">·</span><kbd>Esc</kbd> cancel`;
  legend.style.bottom = "48px";
  legend.style.display = "block";
}

function render(p: OverlayPayload): void {
  current = p;
  if (p.display) origin = { x: p.display.bounds.x, y: p.display.bounds.y };
  const { state } = p;
  document.body.classList.toggle("window-mode", state.mode === "window");
  document.body.classList.toggle("has-selection", state.rect !== undefined);
  renderLegend(state.mode);

  if (state.mode === "window") {
    hide(marquee, sizeChip, ...handles.values());
    const w = p.windows.find((x) => x.id === state.hoveredWindowId);
    if (!w) { hide(highlight, titleChip); return; }
    const local = toLocal(w.bounds);
    place(highlight, local);
    const display = p.displays.find((d) => rectContains(d.bounds, {
      x: w.bounds.x + w.bounds.width / 2, y: w.bounds.y + w.bounds.height / 2,
    }));
    const px = pixelSize(w.bounds, display);
    const name = [w.app, w.title].filter(Boolean).join(" — ") || "Window";
    titleChip.textContent = `${name}   ${px.width} × ${px.height}`;
    placeChip(titleChip, local.x, local.y, false);
    return;
  }

  hide(highlight, titleChip);
  if (!state.rect) { hide(marquee, sizeChip, ...handles.values()); return; }

  const local = toLocal(state.rect);
  place(marquee, local);
  for (const h of HANDLES) {
    const el = handles.get(h)!;
    // Handles only while the gesture is over: they are for adjusting a
    // finished marquee, and drawing them mid-drag puts eight squares under the
    // pointer at exactly the moment the user is watching the edge.
    if (state.drag) { el.style.display = "none"; continue; }
    const c = handlePoint(local, h);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.display = "block";
  }

  // The readout names what would actually be captured, which after clipping to
  // one display is not always what was drawn — see `dominantDisplay`.
  const preview = p.preview;
  if (preview && preview.kind === "region") {
    const display = p.displays.find((d) => d.id === preview.displayId);
    const px = pixelSize(preview.crop, display);
    const clipped = preview.global.width !== state.rect.width
                 || preview.global.height !== state.rect.height;
    sizeChip.textContent = `${px.width} × ${px.height}${clipped ? "  (clipped to one display)" : ""}`;
    placeChip(sizeChip, local.x, local.y + local.height, true);
  } else {
    hide(sizeChip);
  }
}

// ── input ───────────────────────────────────────────────────────────────────

window.addEventListener("pointerdown", (e) => {
  const state = current?.state;
  const at = toGlobal(e);
  let handle: Handle | undefined;
  let onMarquee = false;
  if (state?.mode === "region" && state.rect) {
    const local = toLocal(state.rect);
    const p = { x: e.clientX, y: e.clientY };
    handle = handleAt(local, p);
    if (!handle) onMarquee = rectContains(local, p);
  }
  // Capture the pointer so a drag that leaves this display keeps arriving
  // here — the coordinates simply go outside the window, which converts to a
  // global point perfectly well. Without it the gesture would die at the bezel.
  try { (e.target as Element)?.setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }
  send({ t: "pointerdown", at, mods: mods(e), handle, onMarquee });
});

window.addEventListener("pointermove", (e) => {
  send({ t: "pointermove", at: toGlobal(e), mods: mods(e) });
});

window.addEventListener("pointerup", (e) => {
  try { (e.target as Element)?.releasePointerCapture?.(e.pointerId); } catch { /* not fatal */ }
  send({ t: "pointerup", at: toGlobal(e), mods: mods(e) });
});

window.addEventListener("keydown", (e) => {
  // Space and the arrows both scroll a document by default, and Escape can be
  // swallowed; the overlay wants all of them verbatim.
  if ([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape", "Enter"].includes(e.key)) {
    e.preventDefault();
  }
  send({ t: "key", key: e.key, mods: mods(e) });
});

// A modifier pressed or released mid-drag changes the marquee without the
// pointer moving — Shift squaring a drag that has stopped, say. Replaying the
// last position keeps the picture honest.
for (const type of ["keydown", "keyup"] as const) {
  window.addEventListener(type, (e) => {
    if (e.key !== "Shift" && e.key !== "Alt") return;
    const p = current?.state.pointer;
    if (!p || !current?.state.drag) return;
    send({ t: "pointermove", at: p, mods: { shift: e.shiftKey, alt: e.altKey } });
  });
}

window.overlay.onState(render);
