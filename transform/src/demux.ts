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
    let sawReady = false;
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const fail = (msg: string) => finish(() => reject(new Error(msg)));

    // Backstop. mp4box signals a malformed file by simply never calling back —
    // no onReady, no onError — so without this the promise never settles and
    // the caller waits forever with no error, no stack and nothing to debug.
    // Same shape as PHASE-0 §4b.5, reached from a different direction.
    const watchdog = setTimeout(
      () => fail("timed out reading display.mp4 — the file may be truncated or not an MP4"),
      15_000,
    );

    file.onError = (e: unknown) => { clearTimeout(watchdog); fail(`mp4box: ${String(e)}`); };
    file.onReady = (info: any) => {
      sawReady = true;
      const track = info.videoTracks[0];
      if (!track) { clearTimeout(watchdog); fail("no video track in display.mp4"); return; }

      // avcC description: serialize the box, strip the 8-byte box header.
      // NB PHASE-0 §4b.5: DataStream must come off the module export in use.
      const trak = file.getTrackById(track.id);
      const entries = trak.mdia.minf.stbl.stsd.entries;
      const avcC = entries.map((e: any) => e.avcC).find(Boolean);
      if (!avcC) { reject(new Error("no avcC box")); return; }
      const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      avcC.write(ds);
      const description = new Uint8Array(ds.buffer, 8, ds.position - 8);

      // Presentation time = media time + edit-list offset. AVAssetWriter records
      // the gap between "recording started" and "first frame arrived" as an
      // EMPTY EDIT (media_time -1) and leaves sample CTS starting at zero, so
      // reading the sample table alone reports every frame too early by that
      // gap. Measured at 231.7 ms on a real capture — about 14 frames of cursor
      // desync, small enough to look like a rendering bug rather than a clock one.
      const movieTimescale = file.moov.mvhd.timescale;
      //
      // Rounded, not exact: segment_duration is expressed in the MOVIE timescale
      // (600 Hz by default), which cannot represent an arbitrary nanosecond —
      // a real capture yielded 213333333.33... ns. Rounding is deterministic and
      // the residue is a constant sub-frame shift of the whole track, bounded by
      // half a movie tick. The writer raises the movie timescale to shrink that
      // bound; anchors.capture.firstFrameNs records the exact value the helper
      // measured, so the recovered offset can be checked rather than trusted.
      const editOffsetNs = Math.round(
        (trak.edts?.elst?.entries ?? [])
          .filter((e: any) => e.media_time === -1)
          .reduce((sum: number, e: any) => sum + (e.segment_duration / movieTimescale) * 1_000_000_000, 0),
      );

      const collected: any[] = [];
      file.onSamples = (_id: number, _user: unknown, samples: any[]) => {
        collected.push(...samples);
        if (collected.length < track.nb_samples) return;
        const framesNs = collected.map((s) => {
          const scale = 1_000_000_000 / s.timescale;
          const pts = s.cts * scale + editOffsetNs;
          if (!Number.isInteger(pts)) throw new Error(`non-integer ns PTS: cts=${s.cts} timescale=${s.timescale}`);
          return pts;
        });
        clearTimeout(watchdog);
        finish(() => resolve({
          framesNs,
          codec: track.codec,
          codedWidth: track.track_width,
          codedHeight: track.track_height,
          description,
          chunks: collected.map((s) => ({
            type: s.is_sync ? "key" : "delta",
            timestampUs: Math.round((s.cts * (1_000_000_000 / s.timescale) + editOffsetNs) / 1000),
            data: s.data as Uint8Array,
          })),
        }));
      };
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
    };
    const ab = buf as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    try {
      file.appendBuffer(ab);
      file.flush();
    } catch (e) {
      clearTimeout(watchdog);
      fail(`could not parse display.mp4: ${String(e)}`);
      return;
    }

    // Parsing is synchronous: by this point a valid file has produced onReady.
    // If it has not, there is no usable moov and no callback is coming.
    if (!sawReady) {
      clearTimeout(watchdog);
      fail("display.mp4 is not a readable MP4 — no track information found");
    }
  });
}
