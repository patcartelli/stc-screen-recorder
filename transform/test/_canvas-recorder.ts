import type { CursorCanvas } from "../src/cursor-art.js";

/**
 * A stand-in for a 2D context that records every call and property write, in
 * order. Node has no canvas; what the transform tests can pin is the sequence
 * of drawing operations and the numbers handed to them. Pixels are the browser
 * gates' job.
 */
export function recorder(): { ctx: CursorCanvas; ops: string[] } {
  const ops: string[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(_t, prop: string) {
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        ops.push(`${prop}(${args.map(String).join(",")})`);
        // A gradient is the one thing a caller does something WITH rather than
        // just calls: it collects colour stops and is then assigned to
        // fillStyle. Handing back undefined would crash the caller instead of
        // recording it, so the stub records its stops too.
        if (/^create\w*Gradient$/.test(prop)) {
          return {
            addColorStop(offset: number, color: string) {
              ops.push(`addColorStop(${offset},${color})`);
            },
            toString() { return `<${prop}>`; },
          };
        }
        return undefined;
      };
    },
    set(_t, prop: string, value) {
      target[prop] = value;
      ops.push(`${prop}=${String(value)}`);
      return true;
    },
  }) as unknown as CursorCanvas;
  return { ctx, ops };
}

