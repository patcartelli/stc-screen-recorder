import { render } from "@transform/render";
import { tickTimeNs } from "@transform/time";
import { demuxDisplayMp4, type DemuxedVideo } from "@transform/demux";
import { decodeAll } from "@transform/decode";
import { composite } from "@transform/compositor";
import type { Project, Session } from "@transform/types";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { withTimeout } from "@transform/timeout";

const status = document.getElementById("status")!;
const say = (s: string) => { status.textContent += `\n${s}`; };

const EXPORT_FRAMES = 300; // 5 s at 60 fps
/** export frame k samples every other 120 Hz sim tick */
const exportTimeNs = (k: number) => tickTimeNs(2 * k);

async function sha256(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
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
  const bitmaps = await decodeAll(video);
  const { width, height } = project.output;
  const ctx = makeCtx(width, height);
  const hashes: string[] = [];
  for (const t of tsNs) {
    const fs = render(project, session, t);
    composite(ctx, fs.frameIndex === null ? null : bitmaps[fs.frameIndex]!, fs, width, height);
    hashes.push(await sha256(ctx.getImageData(0, 0, width, height).data));
  }
  bitmaps.forEach((b) => b.close());
  return hashes;
}

/** Export sink: walks the 60 fps output grid, hashes pre-encode, then encodes. Fresh decode. */
async function runExport(
  project: Project, session: Session, video: DemuxedVideo,
): Promise<{ hashes: string[]; encodedBytes: number }> {
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
  encoder.configure({ codec: "avc1.42001f", width, height, framerate: 60, bitrate: 2_000_000 });

  const hashes: string[] = [];
  for (let k = 0; k < EXPORT_FRAMES; k++) {
    const t = exportTimeNs(k);
    const fs = render(project, session, t);
    composite(ctx, fs.frameIndex === null ? null : bitmaps[fs.frameIndex]!, fs, width, height);
    hashes.push(await sha256(ctx.getImageData(0, 0, width, height).data));
    const vf = new VideoFrame(ctx.canvas, { timestamp: Math.round(t / 1000) });
    encoder.encode(vf, { keyFrame: k % 60 === 0 });
    vf.close();
  }
  await withTimeout(encoder.flush(), 120_000, "encoder flush (harness)");
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
  const project: Project = await fetch("/basic/project.json").then((r) => r.json());
  const video = await demuxDisplayMp4(mp4);

  const framesMatch =
    video.framesNs.length === framesJson.length &&
    video.framesNs.every((v, i) => v === framesJson[i]);

  // the demuxed sample table is the source of truth for Session.frames
  const session: Session = { anchors, events: eventsDoc.events, frames: video.framesNs };
  say(`demuxed ${video.framesNs.length} frames; matches frames.json: ${framesMatch}`);

  (window as any).runGate = async () => {
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
    const a = await runExport(project, session, video);
    say("export run B…");
    const b = await runExport(project, session, video);
    say("preview run (shuffled order)…");
    const previewHash = await runPreview(project, session, video, sampledK.map(exportTimeNs));
    say("done");
    return {
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
