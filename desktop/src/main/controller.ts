/**
 * The app's brain: one state machine for  record -> upload -> process -> results.
 *
 * It owns no windows and imports no Electron: everything the OS provides arrives through
 * `Host`, so the whole flow can be driven by tests with a fake host, real files and a real
 * HTTP server.
 *
 *   idle -> starting -> recording <-> paused -> finalizing -> ready -> uploading -> processing -> done
 *                          \_______________________________________________/            \-> failed
 */
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { ApiError, ClipsmithApi, isAbortError } from "../shared/api.ts";
import type { JobView } from "../shared/api.ts";
import type { EdlEntry } from "../shared/cutstrip.ts";
import { offEngineInfo } from "../shared/engine.ts";
import type { EngineInfo } from "../shared/engine.ts";
import { RECORDER_CANCELLED, SHORTCUTS } from "../shared/ipc.ts";
import type { AppState, Phase, RecorderConfig, ServerCheck, Settings, SettingsPatch, SourceInfo, StartRequest } from "../shared/ipc.ts";
import { describeFailure, describeJobError } from "../shared/jobs.ts";
import type { FilePart } from "../shared/multipart.ts";
import { contentTypeForExt, extFromMime } from "../shared/session.ts";
import type { SessionMeta } from "../shared/session.ts";
import { downloadFile } from "./download.ts";
import { RecordingSink } from "./recording-sink.ts";
import type { SessionStore } from "./sessions.ts";
import type { SettingsStore } from "./settings.ts";

export { SHORTCUTS };

/** What the operating system has to provide. Implemented with Electron in index.ts, faked in tests. */
export interface Host {
  listSources(): Promise<SourceInfo[]>;
  /** Remember which source the display-media handler should hand to getDisplayMedia(). */
  selectSource(sourceId: string, systemAudio: boolean): void;
  openRecorder(config: RecorderConfig): void;
  commandRecorder(cmd: "pause" | "resume" | "stop"): void;
  closeRecorder(): void;
  setMainWindowVisible(visible: boolean): void;
  registerShortcuts(shortcuts: typeof SHORTCUTS, handlers: { stop: () => void; pause: () => void }): void;
  unregisterShortcuts(): void;
  chooseFolder(): Promise<string | null>;
  reveal(path: string): void;
  screenPermission(): "granted" | "denied" | "unknown";
  askMicrophone(): Promise<boolean>;
}

/** The built-in editing engine, as the controller sees it. BackendManager implements this; tests use a fake. */
export interface Engine {
  info(): EngineInfo;
  /** Base URL when the engine can take jobs right now, otherwise null. */
  url(): string | null;
  onChange(cb: (info: EngineInfo) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
  retry(opts?: { repair?: boolean }): Promise<void>;
}

export interface ControllerDeps {
  sessions: SessionStore;
  settings: SettingsStore;
  host: Host;
  /** Without it the controller always talks to the server address in the settings (engine mode "external"). */
  engine?: Engine;
  /** How long to wait for a restarting engine before a running job is given up on. */
  engineRecoveryMs?: number;
  createApi?: (baseUrl: string) => ClipsmithApi;
  download?: typeof downloadFile;
  now?: () => number;
  countdownSeconds?: number;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}

const RECORDING_PHASES: readonly Phase[] = ["starting", "recording", "paused", "finalizing"];
const RESULT_FILES = /^(main\.mp4|main\.srt|short_\d+\.mp4)$/;

export class Controller {
  private deps: ControllerDeps;
  private s: AppState;
  private listeners = new Set<(s: AppState) => void>();

  private sinkReady: Promise<RecordingSink> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private pendingNote: string | null = null;
  private startWarnings: string | null = null;
  private finishing = false;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private lastProgressEmit = 0;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.s = {
      phase: "idle",
      session: null,
      upload: null,
      job: null,
      edl: null,
      notice: null,
      error: null,
      sessions: [],
      server: { url: "", ok: null, version: null },
      engine: offEngineInfo("external"),
      hasApiKey: false,
      needsProfile: true,
      shortcuts: { ...SHORTCUTS },
    };
  }

  // ---- state -------------------------------------------------------------------------

  getState(): AppState {
    return structuredClone(this.s);
  }

  onState(cb: (s: AppState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.getState());
  }

  /** True when jobs go to the engine the app runs itself, false when to the address in the settings. */
  private managed(): boolean {
    return this.deps.settings.current.engine.mode === "managed" && !!this.deps.engine;
  }

  /** Where jobs go right now; null while the built-in engine is not ready. */
  private target(): string | null {
    return this.managed() ? this.deps.engine!.url() : this.deps.settings.current.serverUrl;
  }

  /** Why a job cannot be sent now, or null when it can. */
  private engineBlock(): string | null {
    if (!this.managed() || this.deps.engine!.url()) return null;
    const info = this.deps.engine!.info();
    if (info.phase === "failed") {
      return `Redigeringsmotorn fungerar inte just nu${info.problem ? ` (${info.problem.title.toLowerCase()})` : ""}. Öppna fliken Motor för att se vad som behöver göras.`;
    }
    return "Redigeringsmotorn håller på att startas. Försök igen om en stund; fliken Motor visar hur långt den kommit.";
  }

  private api(): ClipsmithApi {
    const url = this.target();
    if (!url) throw new Error(this.engineBlock() ?? "Redigeringsmotorn är inte redo.");
    return this.deps.createApi ? this.deps.createApi(url) : new ClipsmithApi({ baseUrl: url });
  }

  /** Copies the engine's state into AppState. In "external" mode the server status comes from checkServer instead. */
  private syncEngine(): void {
    this.s.hasApiKey = this.deps.settings.current.engine.hasApiKey;
    if (!this.managed()) {
      this.s.engine = offEngineInfo("external");
      return;
    }
    const i = this.deps.engine!.info();
    this.s.engine = i;
    this.s.server = { url: i.url ?? "", ok: i.phase === "ready" ? true : i.phase === "failed" ? false : null, version: i.version };
  }

  private async refreshSessions(): Promise<void> {
    this.s.sessions = await this.deps.sessions.list();
  }

  async init(): Promise<void> {
    const settings = await this.deps.settings.load();
    this.s.server.url = settings.serverUrl;
    this.s.needsProfile = settings.preferences === null;
    this.deps.engine?.onChange(() => {
      this.syncEngine();
      this.emit();
    });
    this.syncEngine();
    if (this.managed()) void this.deps.engine!.start();
    const recovered = await this.deps.sessions.recoverOrphans();
    if (recovered.length) this.s.notice = `${recovered.length === 1 ? "En inspelning" : `${recovered.length} inspelningar`} återställdes efter att appen avslutats oväntat.`;
    await this.refreshSessions();
    this.emit();
    if (!this.managed()) void this.checkServer(settings.serverUrl);
  }

  // ---- settings & server -----------------------------------------------------------------

  /** Changing the engine while it is working on a job would kill the job. */
  private assertEngineIdle(): void {
    if (this.s.phase === "uploading" || this.s.phase === "processing") {
      throw new Error("Vänta tills bearbetningen är klar innan du ändrar motorn. Att ändra den startar om den, och då avbryts jobbet.");
    }
  }

  async saveSettings(patch: SettingsPatch): Promise<Settings> {
    const before = this.deps.settings.current;
    if (patch.engine) this.assertEngineIdle();
    const saved = await this.deps.settings.save(patch);
    this.s.needsProfile = saved.preferences === null;

    const engine = this.deps.engine;
    const modeChanged = saved.engine.mode !== before.engine.mode;
    const modelChanged = saved.engine.whisperModel !== before.engine.whisperModel;
    if (engine && modeChanged) {
      if (saved.engine.mode === "managed") void engine.start();
      else await engine.stop();
    } else if (engine && modelChanged && saved.engine.mode === "managed") {
      void engine.retry();
    }

    this.syncEngine();
    if (!this.managed()) {
      this.s.server.url = saved.serverUrl;
      if (saved.serverUrl !== before.serverUrl || modeChanged) {
        this.s.server = { url: saved.serverUrl, ok: null, version: null };
        void this.checkServer(saved.serverUrl);
      }
    }
    this.emit();
    return saved;
  }

  /** Stores (or with null removes) the API key and restarts the engine so it picks the key up. */
  async setApiKey(key: string | null): Promise<Settings> {
    this.assertEngineIdle();
    const saved = await this.deps.settings.setApiKey(key);
    if (this.managed()) void this.deps.engine!.retry();
    this.syncEngine();
    this.emit();
    return saved;
  }

  async retryEngine(repair: boolean): Promise<void> {
    if (!this.managed()) return;
    this.assertEngineIdle();
    void this.deps.engine!.retry({ repair });
  }

  async checkServer(url: string): Promise<ServerCheck> {
    try {
      const api = this.deps.createApi ? this.deps.createApi(url) : new ClipsmithApi({ baseUrl: url });
      const h = await api.health();
      if (!this.managed() && api.baseUrl === this.deps.settings.current.serverUrl) {
        this.s.server = { url: api.baseUrl, ok: h.ok, version: h.version };
        this.emit();
      }
      return { ok: h.ok, version: h.version };
    } catch (e) {
      if (!this.managed() && this.deps.settings.current.serverUrl === url) {
        this.s.server = { url, ok: false, version: null };
        this.emit();
      }
      return { ok: false, error: describeFailure(e) };
    }
  }

  listSources(): Promise<SourceInfo[]> {
    return this.deps.host.listSources();
  }

  // ---- recording -----------------------------------------------------------------------

  async startRecording(req: StartRequest): Promise<void> {
    const { host } = this.deps;
    if (this.s.phase !== "idle") return;
    this.s.error = null;
    this.s.notice = null;

    if (!req.systemAudio && req.micDeviceId === null) {
      this.s.error = "Slå på mikrofon eller systemljud. Utan ljud finns inget tal att redigera.";
      return this.emit();
    }
    if (host.screenPermission() === "denied") {
      this.s.error = "Clipsmith har inte tillåtelse att spela in skärmen. Ge tillåtelse i systeminställningarna och starta om appen.";
      return this.emit();
    }
    if (req.micDeviceId !== null && !(await host.askMicrophone())) {
      this.s.error = "Mikrofonen är blockerad för Clipsmith. Ge tillåtelse i systeminställningarna eller slå av mikrofonen.";
      return this.emit();
    }

    const meta = await this.deps.sessions.create({ sourceName: req.sourceName, now: new Date(this.now()) });
    this.s.session = meta;
    this.s.phase = "starting";
    this.sinkReady = null;
    this.writes = Promise.resolve();
    this.pendingNote = null;
    this.startWarnings = null;
    this.finishing = false;

    host.selectSource(req.sourceId, req.systemAudio);
    host.setMainWindowVisible(false);
    host.openRecorder({ sessionId: meta.id, systemAudio: req.systemAudio, micDeviceId: req.micDeviceId, countdownSeconds: this.deps.countdownSeconds ?? 3, hideControls: req.hideControls });
    this.startTimer = setTimeout(() => void this.onRecorderError("Inspelningen kom aldrig igång."), ((this.deps.countdownSeconds ?? 3) * 1000) + (this.deps.startTimeoutMs ?? 20_000));
    this.emit();
  }

  /** The recorder window picked a container format and is about to deliver chunks. */
  async onRecorderStarted(info: { mimeType: string; warnings?: string[] }): Promise<void> {
    if (this.s.phase !== "starting" || !this.s.session) return;
    if (this.startTimer) clearTimeout(this.startTimer);
    const ext = extFromMime(info.mimeType);
    if (!ext) return void (await this.onRecorderError(`Filformatet ${info.mimeType} stöds inte av servern.`));

    const id = this.s.session.id;
    this.sinkReady = (async () => {
      const meta = await this.deps.sessions.update(id, { mimeType: info.mimeType, ext, state: "recording" });
      this.s.session = meta;
      return RecordingSink.open(this.deps.sessions.filePath(meta)!);
    })();
    try {
      await this.sinkReady;
    } catch (e) {
      return void (await this.onRecorderError(`Kunde inte skapa filen: ${(e as Error).message}`));
    }
    this.deps.host.registerShortcuts(SHORTCUTS, { stop: () => void this.stop(), pause: () => void this.togglePause() });
    this.startWarnings = info.warnings?.length ? info.warnings.join(" ") : null;
    this.s.phase = "recording";
    this.emit();
  }

  /** Chunks must be handed over in order; appends are serialised by the sink and by `writes`. */
  onRecorderChunk(data: Uint8Array): void {
    const ready = this.sinkReady;
    if (!ready) return; // chunk after the session ended or before it started: nothing to write to
    this.writes = this.writes.then(async () => {
      try {
        const sink = await ready;
        await sink.append(data);
        this.s.session = this.s.session && { ...this.s.session, bytes: sink.bytes };
      } catch (e) {
        this.onDiskError(e);
      }
    });
  }

  private onDiskError(e: unknown): void {
    if (this.pendingNote) return;
    this.pendingNote = `Kunde inte skriva till disk (${(e as Error).message}). Inspelningen stoppades; det som hann sparas finns kvar.`;
    this.deps.host.commandRecorder("stop");
  }

  onRecorderState(state: "recording" | "paused"): void {
    if (this.s.phase === "recording" || this.s.phase === "paused") {
      this.s.phase = state;
      this.emit();
    }
  }

  async onRecorderStopped(info: { durationMs: number }): Promise<void> {
    await this.finish(info.durationMs, null);
  }

  async onRecorderError(message: string): Promise<void> {
    if (!RECORDING_PHASES.includes(this.s.phase)) return;
    if (this.s.phase === "starting") {
      // never got going: nothing worth keeping
      if (this.startTimer) clearTimeout(this.startTimer);
      const id = this.s.session?.id;
      this.deps.host.closeRecorder();
      this.deps.host.unregisterShortcuts();
      this.deps.host.setMainWindowVisible(true);
      if (id) await this.deps.sessions.remove(id);
      this.s.session = null;
      this.s.phase = "idle";
      this.s.error = message === RECORDER_CANCELLED ? null : `Inspelningen kunde inte starta: ${message}`;
      await this.refreshSessions();
      return this.emit();
    }
    await this.finish(null, `Inspelningen avbröts: ${message}. Det som hann spelas in är sparat.`);
  }

  private async finish(durationMs: number | null, note: string | null): Promise<void> {
    if (this.finishing || !RECORDING_PHASES.includes(this.s.phase) || !this.s.session) return;
    this.finishing = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.s.phase = "finalizing";
    this.emit();
    const id = this.s.session.id;
    const { host, sessions } = this.deps;

    host.unregisterShortcuts();
    await this.writes;
    let bytes = 0;
    try {
      bytes = this.sinkReady ? await (await this.sinkReady).close() : 0;
    } catch {
      /* the failure was already recorded as pendingNote by onDiskError */
    }
    this.sinkReady = null;
    host.closeRecorder();
    host.setMainWindowVisible(true);

    const finalNote = this.pendingNote ?? note;
    const shownNote = [this.startWarnings, finalNote].filter(Boolean).join(" ") || null;
    if (bytes === 0) {
      await sessions.remove(id);
      this.s.session = null;
      this.s.phase = "failed";
      this.s.error = finalNote ?? "Ingen video sparades. Kontrollera att rätt skärm eller fönster var valt.";
    } else {
      this.s.session = await sessions.update(id, { state: "stopped", durationMs, bytes, note: finalNote });
      this.s.phase = "ready";
      this.s.notice = shownNote;
    }
    await this.refreshSessions();
    this.emit();
  }

  pause(): void {
    if (this.s.phase === "recording") this.deps.host.commandRecorder("pause");
  }
  resume(): void {
    if (this.s.phase === "paused") this.deps.host.commandRecorder("resume");
  }
  togglePause(): void {
    if (this.s.phase === "recording") this.pause();
    else this.resume();
  }
  stop(): void {
    if (this.s.phase === "recording" || this.s.phase === "paused") this.deps.host.commandRecorder("stop");
  }

  /** On quit: ask the recorder to stop and wait (bounded) for the file to be closed properly, then stop the engine. */
  async shutdown(timeoutMs = 8000): Promise<void> {
    if (RECORDING_PHASES.includes(this.s.phase)) {
      this.stop();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        const off = this.onState((s) => RECORDING_PHASES.includes(s.phase) || done());
        function done() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    }
    await this.deps.engine?.stop();
  }

  // ---- upload & processing ------------------------------------------------------------------

  async uploadSession(id: string): Promise<void> {
    if (!["idle", "ready", "failed"].includes(this.s.phase)) return;
    const prefs = this.deps.settings.current.preferences;
    if (!prefs) {
      this.s.error = "Fyll i din profil innan du laddar upp.";
      return this.emit();
    }
    const blocked = this.engineBlock();
    if (blocked) {
      this.s.error = blocked;
      return this.emit();
    }
    const meta = await this.deps.sessions.get(id);
    const path = meta && this.deps.sessions.filePath(meta);
    const size = path ? await stat(path).then((s) => s.size).catch(() => 0) : 0;
    if (!meta || !path || !meta.ext || size === 0) {
      this.s.error = "Inspelningen finns inte kvar på disken.";
      return this.emit();
    }

    this.s.session = meta;
    this.s.job = null;
    this.s.edl = null;
    this.s.error = null;
    this.s.notice = null;
    this.s.phase = "uploading";
    this.s.upload = { sent: 0, total: size };
    const ac = (this.abort = new AbortController());
    this.emit();

    const file: FilePart = {
      fieldName: "video",
      filename: `recording.${meta.ext}`,
      contentType: contentTypeForExt(meta.ext),
      size,
      open: () => createReadStream(path, { highWaterMark: 1 << 20 }),
    };
    try {
      const job = await this.api().createJob(file, prefs, {
        signal: ac.signal,
        onProgress: (sent, total) => {
          this.s.upload = { sent, total };
          const t = this.now();
          if (sent >= total || t - this.lastProgressEmit >= 200) {
            this.lastProgressEmit = t;
            this.emit();
          }
        },
      });
      this.s.session = await this.deps.sessions.update(id, { state: "uploaded", jobId: job.id });
      this.s.job = job;
      await this.refreshSessions();
      await this.follow(job.id, ac.signal);
    } catch (e) {
      this.handleFailure(e);
    } finally {
      if (this.abort === ac) this.abort = null;
      await this.refreshSessions();
      this.emit();
    }
  }

  /** Re-attach to a job that already exists on the server (history list, app restart). */
  async openJob(sessionId: string): Promise<void> {
    if (!["idle", "ready", "failed"].includes(this.s.phase)) return;
    const meta = await this.deps.sessions.get(sessionId);
    if (!meta?.jobId) return;
    const blocked = this.engineBlock();
    if (blocked) {
      this.s.error = blocked;
      return this.emit();
    }
    this.s.session = meta;
    this.s.job = null;
    this.s.edl = null;
    this.s.error = null;
    this.s.notice = null;
    const ac = (this.abort = new AbortController());
    try {
      await this.follow(meta.jobId, ac.signal);
    } catch (e) {
      this.handleFailure(e);
    } finally {
      if (this.abort === ac) this.abort = null;
      this.emit();
    }
  }

  private async follow(jobId: string, signal: AbortSignal): Promise<void> {
    this.s.phase = "processing";
    this.s.upload = null;
    this.emit();
    let final: JobView;
    let api = this.api();
    for (;;) {
      try {
        final = await api.waitForJob(jobId, {
          signal,
          intervalMs: this.deps.pollIntervalMs,
          // Our own engine is on this computer: a few failed polls mean it stopped, not that the network blinked.
          maxConsecutiveErrors: this.managed() ? 3 : undefined,
          onUpdate: (job) => {
            this.s.job = job;
            this.emit();
          },
        });
        break;
      } catch (e) {
        // The built-in engine may have crashed and been restarted on a new port. The job is lost, but the engine
        // marks it as interrupted, so keep following it to show the person what happened instead of a network error.
        if (isAbortError(e) || !(await this.engineCameBack(api.baseUrl, signal))) throw e;
        api = this.api();
      }
    }
    this.s.job = final;
    if (final.status === "failed") {
      this.s.phase = "failed";
      this.s.error = describeJobError(final.error);
      return;
    }
    this.s.edl = await api.getJson<EdlEntry[]>(jobId, "main.edl.json", signal).catch(() => null);
    this.s.phase = "done";
  }

  /** After a lost connection: true if the built-in engine is (again) ready on a different address within the recovery window. */
  private engineCameBack(oldUrl: string, signal: AbortSignal): Promise<boolean> {
    const engine = this.deps.engine;
    if (!this.managed() || !engine) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const settle = (v: boolean) => {
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const check = () => {
        const url = engine.url();
        if (url && url !== oldUrl) settle(true);
        else if (engine.info().phase === "failed") settle(false);
      };
      const onAbort = () => settle(false);
      const timer = setTimeout(() => settle(false), this.deps.engineRecoveryMs ?? 90_000);
      const off = engine.onChange(check);
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  private handleFailure(e: unknown): void {
    this.s.upload = null;
    if (isAbortError(e)) {
      // The user cancelled. A finished upload keeps its server job (reachable from the history list).
      this.s.phase = this.s.session?.jobId ? "idle" : "ready";
      if (this.s.phase === "idle") this.s.session = null;
      return;
    }
    this.s.phase = "failed";
    this.s.error = e instanceof ApiError && e.status === 404 ? "Jobbet finns inte kvar på servern." : describeFailure(e);
  }

  cancel(): void {
    this.abort?.abort();
  }

  // ---- results & housekeeping ---------------------------------------------------------------------

  /** Asks for a folder, downloads the finished files into a new subfolder, reveals it. Returns its path. */
  async saveResults(): Promise<string | null> {
    const job = this.s.job;
    if (this.s.phase !== "done" || !job) return null;
    const dir = await this.deps.host.chooseFolder();
    if (!dir) return null;

    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
    const base = join(dir, `Clipsmith ${stamp}`);
    let target = base;
    for (let i = 2; await stat(target).then(() => true, () => false); i++) target = `${base} (${i})`;
    await mkdir(target, { recursive: true });

    const download = this.deps.download ?? downloadFile;
    try {
      const api = this.api();
      for (const name of job.outputs.filter((n) => RESULT_FILES.test(n))) {
        await download(api.fileUrl(job.id, name), join(target, name));
      }
    } catch (e) {
      this.s.error = `Kunde inte spara filerna: ${describeFailure(e)}`;
      this.emit();
      return null;
    }
    this.deps.host.reveal(target);
    return target;
  }

  async revealSession(id: string): Promise<void> {
    const meta = await this.deps.sessions.get(id);
    const path = meta && this.deps.sessions.filePath(meta);
    if (path) this.deps.host.reveal(path);
  }

  async discardSession(id: string): Promise<void> {
    if (RECORDING_PHASES.includes(this.s.phase) && this.s.session?.id === id) return;
    if (this.s.phase === "uploading" && this.s.session?.id === id) return;
    // The built-in engine keeps results in the app's own folder, where the person cannot see them: remove them together
    // with the recording, or they would pile up for ever. A server the person runs themselves is left alone.
    const meta = await this.deps.sessions.get(id);
    if (meta?.jobId && this.managed() && this.deps.engine!.url()) {
      await this.api().deleteJob(meta.jobId).catch(() => {}); // best effort: 404 means it is already gone
    }
    await this.deps.sessions.remove(id);
    if (this.s.session?.id === id) {
      this.s.session = null;
      if (this.s.phase === "ready" || this.s.phase === "failed") this.s.phase = "idle";
    }
    await this.refreshSessions();
    this.emit();
  }

  newRecording(): void {
    if (RECORDING_PHASES.includes(this.s.phase) || this.s.phase === "uploading" || this.s.phase === "processing") return;
    this.s.phase = "idle";
    this.s.session = null;
    this.s.job = null;
    this.s.edl = null;
    this.s.upload = null;
    this.s.error = null;
    this.s.notice = null;
    this.emit();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
