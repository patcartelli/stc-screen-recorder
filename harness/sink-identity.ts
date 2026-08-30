import { render } from "@transform/render";
import { tickTimeNs, frameIndexAt } from "@transform/time";
import { mark } from "./mark.js";
import { loadSession } from "@transform/session";
import { ForwardFrameSource } from "@transform/frame-source";
import { SeekingFrameSource } from "@transform/seeking-frame-source";
import { composite } from "@transform/compositor";
import type { Project } from "@transform/types";
import { parseProject } from "@transform/trim";

/**
 * The increment-3 claim, isolated: preview and export must produce the SAME
 * pixels at the same t.
 *
 * Both call render() and the shared compositor, so the only thing that differs
 * is the frame source — forward-only for export, seeking for preview. If those
 * ever disagree about which decoded frame belongs to a time, the cursor would
 * sit over the wrong video content in preview and the user would only discover
 * it after exporting. This compares them frame by frame rather than trusting
 * that two code paths "obviously" agree.
 */

async function hashCanvas(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", ctx.getImageData(0, 0, w, h).data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

(window as any).runSinkIdentity = async (dir: string, sampleCount = 60) => {
  try {
    const anchors = await fetch(`${dir}/anchors.json`).then((r) => r.json());
    const events = await fetch(`${dir}/events.json`).then((r) => r.json());
    const mp4 = await fetch(`${dir}/${anchors.files.display}`).then((r) => r.arrayBuffer());
    // Only when the take's own anchors say it has one. Guessing by probing for
    // the file would turn "the anchors and the directory disagree" into a
    // silent camera-less pass, and loadSession refuses that mismatch anyway.
    const cameraMp4 = anchors.files.camera
      ? await fetch(`${dir}/${anchors.files.camera}`).then((r) => r.arrayBuffer())
      : undefined;

    mark("identity: loadSession (demux + VideoDecoder.configure)");
    const session = await loadSession({ anchors, events, displayMp4: mp4, cameraMp4 });

    // The take's OWN document, passed THROUGH parseProject — never used
    // verbatim, and never replaced by a literal assembled here.
    //
    // Both halves of the old code were wrong in the same way. A fetched project
    // went straight to render() without validation or defaulting; a take with
    // no project.json got the literal below, which has no `pip`. So every
    // camera take without a project.json rendered with no PiP and this gate
    // failed with "a camera track loaded but render() gave no PiP on any
    // sampled frame" — on a real 5.6 MB camera track.
    //
    // parseProject is what turns the PiP on for a camera take, from its
    // `hasCamera` argument. A hand-rolled object cannot know to do that, which
    // is the whole reason CLAUDE.md's rule is "pass the raw document": this was
    // the fourth caller to assemble one outside the single parser, and the
    // fourth time it produced two different answers.
    const projectRaw = await fetch(`${dir}/project.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const durationNs = session.frames[session.frames.length - 1] ?? 0;
    const project: Project = parseProject(
      projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
      anchors.camera?.present === true,
    );

    const { width, height } = project.output;
    const mkCtx = () => new OffscreenCanvas(width, height)
      .getContext("2d", { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;

    const lastNs = session.frames[session.frames.length - 1]!;
    const totalOut = Math.floor((lastNs * 60) / 1e9) + 1;

    // Ascending for the forward sink (its only legal order), and a deliberately
    // jumbled order for the seeking sink — a preview is scrubbed, not played
    // through, and identity must hold regardless of visit order.
    const ks: number[] = [];
    for (let i = 0; i < sampleCount; i++) ks.push(Math.floor((i * (totalOut - 1)) / (sampleCount - 1)));
    const shuffled = [...ks];
    let seed = 0xc0ffee;
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }

    const fwdCtx = mkCtx();
    const fwd = new ForwardFrameSource(session.video);
    const fwdCam = session.cameraVideo ? new ForwardFrameSource(session.cameraVideo) : null;
    const exportHash = new Map<number, string>();

    // The same frame composited a second time with the PiP SUPPRESSED.
    //
    // Comparing against this is the only check here that can fail when the
    // camera is decoded and then discarded. Two sinks that both ignore the
    // camera produce byte-identical output and pass every hash comparison in
    // this file — so identity alone cannot tell "both drew the PiP correctly"
    // from "neither drew it at all", and the latter is the likelier bug.
    const blindCtx = mkCtx();
    const blindHash = new Map<number, string>();
    let pipFrames = 0;
    let pipDrawnFrames = 0;

    for (const k of ks) {
      const t = tickTimeNs(2 * k);
      const fs = render(project, session, t);
      const idx = frameIndexAt(session.frames, t);
      const frame = idx === null ? null : await fwd.frameAt(idx);
      const cam = fs.pip && fwdCam ? await fwdCam.frameAt(fs.pip.frameIndex) : null;
      composite(fwdCtx, frame as unknown as ImageBitmap | null,
                cam as unknown as ImageBitmap | null, fs, width, height);
      exportHash.set(k, await hashCanvas(fwdCtx, width, height));

      composite(blindCtx, frame as unknown as ImageBitmap | null, null, fs, width, height);
      blindHash.set(k, await hashCanvas(blindCtx, width, height));
      if (fs.pip) pipFrames++;
      if (fs.pip && cam) pipDrawnFrames++;
    }
    fwd.close();
    fwdCam?.close();

    const prevCtx = mkCtx();
    mark("identity: new SeekingFrameSource (VideoDecoder.configure is synchronous)");
    const seek = new SeekingFrameSource(session.video);
    const seekCam = session.cameraVideo ? new SeekingFrameSource(session.cameraVideo) : null;
    const mismatches: string[] = [];
    for (const k of shuffled) {
      const t = tickTimeNs(2 * k);
      const fs = render(project, session, t);
      const idx = frameIndexAt(session.frames, t);
      const [frame, cam] = await Promise.all([
        idx === null ? null : seek.frameAt(idx),
        fs.pip && seekCam ? seekCam.frameAt(fs.pip.frameIndex) : null,
      ]);
      composite(prevCtx, frame as unknown as ImageBitmap | null,
                cam as unknown as ImageBitmap | null, fs, width, height);
      const h = await hashCanvas(prevCtx, width, height);
      if (h !== exportHash.get(k)) mismatches.push(`frame ${k} (t=${(t / 1e6).toFixed(1)}ms)`);
    }
    const stats = seek.stats;
    seek.close();
    seekCam?.close();

    // Frames that HAVE a PiP but look the same with it suppressed.
    let pipBlindMismatches = 0;
    for (const k of ks) {
      const t = tickTimeNs(2 * k);
      if (!render(project, session, t).pip) continue;
      if (exportHash.get(k) === blindHash.get(k)) pipBlindMismatches++;
    }

    return {
      samples: ks.length, mismatches, peakBuffered: stats.peakBuffered,
      decoderGenerations: stats.decoderGenerations, totalOut,
      cameraPresent: !!session.cameraVideo,
      pipFrames, pipDrawnFrames, pipBlindMismatches,
    };
  } catch (e: any) {
    return { fatal: String(e?.stack ?? e) };
  }
};
(window as any).__identityReady = true;
