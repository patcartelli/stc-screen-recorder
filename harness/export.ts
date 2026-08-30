import { mark } from "./mark.js";
import { loadSession } from "@transform/session";
import { exportSession as runExport, type ExportOptions } from "@transform/export";
import { parseProject } from "@transform/trim";
import type { Project } from "@transform/types";

/**
 * Thin browser wrapper: fetch a session, then call the ONE export
 * implementation the app also uses.
 */
/**
 * `projectRaw` is the take's project.json as read from disk, or null when it
 * has none — NOT a project object assembled by the caller.
 *
 * The defaults have to be decided in ONE place. When the caller synthesised its
 * own, a take with no project.json exported with `pip` absent while the app
 * previewed the same take WITH a PiP, because parseProject defaults it on for a
 * camera take and the caller's hand-rolled object did not. Same take, two
 * answers, and the CLI's was the wrong one.
 */
(window as any).exportSession = async (dir: string, projectRaw: unknown, opts: ExportOptions & { returnFile?: boolean } = {}) => {
  const [anchors, events, displayMp4] = await Promise.all([
    fetch(`${dir}/anchors.json`).then((r) => r.json()),
    fetch(`${dir}/events.json`).then((r) => r.json()),
    fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer()),
  ]);
  // Fetched only when the take's own anchors say it has one — loadSession
  // refuses a camera.mp4 that the anchors do not claim, and refuses a claim
  // with no file. Without this the export of any camera take dies at load with
  // "no camera.mp4 was supplied", which is exactly what it did.
  const cameraMp4 = anchors.files?.camera
    ? await fetch(`${dir}/${anchors.files.camera}`).then((r) => r.arrayBuffer())
    : undefined;
  mark("export: loadSession (demux + VideoDecoder.configure)");
  const session = await loadSession({ anchors, events, displayMp4, cameraMp4 });
  const durationNs = session.frames[session.frames.length - 1] ?? 0;
  const project: Project = parseProject(
    projectRaw, anchors.capture.width, anchors.capture.height, durationNs,
    anchors.camera?.present === true,
  );
  mark("export: exportSession (decode, render, VideoEncoder.configure, encode)");
  const r = await runExport(session, project, { hash: true, ...opts });
  mark("export: exportSession returned");

  let encodedBase64: string | undefined;
  if (opts.returnFile && r.encoded) {
    let bin = "";
    for (let i = 0; i < r.encoded.length; i += 0x8000) {
      bin += String.fromCharCode(...r.encoded.subarray(i, i + 0x8000));
    }
    encodedBase64 = btoa(bin);
  }
  const { encoded, ...rest } = r;
  return { ...rest, encodedBase64 };
};
(window as any).__exportReady = true;
