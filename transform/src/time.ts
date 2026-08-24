/**
 * Time model (PHASE-1 "Settled by phase 0"):
 * - All times entering the transform are session-relative integer nanoseconds.
 * - Simulation runs at 120 Hz; tick n covers [tickTimeNs(n), tickTimeNs(n+1)).
 * - Integer arithmetic only. t*120 for a 30-minute session is ~2.2e14, safely
 *   inside Number's 2^53 exact-integer range (the schemas keep boot-relative
 *   ns — which is NOT safe — out of the transform entirely).
 */

export const SIM_HZ = 120;
const NS_PER_S = 1_000_000_000;

/** 120 Hz sim tick containing session-relative time tNs. */
export function tickOf(tNs: number): number {
  return Math.floor((tNs * SIM_HZ) / NS_PER_S);
}

/** First session-relative ns belonging to tick n (inverse floor of tickOf). */
export function tickTimeNs(n: number): number {
  return Math.ceil((n * NS_PER_S) / SIM_HZ);
}

/**
 * Frame selection: index of the source frame with the greatest PTS <= tNs;
 * hold, never interpolate. null when no frame exists yet. Same rule in every
 * sink — never "latest decoded frame".
 */
export function frameIndexAt(framesNs: readonly number[], tNs: number): number | null {
  if (framesNs.length === 0 || tNs < framesNs[0]!) return null;
  let lo = 0, hi = framesNs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (framesNs[mid]! <= tNs) lo = mid; else hi = mid - 1;
  }
  return lo;
}
