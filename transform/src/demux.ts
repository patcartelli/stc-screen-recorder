import * as MP4BoxNS from "mp4box";

// mp4box ships CJS+ESM; normalize the default-export interop once.
const MP4Box: any = (MP4BoxNS as any).default ?? MP4BoxNS;

/**
 * The one shared demux module (PHASE-1: sinks derive the frame PTS grid from
 * display.mp4's sample table via shared code — never from "latest decoded
 * frame" or per-sink parsing that could disagree).
 */
export interface DemuxedVideo {
  /** source-frame PTS grid, session-relative integer ns — this IS Session.frames */
  framesNs: number[];
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC payload for VideoDecoder.configure */
  description: Uint8Array;
  chunks: { type: "key" | "delta"; timestampUs: number; data: Uint8Array }[];
}

export function demuxDisplayMp4(buf: ArrayBuffer): Promise<DemuxedVideo> {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    file.onError = (e: unknown) => reject(new Error(`mp4box: ${String(e)}`));
    file.onReady = (info: any) => {
      const track = info.videoTracks[0];
      if (!track) { reject(new Error("no video track")); return; }

      // avcC description: serialize the box, strip the 8-byte box header.
      // NB PHASE-0 §4b.5: DataStream must come off the module export in use.
      const entries = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries;
      const avcC = entries.map((e: any) => e.avcC).find(Boolean);
      if (!avcC) { reject(new Error("no avcC box")); return; }
      const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      avcC.write(ds);
      const description = new Uint8Array(ds.buffer, 8, ds.position - 8);

      const collected: any[] = [];
      file.onSamples = (_id: number, _user: unknown, samples: any[]) => {
        collected.push(...samples);
        if (collected.length < track.nb_samples) return;
        const framesNs = collected.map((s) => {
          const scale = 1_000_000_000 / s.timescale;
          const pts = s.cts * scale;
          if (!Number.isInteger(pts)) throw new Error(`non-integer ns PTS: cts=${s.cts} timescale=${s.timescale}`);
          return pts;
        });
        resolve({
          framesNs,
          codec: track.codec,
          codedWidth: track.track_width,
          codedHeight: track.track_height,
          description,
          chunks: collected.map((s) => ({
            type: s.is_sync ? "key" : "delta",
            timestampUs: Math.round((s.cts * (1_000_000_000 / s.timescale)) / 1000),
            data: s.data as Uint8Array,
          })),
        });
      };
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
    };
    const ab = buf as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    file.appendBuffer(ab);
    file.flush();
  });
}
