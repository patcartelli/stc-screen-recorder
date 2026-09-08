import { contextBridge, ipcRenderer } from "electron";

/**
 * The renderer gets a narrow, named surface — no ipcRenderer, no node. Every
 * channel is listed here explicitly so the UI cannot reach anything the main
 * process did not deliberately expose.
 */
contextBridge.exposeInMainWorld("recorder", {
  status: () => ipcRenderer.invoke("recorder:status"),
  devices: () => ipcRenderer.invoke("recorder:devices"),
  getSettings: () => ipcRenderer.invoke("recorder:getSettings"),
  setSettings: (patch: Record<string, unknown>) => ipcRenderer.invoke("recorder:setSettings", patch),
  takes: () => ipcRenderer.invoke("recorder:takes"),
  labelTake: (dir: string, label: string) => ipcRenderer.invoke("take:label", dir, label),
  deleteTake: (dir: string) => ipcRenderer.invoke("take:delete", dir),
  openPreview: (dir: string) => ipcRenderer.invoke("preview:open", dir),
  closePreview: () => ipcRenderer.invoke("preview:close"),
  readTakeFile: (name: string) => ipcRenderer.invoke("preview:read", name),
  takeFileSize: (name: string) => ipcRenderer.invoke("preview:size", name),
  readTakeChunk: (name: string, offset: number, length: number) =>
    ipcRenderer.invoke("preview:chunk", name, offset, length),
  writeProject: (bytes: ArrayBuffer) => ipcRenderer.invoke("preview:writeProject", bytes),
  writeExport: (name: string, bytes: ArrayBuffer) => ipcRenderer.invoke("export:write", name, bytes),
  captureStill: () => ipcRenderer.invoke("still:capture"),
  // The one way out (STC-293). Composited RGBA in, a file and/or the
  // pasteboard out — the renderer never names a format's encoder, a
  // destination folder or a filename.
  exportStill: (req: Record<string, unknown>) => ipcRenderer.invoke("still:export", req),
  chooseStillDestination: () => ipcRenderer.invoke("still:chooseDestination"),
  clearStillDestination: () => ipcRenderer.invoke("still:clearDestination"),
  // Takes no path: main reveals the file it wrote itself, so the sandboxed
  // renderer never gets to name something outside the recordings folder.
  revealStill: () => ipcRenderer.invoke("still:reveal"),
  readStillFrame: (dir: string, name: string) => ipcRenderer.invoke("still:frame", dir, name),
  start: () => ipcRenderer.invoke("recorder:start"),
  stop: () => ipcRenderer.invoke("recorder:stop"),
  reveal: (dir: string) => ipcRenderer.invoke("recorder:reveal", dir),
  on: (event: string, cb: (payload: any) => void) => {
    const channels = ["helper:ready", "helper:stats", "helper:respawned",
                      "helper:gave-up", "helper:recording-lost", "helper:recording-ended",
                      "helper:warning", "helper:camera-started"];
    if (!channels.includes(event)) throw new Error(`unknown channel: ${event}`);
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
