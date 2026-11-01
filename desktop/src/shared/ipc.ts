/**
 * The contract between the windows and the main process.
 *
 * Everything that touches the network or the disk lives in the main process; the renderers
 * only see AppState snapshots and call the Bridge. The sandboxed preload cannot import this
 * file at runtime, so it repeats the channel strings (a test checks they stay in sync).
 */
import type { JobView } from "./api.ts";
import type { EdlEntry } from "./cutstrip.ts";
import type { EngineInfo, EngineSettings, EngineSettingsPatch } from "./engine.ts";
import type { Preferences } from "./preferences.ts";
import type { SessionMeta } from "./session.ts";

export const CHANNELS = {
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
} as const;

export const SHORTCUTS = { stop: "CommandOrControl+Shift+R", pause: "CommandOrControl+Shift+P" } as const;

/** Sent as the recorder's error message when the user cancels during the countdown (not a failure). */
export const RECORDER_CANCELLED = "cancelled";

export type Phase =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "finalizing"
  | "ready" // a finished recording is waiting to be uploaded
  | "uploading"
  | "processing"
  | "done"
  | "failed";

export interface SourceInfo {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string; // data: URL
}

export interface ServerStatus {
  url: string;
  ok: boolean | null; // null = not checked yet
  version: string | null;
}

export interface AppState {
  phase: Phase;
  session: SessionMeta | null;
  upload: { sent: number; total: number } | null;
  job: JobView | null;
  edl: EdlEntry[] | null;
  notice: string | null; // non-fatal, e.g. a recording that ended early but was saved
  error: string | null; // user-facing failure text
  sessions: SessionMeta[]; // history, newest first
  server: ServerStatus;
  engine: EngineInfo; // the built-in editing engine; mode "external" means the person uses their own server instead
  hasApiKey: boolean; // an Anthropic key is stored (the key itself never leaves the main process)
  needsProfile: boolean;
  shortcuts: { stop: string; pause: string };
}

export interface Settings {
  serverUrl: string; // only used in engine mode "external"
  preferences: Preferences | null; // null until onboarding is done
  engine: EngineSettings;
}

export interface SettingsPatch {
  serverUrl?: string;
  preferences?: Preferences | null;
  engine?: EngineSettingsPatch;
}

export interface StartRequest {
  sourceId: string;
  sourceName: string;
  systemAudio: boolean;
  micDeviceId: string | null; // null = microphone off; "" = default device
  /**
   * Hide the floating control bar once recording runs (control with the global shortcuts instead).
   * Electron cannot reliably exclude a window from a full-screen capture, so this is the only way
   * to be sure the bar stays out of the video. Window captures never contain it.
   */
  hideControls: boolean;
}

export interface RecorderConfig {
  sessionId: string;
  systemAudio: boolean;
  micDeviceId: string | null;
  countdownSeconds: number;
  hideControls: boolean;
}

export type RecorderCommand = { type: "start"; config: RecorderConfig } | { type: "pause" } | { type: "resume" } | { type: "stop" };

export interface ServerCheck {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface Bridge {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  getSettings(): Promise<Settings>;
  saveSettings(patch: SettingsPatch): Promise<Settings>;
  /** null removes the key. The key is never sent back to a window. */
  setApiKey(key: string | null): Promise<Settings>;
  /** Stops and starts the built-in engine again; `repair` also reinstalls its Python packages. */
  retryEngine(repair: boolean): Promise<void>;
  openPythonDownload(): Promise<void>;
  checkServer(url: string): Promise<ServerCheck>;
  listSources(): Promise<SourceInfo[]>;

  startRecording(req: StartRequest): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  stopRecording(): Promise<void>;

  discardSession(id: string): Promise<void>;
  uploadSession(id: string): Promise<void>;
  openJob(id: string): Promise<void>;
  revealSession(id: string): Promise<void>;
  cancel(): Promise<void>;
  saveResults(): Promise<string | null>;
  newRecording(): Promise<void>;

  // used by the recorder bar window only
  onRecorderCommand(cb: (cmd: RecorderCommand) => void): () => void;
  recorderStarted(info: { mimeType: string; warnings?: string[] }): void;
  recorderState(state: "recording" | "paused"): void;
  recorderChunk(data: ArrayBuffer): void;
  recorderStopped(info: { durationMs: number }): void;
  recorderError(message: string): void;
}
