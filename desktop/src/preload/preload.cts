/**
 * Preload (sandboxed, CommonJS). Exposes exactly the Bridge on `window.clipsmith` and nothing else:
 * no ipcRenderer, no generic "send anything" function.
 *
 * A sandboxed preload cannot load local modules at runtime, so the channel names are repeated
 * here. `satisfies typeof CHANNELS` makes the compiler reject any name that drifts from
 * shared/ipc.ts.
 */
import type { AppState, Bridge, CHANNELS, RecorderCommand } from "../shared/ipc.ts";

const { contextBridge, ipcRenderer }: typeof import("electron") = require("electron");

const CH = {
  getState: "app:get-state",
  state: "app:state",
  getSettings: "settings:get",
  saveSettings: "settings:save",
  setApiKey: "engine:set-key",
  retryEngine: "engine:retry",
  openPythonDownload: "engine:open-python-download",
  checkServer: "server:check",
  listSources: "sources:list",
  startRecording: "recording:start",
  pauseRecording: "recording:pause",
  resumeRecording: "recording:resume",
  stopRecording: "recording:stop",
  discardSession: "session:discard",
  uploadSession: "session:upload",
  openJob: "session:open-job",
  revealSession: "session:reveal",
  cancel: "job:cancel",
  saveResults: "job:save-results",
  newRecording: "app:new-recording",
  recorderCommand: "recorder:command",
  recorderStarted: "recorder:started",
  recorderState: "recorder:state",
  recorderChunk: "recorder:chunk",
  recorderStopped: "recorder:stopped",
  recorderError: "recorder:error",
} as const satisfies typeof CHANNELS;

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T): void => cb(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge: Bridge = {
  getState: () => ipcRenderer.invoke(CH.getState),
  onState: (cb) => subscribe<AppState>(CH.state, cb),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  saveSettings: (patch) => ipcRenderer.invoke(CH.saveSettings, patch),
  setApiKey: (key) => ipcRenderer.invoke(CH.setApiKey, key),
  retryEngine: (repair) => ipcRenderer.invoke(CH.retryEngine, repair),
  openPythonDownload: () => ipcRenderer.invoke(CH.openPythonDownload),
  checkServer: (url) => ipcRenderer.invoke(CH.checkServer, url),
  listSources: () => ipcRenderer.invoke(CH.listSources),

  startRecording: (req) => ipcRenderer.invoke(CH.startRecording, req),
  pauseRecording: () => ipcRenderer.invoke(CH.pauseRecording),
  resumeRecording: () => ipcRenderer.invoke(CH.resumeRecording),
  stopRecording: () => ipcRenderer.invoke(CH.stopRecording),

  discardSession: (id) => ipcRenderer.invoke(CH.discardSession, id),
  uploadSession: (id) => ipcRenderer.invoke(CH.uploadSession, id),
  openJob: (id) => ipcRenderer.invoke(CH.openJob, id),
  revealSession: (id) => ipcRenderer.invoke(CH.revealSession, id),
  cancel: () => ipcRenderer.invoke(CH.cancel),
  saveResults: () => ipcRenderer.invoke(CH.saveResults),
  newRecording: () => ipcRenderer.invoke(CH.newRecording),

  onRecorderCommand: (cb) => subscribe<RecorderCommand>(CH.recorderCommand, cb),
  recorderStarted: (info) => ipcRenderer.send(CH.recorderStarted, info),
  recorderState: (state) => ipcRenderer.send(CH.recorderState, state),
  recorderChunk: (data) => ipcRenderer.send(CH.recorderChunk, data),
  recorderStopped: (info) => ipcRenderer.send(CH.recorderStopped, info),
  recorderError: (message) => ipcRenderer.send(CH.recorderError, message),
};

contextBridge.exposeInMainWorld("clipsmith", bridge);
