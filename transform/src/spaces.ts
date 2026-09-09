/**
 * Every coordinate space this recorder has, and who owns each conversion
 * between them (STC-314).
 *
 * The conversions were all correct and all inline, scattered over eight files
 * in two languages. Correct-and-scattered is not a stable state: the ninth
 * site is where two of them start to disagree, and the disagreement is a
 * correctly-rendered wrong answer — a cursor a few pixels off, a redaction
 * that no longer covers what it covered. This module is the one place to get
 * a conversion, and the vocabulary below is the one place the rule is stated.
 *
 * =====================================================================
 * THE TIME AXIS — owned by `time.ts`, named here so the vocabulary is whole
 * =====================================================================
 *
 * **session ns** — integer nanoseconds since the take began. The helper's
 * `t0Ns` is the origin and never enters the transform: everything the
 * transform reads is already relative, which is what keeps the arithmetic
 * inside Number's exact-integer range. This is the ONLY time `render()`
 * accepts.
 *
 * **sim tick** — integer, 120 Hz. Tick `n` covers
 * `[tickTimeNs(n), tickTimeNs(n+1))`. Cursor state is a function of the tick
 * and never of a render call count, which is what makes seeking and stepping
 * produce bit-identical answers. `tickOf` / `tickTimeNs` are an inverse pair:
 * `tickOf(tickTimeNs(n)) === n`.
 *
 * **export frame** — integer `k` at `project.output.fps` (60, every other
 * tick). Frame `k` is rendered at session time `exportFrameTimeNs(k)`;
 * `exportFrameOf` maps back. Also an inverse pair, and the reason a still
 * grabbed off the playhead is pixel-identical to the video's frame at the
 * same timestamp: both snap to this grid.
 *
 * **source frame PTS** — session ns on the capture's VFR grid, recovered by
 * `demux.ts` from the mp4 sample table plus the empty-edit offset (a raw
 * sample table reports every frame early by the gap between "start received"
 * and "first frame arrived"). Selection is `frameIndexAt`: greatest PTS <= t,
 * hold, never interpolate.
 *
 * **clip-relative ns** — an exported clip is its own file and its timeline
 * starts at zero, so the muxer gets `t - exportFrameTimeNs(fromFrame)`.
 * `render()` still receives SESSION time: cursor state depends on where we
 * are in the recording, not where this clip begins. The conversion exists at
 * exactly one place, the `VideoFrame` timestamp in `export.ts`.
 *
 * =====================================================================
 * THE SPACE AXIS — owned here
 * =====================================================================
 *
 * **global points** — macOS desktop points, origin at the top-left of the
 * main display, y down. What `events.json` carries. The helper has already
 * flipped Cocoa's bottom-left origin by the time anything is written, so
 * nothing downstream flips anything.
 *
 * **display-local points** — origin at the captured display's top-left, y
 * down. `global - display.origin`. A cursor on another display maps outside
 * the capture and is clipped, which is correct rather than a bug to clamp.
 *
 * **capture pixels** — the recorded picture. Origin at the top-left of the
 * captured REGION: the whole display for a recording, the crop or the
 * window's bounds for a still. At most 3840x2160 with both dimensions even
 * (the hardware-encode cliff and H.264 4:2:0; `captureSize` in
 * `helper/src/CaptureGeometry.swift` owns that clamp). `pxPerPoint` is the
 * ratio into this space from display-local points.
 *
 * **output pixels** — the exported canvas or the decorated still's canvas,
 * origin top-left. The capture is not necessarily drawn at the canvas origin:
 * a decorated still centres it inside padding, so a capture pixel becomes an
 * output pixel by adding the CONTENT rect's origin.
 *
 * **UV** — normalised 0..1 over a stated reference rect, origin at that
 * rect's top-left. The only space that survives a change of crop, padding or
 * canvas preset, which is why every stored decoration lives in it: a
 * redaction, an annotation and (next) a zoom crop all move with the picture
 * rather than with the canvas, structurally rather than arithmetically.
 *
 * UV is ALWAYS relative to a reference rect, and the rect is the argument.
 * That is the whole trick, and it is why the still path's decorations, the
 * PiP and auto-zoom's crop are one space and not three: what differs between
 * them is only which rect they are normalised over.
 *
 *   - a redaction or an annotation: over the CONTENT rect (the capture, as
 *     drawn)
 *   - a zoom crop: over the capture, saying which part of it to show
 *   - the PiP: over the OUTPUT, saying where the camera lands
 *
 * **view pixels** — a canvas as LAID OUT, which is not its backing size: the
 * still panel's canvas has a CSS `max-width`, so a pointer event has to be
 * scaled by `canvas.width / rect.width` before it means a capture pixel. Owned
 * by `app/src/thumbnail-renderer.ts` (`viewPoint`), because it is the only
 * place a real pointer meets a real element and nothing else can have the
 * numbers. It is named here so that the next thing to grow a canvas knows the
 * space exists and does not discover it as an off-by-a-scale-factor bug.
 *
 * **PiP rect** — a UV rect over the output. Today it is derived from
 * `project.pip`'s fixed-corner fields; see `fixedCornerPipUv`. It is a crop
 * in the same space as zoom rather than a corner in output pixels, so the
 * camera can be moved or resized later by the code that moves the zoom.
 *
 * =====================================================================
 * WHAT THIS MODULE DOES NOT OWN
 * =====================================================================
 *
 * Four conversions live in the helper and cannot import this file. They are
 * named above and their Swift call sites point back here; the rule is stated
 * once, in this header, and implemented where it has to be:
 *
 *   - mach ticks -> ns, `helper/src/CaptureDecisions.swift`. `displayTime`
 *     only: `CGEvent.timestamp` is already nanoseconds. Read the timebase,
 *     never assume it (41.667 ns/tick on Apple silicon, 1/1 on Intel).
 *   - `CMTime` -> ns minus `t0Ns`, `helper/src/CameraCapture.swift`. An exact
 *     rescale; no timebase is involved.
 *   - display points + backing scale -> capture pixels,
 *     `helper/src/CaptureGeometry.swift` (`captureSize`) and
 *     `helper/src/Capture.swift`.
 *   - Cocoa global (bottom-left origin) -> global points (top-left origin),
 *     `helper/src/StillDecisions.swift`. The one flip in the system.
 *
 * One more lives in the app and could not move here without dragging Electron
 * into the transform: `app/src/selection.ts` decides WHICH display a marquee
 * belongs to before converting it, and that decision needs the display list.
 * The conversion itself is `rectToDisplayLocal` below; only the choice of
 * display stays there.
 *
 * A Swift mirror of this module was considered and refused: two
 * implementations of one formula is the defect this file exists to prevent,
 * in a repo that has now fixed four of them.
 */

/** A point in whichever space the parameter says. */
export interface Point { x: number; y: number }

/** A size in whichever space the parameter says. */
export interface Size { width: number; height: number }

/** A rectangle in whichever space the parameter says; origin top-left. */
export interface Rect { x: number; y: number; width: number; height: number }

// ---------------------------------------------------------------------------
// UV <-> pixels, over a stated reference rect
// ---------------------------------------------------------------------------

/**
 * A UV point placed inside `ref`.
 *
 * `ref` is the rectangle the UV was normalised over, in the space you want
 * back — pass the content rect to land in output pixels, the capture's own
 * rect to land in capture pixels. Nothing here clamps: a UV outside 0..1 is
 * a point outside the reference rect, and callers that care (the cursor,
 * which must not be drawn outside the capture) test the result rather than
 * having it silently moved.
 */
export function uvToPixels(p: Point, ref: Rect): Point {
  return { x: ref.x + p.x * ref.width, y: ref.y + p.y * ref.height };
}

/** A UV rectangle placed inside `ref`. Not rounded — see `roundRect`. */
export function uvRectToPixels(r: Rect, ref: Rect): Rect {
  return {
    x: ref.x + r.x * ref.width,
    y: ref.y + r.y * ref.height,
    width: r.width * ref.width,
    height: r.height * ref.height,
  };
}

/**
 * The inverse of `uvToPixels`. Exact to within floating point for any `ref`
 * with positive size; `spaces.test.ts` sweeps the round trip.
 */
export function pixelsToUv(p: Point, ref: Rect): Point {
  return { x: (p.x - ref.x) / ref.width, y: (p.y - ref.y) / ref.height };
}

/** The inverse of `uvRectToPixels`. */
export function pixelsToUvRect(r: Rect, ref: Rect): Rect {
  return {
    x: (r.x - ref.x) / ref.width,
    y: (r.y - ref.y) / ref.height,
    width: r.width / ref.width,
    height: r.height / ref.height,
  };
}

/**
 * A rectangle snapped to whole pixels, each component rounded on its own.
 *
 * Separate from the conversions on purpose: a redaction and an annotation are
 * drawn at sub-pixel positions and must stay there, while anything that
 * places a decoded frame (the PiP) has to land on whole pixels or the frame
 * is resampled across every edge. Rounding inside `uvRectToPixels` would
 * quietly do the second to all of the first.
 *
 * This is the rule for something of a KNOWN SIZE being placed. For a region
 * being selected, see `snapRectEdges` — and read that comment before reaching
 * for either, because the two disagree by a pixel and both are correct for
 * their own job.
 */
export function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x), y: Math.round(r.y),
    width: Math.round(r.width), height: Math.round(r.height),
  };
}

/**
 * A rectangle whose EDGES are snapped to whole pixels; the size follows.
 *
 * The rule for a selected region — a crop, a marquee — because what the user
 * drew is a boundary, and rounding the size instead lets a rounded origin
 * push the far edge off the thing they were framing. `x + width` is preserved
 * to within the rounding; `roundRect` preserves `width` instead.
 *
 * These were two functions with the SAME NAME in two files until STC-314,
 * which is the "one value, two copies" defect inverted and harder to see: the
 * names agreed and the answers did not.
 */
export function snapRectEdges(r: Rect): Rect {
  const x = Math.round(r.x), y = Math.round(r.y);
  return {
    x, y,
    width: Math.round(r.x + r.width) - x,
    height: Math.round(r.y + r.height) - y,
  };
}

/** A global point in display-local points: the same units, the display's origin. */
export function toDisplayLocal(p: Point, displayOrigin: Point): Point {
  return { x: p.x - displayOrigin.x, y: p.y - displayOrigin.y };
}

/** A global rectangle in display-local points. Units are unchanged, so the size is. */
export function rectToDisplayLocal(r: Rect, displayOrigin: Point): Rect {
  const { x, y } = toDisplayLocal(r, displayOrigin);
  return { x, y, width: r.width, height: r.height };
}

// ---------------------------------------------------------------------------
// points -> pixels
// ---------------------------------------------------------------------------

/**
 * Output pixels per display point, read from the picture against the region
 * it came from.
 *
 * Read rather than trusted: a shot's `display.backingScale` describes the
 * display and not necessarily this crop, and the video path's
 * `output.width / display.pointWidth` is this same quantity for a capture
 * that covers the whole display at any export size. Returns `undefined` when
 * the region has no width to divide by, so the caller decides what to fall
 * back to rather than inheriting a silent 1.
 */
export function pxPerPoint(pixelsAcross: number, pointsAcross: number): number | undefined {
  if (!(pointsAcross > 0) || !Number.isFinite(pixelsAcross)) return undefined;
  return pixelsAcross / pointsAcross;
}

/**
 * A display-local point landed in output pixels, for a picture that is a
 * REGION of that display drawn at `contentOrigin`.
 *
 * Three steps, and every one of them has to be there: move into the region's
 * frame (`- regionOrigin`), scale points to pixels (`* pxPerPoint`), then
 * move into the canvas (`+ contentOrigin`). Dropping the first gives a
 * pointer offset by the crop; dropping the last gives one offset by the
 * padding. Both look like a rendering bug rather than a coordinate one.
 */
export function regionPointToPixels(
  p: Point, regionOrigin: Point, scale: number, contentOrigin: Point,
): Point {
  return {
    x: contentOrigin.x + (p.x - regionOrigin.x) * scale,
    y: contentOrigin.y + (p.y - regionOrigin.y) * scale,
  };
}

// ---------------------------------------------------------------------------
// global points -> output pixels (the event space)
// ---------------------------------------------------------------------------

/** The display block `render()` needs: where it sits, and how big it is in points. */
export interface DisplayGeometry {
  originX: number;
  originY: number;
  pointWidth: number;
  pointHeight: number;
}

/**
 * The affine map from global points to output pixels for a capture that
 * covers a whole display.
 *
 * `sx`/`sy` are `pxPerPoint` on each axis — the display-to-output ratio,
 * which is the effective scale at any `backingScale` and at any export size,
 * because the capture always fills the canvas. They are kept apart rather
 * than collapsed to one number: an export whose aspect ratio differs from
 * the display's stretches the picture, and a cursor drawn with a single
 * scale would drift away from the content it is pointing at.
 */
export interface DisplayToOutput { originX: number; originY: number; sx: number; sy: number }

export function displayToOutput(display: DisplayGeometry, output: Size): DisplayToOutput {
  return {
    originX: display.originX,
    originY: display.originY,
    sx: output.width / display.pointWidth,
    sy: output.height / display.pointHeight,
  };
}

/** A global point in output pixels. Translates, then scales. */
export function mapPoint(m: DisplayToOutput, p: Point): Point {
  return { x: (p.x - m.originX) * m.sx, y: (p.y - m.originY) * m.sy };
}

/**
 * A velocity or any other difference of two global points, in output pixels.
 *
 * Scales and does NOT translate, which is the whole reason this is a second
 * function instead of a flag: subtracting the display origin from a velocity
 * gives a number that is wrong by the origin and looks plausible everywhere
 * the origin is (0, 0) — which is every single-display machine, and every
 * fixture in this repo.
 */
export function mapVector(m: DisplayToOutput, v: Point): Point {
  return { x: v.x * m.sx, y: v.y * m.sy };
}

/** The inverse of `mapPoint`: an output pixel back in global points. */
export function unmapPoint(m: DisplayToOutput, p: Point): Point {
  return { x: p.x / m.sx + m.originX, y: p.y / m.sy + m.originY };
}

// ---------------------------------------------------------------------------
// the PiP, as a crop in UV
// ---------------------------------------------------------------------------

/** The `project.pip` fields this needs. Mirrors `Pip` in `types.ts`. */
export interface FixedCornerPip { widthPct: number; marginPx: number }

/**
 * Today's fixed-corner PiP, as a UV rectangle over the output.
 *
 * The PiP is a crop in the same space as zoom (STC-314), not a corner in
 * output pixels — which is what will let the camera be moved or resized by
 * the same code that moves the zoom, instead of by a second implementation
 * of "where does the camera go".
 *
 * It is derived from the PIXEL rule rather than the other way round, and the
 * order matters: the height comes from the ROUNDED width, exactly as it has
 * since phase 3. Normalising the ideal rect and rounding once at the end
 * instead differs by up to a pixel on some camera aspect ratios, and the
 * committed PiP fixture and `gate:identity` pin the current answer.
 * `spaces.test.ts` sweeps output sizes and camera aspects against the
 * original formula.
 *
 * When a PiP rect becomes something a person can author, that stored rect is
 * the source and this becomes the default for documents that predate it —
 * the same shape as every other default in `parseProject`.
 */
export function fixedCornerPipUv(pip: FixedCornerPip, output: Size, camera: Size): Rect {
  const width = Math.round(output.width * pip.widthPct);
  const height = Math.round((width * camera.height) / camera.width);
  return pixelsToUvRect(
    {
      x: output.width - width - pip.marginPx,
      y: output.height - height - pip.marginPx,
      width,
      height,
    },
    { x: 0, y: 0, width: output.width, height: output.height },
  );
}

/** The whole output as a reference rect, for UV that is normalised over it. */
export function outputRect(output: Size): Rect {
  return { x: 0, y: 0, width: output.width, height: output.height };
}
