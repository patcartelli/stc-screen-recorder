import { loadSession } from "@transform/session";
import { exportSession as runExport, type ExportOptions } from "@transform/export";
import type { Project } from "@transform/types";

/**
 * Thin browser wrapper: fetch a session, then call the ONE export
 * implementation the app also uses.
 */
(window as any).exportSession = async (dir: string, project: Project, opts: ExportOptions & { returnFile?: boolean } = {}) => {
  const [anchors, events, displayMp4] = await Promise.all([
    fetch(`${dir}/anchors.json`).then((r) => r.json()),
    fetch(`${dir}/events.json`).then((r) => r.json()),
    fetch(`${dir}/display.mp4`).then((r) => r.arrayBuffer()),
  ]);
  const session = await loadSession({ anchors, events, displayMp4 });
  const r = await runExport(session, project, { hash: true, ...opts });

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
