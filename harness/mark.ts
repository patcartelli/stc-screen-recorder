/**
 * Progress checkpoints for the DRIVER, not for the page.
 *
 * STC-259 Mode B is a blocked renderer main thread: no timer fires, no promise
 * settles, `page.evaluate` never returns, and `browser.close()` then hangs its
 * whole teardown. Every in-page bound in this repo is a JS timer and is
 * therefore dead in exactly the situation it was written for, which is why
 * these runs historically produced no output at all.
 *
 * `console.log` is the one channel that survives. A console message crosses to
 * the driver over CDP AS IT IS MADE, so a mark placed immediately before a
 * synchronous call is already out of the process when that call wedges — and
 * the last mark received names the call. Nothing stored in a variable, on
 * `window`, or in the DOM can be read afterwards, because reading it would need
 * the very thread that is stuck.
 *
 * Put a mark before each SYNCHRONOUS candidate. In this repo those are
 * `VideoDecoder.configure()`, `VideoEncoder.configure()` and `getImageData()`:
 * calls that can block on a contended paravirtualized codec or a stalled GPU
 * process. Marking async boundaries costs a line and tells you little — the
 * event loop was alive there by definition.
 *
 * Collected by `attachCheckpointTrail` in scripts/gate-bounds.mjs, which prints
 * the trail only when a bound fires.
 */

let seq = 0;

export function mark(what: string): void {
  console.log(`[gate-mark ${++seq}] ${what}`);
  maybeWedge(what);
}

/**
 * Blocks this thread on demand so the diagnosis can be watched working — a
 * diagnostic nobody has seen produce output is indistinguishable from one that
 * cannot, which is the standing rule for every bound in this repo.
 *
 * A busy loop, deliberately, not a long `await`: it has to starve timers and
 * microtasks the way the real fault does. An `await` would leave the event loop
 * turning, every in-page bound would fire normally, and the injection would
 * prove nothing about Mode B.
 *
 * `__wedgeAt` is set by the driver through `addInitScript` and is never present
 * in a real run.
 */
function maybeWedge(at: string): void {
  if ((globalThis as { __wedgeAt?: string }).__wedgeAt !== at) return;
  console.log(`[gate-mark ${++seq}] FAULT INJECTED: blocking the main thread at ${at}`);
  const until = performance.now() + 600_000;
  while (performance.now() < until) { /* starve everything, on purpose */ }
}
