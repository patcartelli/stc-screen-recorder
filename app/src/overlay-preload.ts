import { contextBridge, ipcRenderer } from "electron";

/**
 * The overlay's bridge (STC-290) — deliberately smaller than the main window's.
 *
 * The overlay reads nothing and writes nothing. It reports input and receives
 * state to draw, and that is the whole surface: no file access, no capture, no
 * settings. Everything it could be asked to decide is decided in the main
 * process by `selection.ts`, so there is nothing here for a compromised
 * renderer to reach for.
 */
contextBridge.exposeInMainWorld("overlay", {
  send: (event: unknown) => ipcRenderer.send("overlay:event", event),
  onState: (cb: (payload: any) => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on("overlay:state", listener);
    return () => ipcRenderer.removeListener("overlay:state", listener);
  },
});
