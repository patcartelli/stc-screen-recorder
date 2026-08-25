/**
 * Puts a bound on a promise settled by someone else's callback.
 *
 * Every media API this project touches — mp4box, VideoDecoder, VideoEncoder,
 * AVAssetWriter, SCStream — signals trouble by simply never calling back. Five
 * separate hangs were traced to that in a single day, each found only after it
 * had already wedged something: a start that cost a flat 10 s, two frame
 * sources parked on healthy decoders, an export stuck at 21 of 300 frames, and
 * a stop the UI could never complete.
 *
 * A promise that never settles is the least debuggable failure available: no
 * error, no stack, no timeout, just a button that does nothing forever. The
 * rule this codebase kept re-learning is that every wait needs a bound and a
 * reason — `what` is the reason, and it goes in the message.
 */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not complete within ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(promise: PromiseLike<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    // Clear on BOTH paths. A timer left armed keeps node — and an Electron
    // renderer — alive long after the work finished.
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },   // real errors pass through unchanged
    );
  });
}
