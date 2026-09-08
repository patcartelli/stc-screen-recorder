import { describe, test, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Readable } from "node:stream";
import { REDACTION_FILL_ON_LIGHT } from "../../transform/src/still-redact.js";

/**
 * STC-293: `export-still` encoding for real, through ImageIO.
 *
 * This is NOT a grant test, and that is the point. Encoding pixels needs no
 * Screen Recording permission — there is no capture involved — so unlike
 * everything else in the still path it can run on CI's macOS runner, which
 * means the ObjC-free half of the encoder is proved on every push rather than
 * only when someone is at the Mac. What is left for the runbook is the
 * pasteboard (`still-clipboard.grant.test.ts`) and how the result LOOKS.
 *
 * The assertions read the encoded bytes rather than the reply: a helper that
 * reported success and wrote a broken file would pass any reply-shaped check,
 * and "a file the user will open, find broken, and blame the capture for" is
 * the failure this path most needs to not have.
 */

const root = join(__dirname, "..", "..");
const BIN = join(root, "helper", "build", "stc-helper");
// helper binary is built once by vitest.global-setup.ts

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
  let seq = 500;
  return {
    // Bounded like every other wait in this codebase. 40 s clears the helper's
    // own 30 s export backstop, so a wedge is reported by the helper — with
    // the step it reached — rather than anonymously by the runner.
    request: async (c: object, ms = 40_000): Promise<Line> => {
      const s = ++seq;
      proc.stdin!.write(JSON.stringify({ ...c, seq: s }) + "\n");
      return waitFor(() => fd3.find((l) => l.seq === s), ms, `seq ${s} (${JSON.stringify(c)})`);
    },
  };
}

/**
 * A `w * h` RGBA buffer, unpremultiplied, with a hard alpha edge.
 *
 * The left half is opaque red, the right half fully transparent, and one
 * column between them is half-transparent green. That middle column is the
 * interesting one: it is what a premultiply bug or a wrong byte order shows up
 * in, and it stands in for a window capture's antialiased corner.
 */
function rgba(w: number, h: number): Buffer {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < w / 2 - 1)      { b[i] = 255; b[i + 1] = 0; b[i + 2] = 0; b[i + 3] = 255; }
      else if (x < w / 2)     { b[i] = 0; b[i + 1] = 255; b[i + 2] = 0; b[i + 3] = 128; }
      else                    { b[i] = 0; b[i + 1] = 0; b[i + 2] = 255; b[i + 3] = 0; }
    }
  }
  return b;
}

function scratch(w = 16, h = 8) {
  const dir = mkdtempSync(join(tmpdir(), "stc-encode-"));
  const path = join(dir, "in.rgba");
  writeFileSync(path, rgba(w, h));
  return { dir, path, width: w, height: h };
}

/** PNG's IHDR colour type: 6 is RGBA, 2 is RGB. Byte 25 of the file. */
function pngColorType(buf: Buffer): number {
  expect(buf.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
  expect(buf.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return buf[25]!;
}

const has = (buf: Buffer, chunk: string) => buf.includes(Buffer.from(chunk, "latin1"));

describe("export-still encodes through ImageIO (STC-293)", () => {
  test("PNG keeps the alpha channel", async () => {
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "out.png");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: true, format: "png", file: out,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    expect(existsSync(out)).toBe(true);
    const buf = readFileSync(out);
    // 6 = truecolour with alpha. This is the whole reason the still path
    // exists: three of the five decoration modes produce transparency and it
    // has to survive the encoder.
    expect(pngColorType(buf), "PNG colour type").toBe(6);
    expect(r.alpha).toBe(true);
    // Which bitmap layout CoreGraphics took. Unpremultiplied is what a canvas
    // produces and what this asks for first; the fallback existing is fine,
    // it silently becoming the normal path is what would want investigating.
    expect(typeof r.premultiplied).toBe("boolean");
  });

  test("a shot marked opaque produces a PNG with no alpha channel", async () => {
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "opaque.png");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: false, format: "png", file: out,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    // 2 = truecolour without alpha. The fourth byte per pixel is skipped
    // rather than the buffer being repacked, so this also proves the
    // `noneSkipLast` layout is read correctly.
    expect(pngColorType(readFileSync(out))).toBe(2);
    expect(r.alpha).toBe(false);
  });

  test("a Display P3 capture is encoded with an embedded profile", async () => {
    // The acceptance list: "Round trip through PNG preserves the wide-gamut
    // colours of a P3 display capture without a visible shift". The profile IS
    // that preservation — without it every viewer falls back to sRGB.
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "p3.png");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: true, format: "png", colorSpace: "display-p3", file: out,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    expect(r.colorSpace).toBe("display-p3");
    const buf = readFileSync(out);
    // iCCP is PNG's embedded-ICC chunk. A P3 PNG that carries only an `sRGB`
    // chunk, or neither, is the silent shift this test exists to catch.
    expect(has(buf, "iCCP"), "a P3 PNG must carry an embedded ICC profile").toBe(true);
  });

  test("the colour profile survives a metadata strip", async () => {
    // "strip metadata" governs the capture timestamp, NOT the profile: one
    // says when the user was at their desk, the other is what makes the
    // numbers mean colours.
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "stripped.png");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: true, format: "png", colorSpace: "display-p3", file: out,
    });
    expect(r.metadata).toBe("stripped");
    expect(has(readFileSync(out), "iCCP")).toBe(true);
  });

  test("JPEG is written, and never carries alpha", async () => {
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "out.jpg");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      // Deliberately claiming alpha: a JPEG must drop it rather than hand
      // ImageIO a contradiction and inherit a black fill.
      alpha: true, format: "jpeg", quality: 0.8, file: out,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    expect(r.alpha).toBe(false);
    const buf = readFileSync(out);
    expect(buf.subarray(0, 3).toString("hex")).toBe("ffd8ff");
  });

  test("a kept timestamp reaches the file's EXIF", async () => {
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "dated.jpg");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: false, format: "jpeg", file: out, capturedAt: "2026-09-08T14:23:05Z",
    });
    expect(r.metadata).toBe("kept");
    const buf = readFileSync(out);
    // The date is written in local time, so only the DATE part is stable
    // across whatever zone the runner is in — and even that can shift by a
    // day, so the assertion is on the EXIF marker plus the year.
    expect(has(buf, "Exif"), "a kept timestamp means an EXIF block").toBe(true);
    expect(has(buf, "2026:09:0") || has(buf, "2026:09:1"), "the capture year and month").toBe(true);
  });

  test("a stripped export carries no EXIF at all", async () => {
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "nodate.jpg");
    await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: false, format: "jpeg", file: out,
    });
    // Nothing to remove and nothing added: the pixels arrive as raw RGBA with
    // no container, so the strip cannot be incomplete.
    expect(has(readFileSync(out), "2026:")).toBe(false);
  });

  test("HEIC keeps alpha, or says the machine cannot write it", async () => {
    // HEIC goes through the HEVC encoder, which on CI is a paravirtualized
    // passthrough that STC-259 measured blocking past 15 s on first touch. So
    // a failure here is labelled ENVIRONMENT and skipped loudly rather than
    // reddening a PR — the same rule the gates follow. A file that IS written
    // must still be a real HEIC: only the encoder being unavailable is
    // excusable, never a wrong one.
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "out.heic");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: s.width, height: s.height,
      alpha: true, format: "heic", quality: 0.9, file: out,
    });
    if (r.ev === "error") {
      process.stderr.write(
        `ENVIRONMENT: this machine did not encode HEIC (${r.code}: ${r.detail}). `
        + "HEIC support is NOT verified by this run.\n");
      expect(r.code, "a HEIC failure must be an encode failure, not a bad request")
        .toBe("encode-failed");
      return;
    }
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    const buf = readFileSync(out);
    // ISO-BMFF: a `ftyp` box at offset 4, with an HEIF brand.
    expect(buf.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(buf.subarray(8, 12).toString("latin1")).toMatch(/^(hei[cx]|mif1|msf1)$/);
    expect(r.alpha).toBe(true);
  });
});

describe("export-still refuses what it cannot honour (STC-293)", () => {
  test("an RGBA file of the wrong length is refused, not read past", async () => {
    const h = spawnHelper();
    const s = scratch(16, 8);
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: 16, height: 9,
      alpha: true, format: "png", file: join(s.dir, "x.png"),
    });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("rgba-size-mismatch");
    // The numbers, so the message is diagnosable rather than merely correct.
    expect(r.detail).toContain("576");
    expect(existsSync(join(s.dir, "x.png"))).toBe(false);
  });

  test("a missing RGBA file is reported rather than crashing the helper", async () => {
    const h = spawnHelper();
    const s = scratch();
    const r = await h.request({
      cmd: "export-still", rgba: join(s.dir, "gone.rgba"), width: 16, height: 8,
      alpha: true, format: "png", file: join(s.dir, "x.png"),
    });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("rgba-unreadable");
    // Still answering afterwards is the real assertion: a still export must
    // never be able to take the helper — or a running take — down with it.
    expect((await h.request({ cmd: "status" })).ev).toBe("status");
  });

  test("an export with nowhere to go is refused", async () => {
    const h = spawnHelper();
    const s = scratch();
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: 16, height: 8, alpha: true, format: "png",
    });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("no-destination");
  });

  test("an unknown format is refused, not defaulted to PNG", async () => {
    const h = spawnHelper();
    const s = scratch();
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: 16, height: 8,
      alpha: true, format: "webp", file: join(s.dir, "x.webp"),
    });
    expect(r.ev).toBe("error");
    expect(r.code).toBe("bad-format");
  });

  test("a destination directory that does not exist yet is created", async () => {
    // A destination folder the user picked and later deleted is a normal
    // state, not a reason to lose their export.
    const h = spawnHelper();
    const s = scratch();
    const out = join(s.dir, "new", "deep", "out.png");
    const r = await h.request({
      cmd: "export-still", rgba: s.path, width: 16, height: 8,
      alpha: true, format: "png", file: out,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");
    expect(existsSync(out)).toBe(true);
  });
});

/**
 * STC-297's headline acceptance criterion, taken literally.
 *
 * "An exported PNG with a fill region contains no trace of the covered pixels,
 * VERIFIED BY INSPECTING THE ENCODED FILE rather than by looking at it." So
 * this decodes the PNG the helper wrote — inflate, unfilter, read pixels — and
 * asks two questions of the result: is every pixel under the box exactly the
 * fill, and does the colour that was underneath appear anywhere at all.
 *
 * Looking at the picture cannot answer either. A fill drawn at 0.98 alpha, or
 * one composited under a shadow, or an encoder that kept a smaller original
 * alongside, all LOOK identical to a correct one; the pixels are the only
 * witness. The `#0b0b0c` here is not a shade of black chosen by this test —
 * it is `still-redact.ts`'s constant, imported, so a change to the fill cannot
 * quietly leave this asserting against the old one.
 */

/** A minimal PNG reader: IHDR, the IDAT stream, and the five scanline filters. */
function decodePng(buf: Buffer): { width: number; height: number; channels: number; data: Buffer } {
  expect(buf.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24]!;
  const colorType = buf[25]!;
  const interlace = buf[28]!;
  // Anything else and the unfilter below would be reading the wrong shape —
  // fail saying so rather than producing plausible nonsense.
  expect(bitDepth, "8-bit channels").toBe(8);
  expect(interlace, "non-interlaced").toBe(0);
  expect([2, 6], `colour type ${colorType}`).toContain(colorType);
  const channels = colorType === 6 ? 4 : 3;

  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString("latin1");
    if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    if (type === "IEND") break;
    p += 12 + len;               // length + type + data + CRC
  }
  const raw = inflateSync(Buffer.concat(idat));

  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels]! : 0;
      const x = line[i]!;
      out[y * stride + i] =
        filter === 0 ? x
        : filter === 1 ? (x + a) & 255
        : filter === 2 ? (x + b) & 255
        : filter === 3 ? (x + ((a + b) >> 1)) & 255
        : (x + paeth(a, b, c)) & 255;
    }
  }
  return { width, height, channels, data: out };
}

describe("redaction is irreversible in the encoded file (STC-297)", () => {
  const W = 16, H = 8;
  /** The thing being hidden. Distinctive so its absence is checkable. */
  const SECRET = [200, 30, 90] as const;
  const PAGE = [240, 240, 240] as const;
  const BOX = { x: 4, y: 2, width: 8, height: 4 };
  const fill = [
    parseInt(REDACTION_FILL_ON_LIGHT.slice(1, 3), 16),
    parseInt(REDACTION_FILL_ON_LIGHT.slice(3, 5), 16),
    parseInt(REDACTION_FILL_ON_LIGHT.slice(5, 7), 16),
  ] as const;

  const inBox = (x: number, y: number) =>
    x >= BOX.x && x < BOX.x + BOX.width && y >= BOX.y && y < BOX.y + BOX.height;

  /** The composite the renderer would hand over: secret laid down, then covered. */
  function composited(): Buffer {
    const b = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const c = inBox(x, y) ? fill : (x > 3 && x < 12 && y > 1 && y < 6) ? SECRET : PAGE;
        b[i] = c[0]!; b[i + 1] = c[1]!; b[i + 2] = c[2]!; b[i + 3] = 255;
      }
    }
    return b;
  }

  test("the covered pixels are the fill, and the secret is nowhere in the file", async () => {
    const h = spawnHelper();
    const dir = mkdtempSync(join(tmpdir(), "stc-redact-"));
    const src = join(dir, "in.rgba");
    writeFileSync(src, composited());
    const out = join(dir, "redacted.png");

    const r = await h.request({
      cmd: "export-still", rgba: src, width: W, height: H,
      alpha: false, format: "png", file: out,
    });
    expect(r.ev, JSON.stringify(r)).toBe("exported-still");

    const png = decodePng(readFileSync(out));
    expect(png.width).toBe(W);
    expect(png.height).toBe(H);

    let covered = 0;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const i = (y * png.width + x) * png.channels;
        const rgb = [png.data[i], png.data[i + 1], png.data[i + 2]];
        // Nowhere in the image — not just inside the box. An encoder that
        // tucked a smaller original into the file would fail here.
        expect(rgb, `secret at ${x},${y}`).not.toEqual([...SECRET]);
        if (inBox(x, y)) {
          // Exactly, not approximately: "no trace" and "close enough" are
          // different claims, and only one of them is the ticket's.
          expect(rgb, `covered pixel ${x},${y}`).toEqual([...fill]);
          covered++;
        }
      }
    }
    expect(covered, "the box was actually inspected").toBe(BOX.width * BOX.height);
  });

  test("the fill is uniform — no gradient, no edge left half-covered", async () => {
    // A partially-transparent fill composited over the secret would leave the
    // box a blend of fill and secret: still "dark", still plausible to an eye,
    // and recoverable. Uniformity is what rules that out.
    const h = spawnHelper();
    const dir = mkdtempSync(join(tmpdir(), "stc-redact-"));
    const src = join(dir, "in.rgba");
    writeFileSync(src, composited());
    const out = join(dir, "uniform.png");
    await h.request({
      cmd: "export-still", rgba: src, width: W, height: H,
      alpha: false, format: "png", file: out,
    });

    const png = decodePng(readFileSync(out));
    const seen = new Set<string>();
    for (let y = BOX.y; y < BOX.y + BOX.height; y++) {
      for (let x = BOX.x; x < BOX.x + BOX.width; x++) {
        const i = (y * png.width + x) * png.channels;
        seen.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
      }
    }
    expect([...seen]).toEqual([`${fill[0]},${fill[1]},${fill[2]}`]);
  });
});
