import { contextBridge, ipcRenderer } from "electron";

/**
 * The floating thumbnail's bridge (STC-296) — deliberately narrower than the
 * main window's, the same reasoning `overlay-preload.ts` gives for the
 * selection overlay: this window gets exactly the channels it needs and
 * nothing a compromised renderer here could use to reach further.
 *
 * `exportStill` and `getFrame` are the SAME main-process handlers the main
 * window's own preload calls (`still:export`, `still:frame` in `main.ts`) —
 * reused rather than duplicated, per STC-293's Note: "no second
 * implementation hiding in the thumbnail."
 */
contextBridge.exposeInMainWorld("thumb", {
  getFrame: (dir: string, name: string) => ipcRenderer.invoke("still:frame", dir, name),
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
  exportStill: (req: Record<string, unknown>) => ipcRenderer.invoke("still:export", req),
  reveal: () => ipcRenderer.invoke("still:reveal"),
  // Fire-and-forget notices to the window that owns this panel
  // (`thumbnail-window.ts`), not request/response: it reacts by resizing or
  // destroying the window, and has nothing to hand back.
  event: (ev: { kind: "painted" | "expanded" | "done" }) => ipcRenderer.send("thumbnail:event", ev),
  // The timeout fired (or a new capture is replacing this panel) and it is
  // time to composite-and-export in the background. Main has already hidden
  // the window by the time this arrives — see thumbnail-window.ts.
  onSettle: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("thumbnail:settle", listener);
    return () => ipcRenderer.removeListener("thumbnail:settle", listener);
  },
});
