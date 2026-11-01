/**
 * Types shared by the main process and the windows for the built-in editing engine
 * ("motorn": the Python backend that the app installs, starts and supervises itself).
 */

export type EngineMode = "managed" | "external";

export const WHISPER_MODELS = [
  { id: "small", label: "Liten", size: "ca 0,5 GB", note: "Snabbast och lättast att köra. Missar fler ord på svenska." },
  { id: "medium", label: "Medel", size: "ca 1,5 GB", note: "Bättre svenska, märkbart långsammare utan grafikkort." },
  { id: "large-v3", label: "Stor", size: "ca 3 GB", note: "Bäst träffsäkerhet. Kräver en kraftfull dator eller ett NVIDIA-grafikkort." },
] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number]["id"];
export const DEFAULT_WHISPER_MODEL: WhisperModel = "small";

export function isWhisperModel(v: unknown): v is WhisperModel {
  return WHISPER_MODELS.some((m) => m.id === v);
}

/** What the person has chosen. The API key itself never leaves the main process: only `hasApiKey` does. */
export interface EngineSettings {
  mode: EngineMode;
  whisperModel: WhisperModel;
  hasApiKey: boolean;
  /** How the key is kept on disk. "plain" = the operating system offers no secure storage, so it is a protected file. */
  keyStorage: "encrypted" | "plain" | "none";
}

export interface EngineSettingsPatch {
  mode?: EngineMode;
  whisperModel?: WhisperModel;
}

/**
 * preparing  – looking for Python / checking an existing installation
 * installing – creating the private Python environment and installing packages
 * model      – downloading the speech-recognition model
 * starting   – launching the engine and waiting for it to answer
 */
export type EnginePhase = "off" | "preparing" | "installing" | "model" | "starting" | "ready" | "failed";

export const ENGINE_STEPS = 4;

export type ProblemCode =
  | "python-missing"
  | "python-too-old"
  | "python-download-failed"
  | "venv-failed"
  | "install-failed"
  | "check-failed"
  | "model-failed"
  | "start-failed"
  | "crash-loop"
  | "unknown";

export interface EngineProblem {
  code: ProblemCode;
  title: string;
  hint: string;
  /** Offer a button that opens the Python download page. */
  pythonDownload?: boolean;
}

export interface EngineInfo {
  mode: EngineMode;
  phase: EnginePhase;
  /** What is happening right now, in plain Swedish. */
  detail: string | null;
  /** 1..ENGINE_STEPS while setting up, 0 otherwise. */
  step: number;
  problem: EngineProblem | null;
  /** Last lines of installer / engine output (secrets removed). */
  log: string[];
  /** Automatic restarts since the engine was last started on purpose. */
  restarts: number;
  version: string | null;
  url: string | null;
}

export function offEngineInfo(mode: EngineMode): EngineInfo {
  return { mode, phase: "off", detail: null, step: 0, problem: null, log: [], restarts: 0, version: null, url: null };
}

export const PYTHON_DOWNLOAD_URL = "https://www.python.org/downloads/";
