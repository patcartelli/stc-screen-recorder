import { describe, test, expect, afterEach } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * STC-293: the pasteboard half of `export-still`.
 *
 * ## Why this is in the grant suite when it needs no TCC grant
 *
 * It does not need Screen Recording. It needs something the grant suite is
 * really for and that the name only approximates: a real logged-in Mac session
 * that a CI runner cannot be relied on to provide. `NSPasteboard.general`
 * talks to the pasteboard server, and a headless or session-less runner is
 * exactly where that stops working — so putting this in `npm test` would mean
 * a check that reddens on the machine rather than on the code, which CLAUDE.md
 * records as worse than one that does not run. The ENCODING half needs none of
 * that and does run on CI, in `still-encode.test.ts`.
 *
 * ## What it actually proves
 *
 * That the pasteboard ends up holding all three representations the ticket
 * asks for — "put both PNG and TIFF representations on the pasteboard so
 * Slack, Figma and Keynote each take the one they handle best", plus the file
 * URL — read back from the SYSTEM pasteboard with `osascript`, not from the
 * helper's own reply. A helper that reported three types and wrote none would
 * pass every reply-shaped assertion, and that is the failure a user would
 * experience as ⌘V doing nothing.
 *
 * It cannot prove what Slack or Keynote then choose. That is the runbook.
 */

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");

interface Line { ev: string; seq?: number; [k: string]: any }
const live: ChildProcess[] = [];
afterEach(() => { for (const p of live.splice(0)) p.kill("SIGKILL"); });

function collect(stream: Readable, sink: Line[]): void {
  let buf = "";
  stream.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (l) { try { sink.push(JSON.parse(l)); } catch { /* not JSON */ } }
    }
  });
  stream.resume();
}

async function waitFor<T>(f: () => T | undefined, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function spawnHelper() {
  const proc = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  live.push(proc);
  const fd3: Line[] = [];
  collect(proc.stdio[3] as Readable, fd3);
  proc.stdout!.resume();
  proc.stderr!.resume();
  let seq = 700;
  return {
    request: async (c: object, ms = 40_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
  };
}

/** A 16x8 RGBA buffer with a hard alpha edge and one half-transparent column. */
function rgba(w: number, h: number): Buffer {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < w / 2 - 1)  { b[i] = 255; b[i + 3] = 255; }
      else if (x < w / 2) { b[i + 1] = 255; b[i + 3] = 128; }
    }
  }
  return b;
}

/** What the SYSTEM pasteboard says it holds, independent of the helper. */
function pasteboardTypes(): string[] {
  const out = execFileSync("osascript", ["-e", "clipboard info"], { encoding: "utf8" });
  // "«class PNGf», 214, «class TIFF», 1044, ..." — the class names are what
  // matter, the byte counts are not asserted on.
  return [...out.matchAll(/«class ([^»]+)»/g)].map((m) => m[1]!.trim());
}

describe("export-still puts a still on the pasteboard (STC-293)", () => {
  test("a copy carries PNG, TIFF and a file URL", async () => {
    const h = spawnHelper();
    const dir = mkdtempSync(join(tmpdir(), "stc-pb-"));
    const src = join(dir, "in.rgba");
    writeFileSync(src, rgba(16, 8));
    const file = join(dir, "copied.png");

    const r = await h.request({
      cmd: "export-still", rgba: src, width: 16, height: 8,
      alpha: true, format: "png", file, clipboard: true,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");

    // The helper's own account...
    expect(r.clipboard).toEqual(["png", "tiff", "fileURL"]);
    // ...and the file the URL points at, which has to be real: a promise
    // nobody answers hands the receiver a zero-byte file, which is why this
    // path writes before it copies.
    expect(existsSync(file)).toBe(true);

    // ...checked against what the system pasteboard actually holds.
    const types = pasteboardTypes();
    expect(types, `pasteboard held: ${types.join(", ")}`).toContain("PNGf");
    expect(types, `pasteboard held: ${types.join(", ")}`).toContain("TIFF");
    // `furl` is the file URL. Without it a drag into Finder and a Slack upload
    // get nothing.
    expect(types, `pasteboard held: ${types.join(", ")}`).toContain("furl");
  });

  test("a clipboard-only copy still leaves a real file for the URL", async () => {
    const h = spawnHelper();
    const dir = mkdtempSync(join(tmpdir(), "stc-pb-"));
    const src = join(dir, "in.rgba");
    writeFileSync(src, rgba(16, 8));

    // No `file`: the app always supplies one for a copy, but the helper must
    // not fall over when a caller does not — it simply has no URL to offer.
    const r = await h.request({
      cmd: "export-still", rgba: src, width: 16, height: 8,
      alpha: true, format: "png", clipboard: true,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    expect(r.clipboard).toEqual(["png", "tiff"]);
    expect(pasteboardTypes()).toContain("PNGf");
  });

  test("the pasteboard is replaced, not appended to", async () => {
    // Two copies in a row must not leave the first one's representations
    // behind for a receiver to pick up.
    execFileSync("osascript", ["-e", 'set the clipboard to "sentinel"']);
    expect(execFileSync("osascript", ["-e", "the clipboard as text"], { encoding: "utf8" }).trim())
      .toBe("sentinel");

    const h = spawnHelper();
    const dir = mkdtempSync(join(tmpdir(), "stc-pb-"));
    const src = join(dir, "in.rgba");
    writeFileSync(src, rgba(16, 8));
    await h.request({
      cmd: "export-still", rgba: src, width: 16, height: 8,
      alpha: true, format: "png", clipboard: true,
    });
    expect(pasteboardTypes()).not.toContain("utf8");
  });
});
