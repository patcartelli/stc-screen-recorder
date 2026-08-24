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
