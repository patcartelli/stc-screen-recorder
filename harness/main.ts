import { mark } from "./mark.js";
import { render } from "@transform/render";
import { tickTimeNs } from "@transform/time";
import { demuxTrack, type DemuxedVideo } from "@transform/demux";
import { decodeAll } from "@transform/decode";
import { composite } from "@transform/compositor";
import type { Project, Session } from "@transform/types";
import { parseProject } from "@transform/trim";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { withTimeout } from "@transform/timeout";
import { applyDecoderPreference } from "./decoder.js";
import { decoderPreference } from "@transform/decoder-preference";

// STC-259: handed in by the runner (scripts/gate-bounds.mjs), never chosen
// here — and MARKED, so a wedged run's trail says which decoder it was
// asking for when it stopped. See harness/decoder.ts.
applyDecoderPreference();

const status = document.getElementById("status")!;
const say = (s: string) => { status.textContent += `\n${s}`; };

const EXPORT_FRAMES = 300; // 5 s at 60 fps
/** export frame k samples every other 120 Hz sim tick */
const exportTimeNs = (k: number) => tickTimeNs(2 * k);

async function sha256(data: BufferSource): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeCtx(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(w, h).getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  }) as OffscreenCanvasRenderingContext2D;
  return ctx;
}

/** Preview sink: seeks to arbitrary t values in the order given. Fresh decode. */
async function runPreview(
  project: Project, session: Session, video: DemuxedVideo, tsNs: number[],
): Promise<string[]> {
  mark("preview: decodeAll (VideoDecoder.configure is synchronous)");
  const bitmaps = await decodeAll(video);
  const { width, height } = project.output;
  const ctx = makeCtx(width, height);
  const hashes: string[] = [];
  mark(`preview: hashing ${tsNs.length} sampled t (getImageData is synchronous)`);
  for (const t of tsNs) {
    const fs = render(project, session, t);
    composite(ctx, fs.frameIndex === null ? null : bitmaps[fs.frameIndex]!, null, fs, width, height);
    hashes.push(await sha256(ctx.getImageData(0, 0, width, height).data));
    if (hashes.length % 50 === 0) mark(`preview: ${hashes.length}/${tsNs.length} hashed`);
  }
  bitmaps.forEach((b) => b.close());
  return hashes;
}

/** Export sink: walks the 60 fps output grid, hashes pre-encode, then encodes. Fresh decode. */
async function runExport(
  project: Project, session: Session, video: DemuxedVideo, encoderMs: number,
  label: string,
): Promise<{ hashes: string[]; encodedBytes: number }> {
  mark(`export[${label}]: decodeAll (VideoDecoder.configure is synchronous)`);
  const bitmaps = await decodeAll(video);
  const { width, height } = project.output;
  const ctx = makeCtx(width, height);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; },
  });
  // THE top suspect for Mode B: configure() is synchronous, and CI reports its
  // H.264 encoder as `paravirtualized:Apple Video Encoder`, a passthrough to a
  // host shared with other tenants. STC-259 measured a first touch of that
  // encoder blocking past 15 s from Swift.
  mark(`export[${label}]: VideoEncoder.configure (synchronous)`);
  encoder.configure({ codec: "avc1.42001f", width, height, framerate: 60, bitrate: 2_000_000 });

  const hashes: string[] = [];
  mark(`export[${label}]: encoding ${EXPORT_FRAMES} frames`);
  for (let k = 0; k < EXPORT_FRAMES; k++) {
    const t = exportTimeNs(k);
    const fs = render(project, session, t);
    composite(ctx, fs.frameIndex === null ? null : bitmaps[fs.frameIndex]!, null, fs, width, height);
    hashes.push(await sha256(ctx.getImageData(0, 0, width, height).data));
    const vf = new VideoFrame(ctx.canvas, { timestamp: Math.round(t / 1000) });
    encoder.encode(vf, { keyFrame: k % 60 === 0 });
    vf.close();

    // Bounded, the same way transform/src/export.ts bounds its own loop. This
    // harness previously pushed all 300 frames in and only bounded the flush,
    // so an encoder that never drained showed up as a hang minutes later with
    // the frame count lost. Fail at the frame it stopped on instead.
    const drainBy = performance.now() + encoderMs;
    while (encoder.encodeQueueSize > 30) {
      if (performance.now() > drainBy) {
        throw new Error(
          `encoder stopped draining at frame ${k} of ${EXPORT_FRAMES} ` +
          `(queue stuck at ${encoder.encodeQueueSize}) after ${encoderMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    if ((k + 1) % 50 === 0) mark(`export[${label}]: ${k + 1}/${EXPORT_FRAMES} frames`);
  }
  mark(`export[${label}]: encoder.flush`);
  await withTimeout(encoder.flush(), encoderMs, "encoder flush (harness)");
  muxer.finalize();
  encoder.close();
  bitmaps.forEach((b) => b.close());
  return { hashes, encodedBytes: target.buffer.byteLength };
}

async function main() {
  const [anchors, eventsDoc, framesJson, mp4] = await Promise.all([
    fetch("/basic/anchors.json").then((r) => r.json()),
    fetch("/basic/events.json").then((r) => r.json()),
    fetch("/basic/frames.json").then((r) => r.json()) as Promise<number[]>,
    fetch("/basic/display.mp4").then((r) => r.arrayBuffer()),
  ]);
  // Through parseProject, not verbatim. Benign today only because
  // fixtures/basic has no camera — the identical bypass in sink-identity.ts is
  // what made every camera take render without a PiP. A fixture that later
  // gains a camera must not have to rediscover that.
  const projectRaw = await fetch("/basic/project.json").then((r) => r.json());
  const video = await demuxTrack(mp4, "display.mp4");
  const project: Project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height,
    video.framesNs[video.framesNs.length - 1] ?? 0,
    anchors.camera?.present === true,
  );

  const framesMatch =
    video.framesNs.length === framesJson.length &&
    video.framesNs.every((v, i) => v === framesJson[i]);

  // the demuxed sample table is the source of truth for Session.frames
  const session: Session = { anchors, events: eventsDoc.events, frames: video.framesNs };
  say(`demuxed ${video.framesNs.length} frames; matches frames.json: ${framesMatch}`);

  (window as any).runGate = async (opts: { encoderMs?: number } = {}) => {
    // Handed in by scripts/_bounds.mjs so the in-page bound and the driver's
    // outer bound cannot drift apart. No default: a guessed one here would
    // silently restore exactly the drift the assertion exists to catch.
    const encoderMs = opts.encoderMs;
    if (typeof encoderMs !== "number") {
      throw new Error("runGate({ encoderMs }) requires an encoder bound from the runner");
    }
    // 200 of the 300 export times: every k not divisible by 3
    const sampledK: number[] = [];
    for (let k = 0; k < EXPORT_FRAMES; k++) if (k % 3 !== 0) sampledK.push(k);
    // deterministic shuffle — preview must not depend on visit order
    let seed = 0xbadc0de;
    for (let i = sampledK.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [sampledK[i], sampledK[j]] = [sampledK[j]!, sampledK[i]!];
    }

    say("export run A…");
    const a = await runExport(project, session, video, encoderMs, "A");
    say("export run B…");
    const b = await runExport(project, session, video, encoderMs, "B");
    say("preview run (shuffled order)…");
    const previewHash = await runPreview(project, session, video, sampledK.map(exportTimeNs));
    say("done");
    return {
      // Echoed so the driver asserts the page used the bound it was given,
      // rather than both sides merely believing they agree.
      encoderBoundMs: encoderMs,
      // Same reasoning for the decoder the runner asked for. An addInitScript
      // that silently failed to run would leave the page on Chromium's default
      // — the very path that wedges on CI — and the gate would still pass,
      // having quietly tested the wrong thing (STC-259).
      // Read back from the applied config, NOT from the global the runner
      // set: the runner's check is asking whether the page will decode the
      // way it was told to, and the global answers a weaker question.
      decoderPreference: decoderPreference().hardwareAcceleration ?? null,
      framesMatch,
      sampledK,
      previewHash,
      exportHashA: a.hashes,
      exportHashB: b.hashes,
      encodedBytes: a.encodedBytes,
    };
  };
  say("ready");
  (window as any).__ready = true;
}

main().catch((e) => say(`FATAL: ${e}\n${e?.stack ?? ""}`));
