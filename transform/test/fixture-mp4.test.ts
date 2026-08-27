import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as MP4BoxNS from "mp4box";

const MP4Box: any = (MP4BoxNS as any).default ?? MP4BoxNS;

const root = join(__dirname, "..", "..");
const framesNs: number[] = JSON.parse(
  readFileSync(join(root, "fixtures", "basic", "frames.json"), "utf8"),
);

interface SampleInfo { cts: number; dts: number; timescale: number; is_sync: boolean }

function demuxSamples(): Promise<{ info: any; samples: SampleInfo[] }> {
  const buf = readFileSync(join(root, "fixtures", "basic", "display.mp4"));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as any;
  ab.fileStart = 0;
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    file.onError = (e: unknown) => reject(new Error(String(e)));
    file.onReady = (info: any) => {
      const track = info.videoTracks[0];
      resolve({ info, samples: file.getTrackSamplesInfo(track.id) as SampleInfo[] });
    };
    file.appendBuffer(ab);
    file.flush();
  });
}

describe("fixture display.mp4 matches the hand-authored session contract", () => {
  test("one H.264 video track at capture dimensions, no audio", async () => {
    const { info } = await demuxSamples();
    expect(info.videoTracks.length).toBe(1);
    expect(info.audioTracks.length).toBe(0);
    expect(info.videoTracks[0].codec.startsWith("avc1")).toBe(true);
    expect(info.videoTracks[0].track_width).toBe(640);
    expect(info.videoTracks[0].track_height).toBe(360);
  });

  test("sample PTS grid is exactly frames.json, in integer nanoseconds", async () => {
    const { samples } = await demuxSamples();
    expect(samples.length).toBe(framesNs.length);
    const scale = 1_000_000_000 / samples[0]!.timescale;
    expect(Number.isInteger(scale)).toBe(true);
    const pts = samples.map((s) => s.cts * scale);
    expect(pts).toEqual(framesNs);
  });

  test("no B-frames: decode order equals presentation order (cts === dts throughout)", async () => {
    const { samples } = await demuxSamples();
    for (const s of samples) expect(s.cts).toBe(s.dts);
  });

  test("first sample is a keyframe", async () => {
    const { samples } = await demuxSamples();
    expect(samples[0]!.is_sync).toBe(true);
  });
});

describe("demux honours the edit list", () => {
  // A real capture never starts exactly when the start command arrives, so
  // AVAssetWriter records the gap as an EMPTY EDIT and leaves sample CTS
  // starting at 0. Reading only the sample table therefore reports every frame
  // too early by that gap — measured at 231.7 ms on a real recording, which is
  // ~14 frames of cursor desync: visible, but easy to blame on anything else.
  test("frames start at their true session-relative time, not at zero", async () => {
    const framesNs: number[] = JSON.parse(
      readFileSync(join(root, "fixtures", "offset", "frames.json"), "utf8"),
    );
    const { demuxTrack } = await import("../src/demux.js");
    const buf = readFileSync(join(root, "fixtures", "offset", "display.mp4"));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const video = await demuxTrack(ab, "display.mp4");
    expect(video.framesNs[0]).toBe(250_000_000);
    expect(video.framesNs).toEqual(framesNs);
  });
});

describe("demux refuses unreadable input instead of hanging", () => {
  // A promise that never settles is the least debuggable failure available: no
  // error, no stack, no timeout — just a button that does nothing forever.
  // mp4box calls neither onReady nor onError for a file with no valid boxes.
  const settles = async (buf: ArrayBuffer) => {
    const { demuxTrack } = await import("../src/demux.js");
    return Promise.race([
      demuxTrack(buf, "display.mp4").then(() => "resolved", (e) => `rejected: ${e.message}`),
      new Promise<string>((r) => setTimeout(() => r("HUNG"), 4000)),
    ]);
  };

  test("garbage bytes reject", async () => {
    const out = await settles(new Uint8Array(8192).fill(0x41).buffer);
    expect(out).not.toBe("HUNG");
    expect(out).toMatch(/rejected/);
  }, 15_000);

  test("an empty file rejects", async () => {
    const out = await settles(new ArrayBuffer(0));
    expect(out).not.toBe("HUNG");
    expect(out).toMatch(/rejected/);
  }, 15_000);

  test("a truncated real mp4 rejects rather than hanging", async () => {
    const full = readFileSync(join(root, "fixtures", "basic", "display.mp4"));
    const half = full.subarray(0, Math.floor(full.length / 3));
    const ab = half.buffer.slice(half.byteOffset, half.byteOffset + half.byteLength) as ArrayBuffer;
    const out = await settles(ab);
    expect(out).not.toBe("HUNG");
  }, 15_000);
});
