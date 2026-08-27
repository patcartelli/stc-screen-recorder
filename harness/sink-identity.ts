import { render } from "@transform/render";
import { tickTimeNs, frameIndexAt } from "@transform/time";
import { loadSession } from "@transform/session";
import { ForwardFrameSource } from "@transform/frame-source";
import { SeekingFrameSource } from "@transform/seeking-frame-source";
import { composite } from "@transform/compositor";
import type { Project } from "@transform/types";

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
  const d = await crypto.subtle.digest("SHA-256", ctx.getImageData(0, 0, w, h).data as unknown as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

(window as any).runSinkIdentity = async (dir: string, sampleCount = 60) => {
  try {
    const [anchors, events, mp4] = await Promise.all([
      fetch(`${dir}/anchors.json`).then((r) => r.json()),
      fetch(`${dir}/events.json`).then((r) => r.json()),
      fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer()),
    ]);
    const session = await loadSession({ anchors, events, displayMp4: mp4 });
    const project: Project = {
      version: 1,
      output: { fps: 60, width: anchors.capture.width, height: anchors.capture.height },
      cursor: { style: "default", scale: 1 },
    };
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
    const exportHash = new Map<number, string>();
    for (const k of ks) {
      const t = tickTimeNs(2 * k);
      const fs = render(project, session, t);
      const idx = frameIndexAt(session.frames, t);
      const frame = idx === null ? null : await fwd.frameAt(idx);
      composite(fwdCtx, frame as unknown as ImageBitmap | null, null, fs, width, height);
      exportHash.set(k, await hashCanvas(fwdCtx, width, height));
    }
    fwd.close();

    const prevCtx = mkCtx();
    const seek = new SeekingFrameSource(session.video);
    const mismatches: string[] = [];
    for (const k of shuffled) {
      const t = tickTimeNs(2 * k);
      const fs = render(project, session, t);
      const idx = frameIndexAt(session.frames, t);
      const frame = idx === null ? null : await seek.frameAt(idx);
      composite(prevCtx, frame as unknown as ImageBitmap | null, null, fs, width, height);
      const h = await hashCanvas(prevCtx, width, height);
      if (h !== exportHash.get(k)) mismatches.push(`frame ${k} (t=${(t / 1e6).toFixed(1)}ms)`);
    }
    const stats = seek.stats;
    seek.close();

    return { samples: ks.length, mismatches, peakBuffered: stats.peakBuffered,
             decoderGenerations: stats.decoderGenerations, totalOut };
  } catch (e: any) {
    return { fatal: String(e?.stack ?? e) };
  }
};
(window as any).__identityReady = true;
