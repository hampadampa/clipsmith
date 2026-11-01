/**
 * Installs, starts, supervises and stops the editing engine (the Python backend), so that opening the
 * app is all a person has to do. Electron-free: everything it needs from the outside arrives through
 * `ManagerDeps`, which lets the tests drive it with real child processes.
 *
 *   find Python -> private venv -> pip install -r requirements.txt -> system check -> download Whisper model
 *   -> spawn `python -m clipsmith.serve --port <free port>` -> poll /health -> ready
 *   engine exits unexpectedly -> restart with back-off, give up after a few quick crashes
 *
 * Every setup step leaves a stamp, so from the second launch on only the last two steps do any work.
 */
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { ENGINE_STEPS, offEngineInfo } from "../shared/engine.ts";
import type { EngineInfo, EnginePhase, EngineProblem, WhisperModel } from "../shared/engine.ts";
import { checkFailure, crashLoop, installFailure, modelFailure, pythonFetchFailure, pythonMissing, startFailure, venvFailure } from "./engine-problems.ts";
import type { CheckEntry } from "./engine-problems.ts";
import { WELL_SUPPORTED_MAX_MINOR, findPython as defaultFindPython } from "./python.ts";
import type { PythonInfo } from "./python.ts";
import { PythonFetchError } from "./python-fetch.ts";
import type { LogFn } from "./python-fetch.ts";
import type { FindResult } from "./python.ts";
import { LineSplitter, LogRing, defaultSpawn, freePort as defaultFreePort, killTree, runCommand } from "./process-utils.ts";
import type { RunResult, SpawnFn } from "./process-utils.ts";

/** Bump when the setup procedure changes in a way that existing installations must redo. */
export const SETUP_VERSION = 1;

/** What `setup.json` holds once the packages in `requirements.txt` are installed. */
export function stampFor(requirementsText: string): string {
  return `v${SETUP_VERSION}:${createHash("sha256").update(requirementsText).digest("hex")}`;
}

export interface EngineConfig {
  whisperModel: WhisperModel;
  apiKey: string | null;
}

export interface Health {
  version: string;
}

export interface ManagerDeps {
  /** Folder with `requirements.txt` and `src/` (the backend). */
  backendDir: string;
  /** Private folder for everything the engine owns: venv, model cache, job data, stamps. */
  engineDir: string;
  getConfig: () => EngineConfig;
  /** PATH prefixes to try in order; the first one whose ffmpeg passes the system check wins. Default: system PATH only. */
  toolDirs?: string[][];
  fontsDir?: string | null;
  findPython?: () => Promise<FindResult>;
  /**
   * A Python of the app's own (downloaded), used when the computer has none, only an old one, or one that cannot make a venv.
   * Without it a missing Python ends in the "install Python" explanation. Must throw PythonFetchError when it fails.
   */
  fetchPython?: (log: LogFn, signal: AbortSignal) => Promise<PythonInfo>;
  spawn?: SpawnFn;
  freePort?: () => Promise<number>;
  fetchHealth?: (baseUrl: string, signal: AbortSignal) => Promise<Health | null>;
  /** Arguments after the venv's python. Overridden in tests. */
  commands?: {
    check?: () => string[];
    prefetch?: (model: string) => string[];
    serve?: (port: number, dataDir: string) => string[];
  };
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  startTimeoutMs?: number;
  stopGraceMs?: number;
  restartDelaysMs?: number[];
  crashWindowMs?: number;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

class SetupProblem extends Error {
  readonly problem: EngineProblem;
  constructor(problem: EngineProblem) {
    super(problem.title);
    this.problem = problem;
  }
}
class Abandoned extends Error {}
class LaunchFailed extends Error {
  readonly exit: ExitInfo;
  readonly tail: string[];
  constructor(exit: ExitInfo, tail: string[]) {
    super("engine exited before it answered");
    this.exit = exit;
    this.tail = tail;
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function defaultFetchHealth(baseUrl: string, signal: AbortSignal): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (!res.ok) return null;
    const body = (await res.json()) as { ok?: unknown; version?: unknown };
    return body.ok === true && typeof body.version === "string" ? { version: body.version } : null; // must be *our* engine
  } catch {
    return null;
  }
}

export class BackendManager {
  private d: ManagerDeps;
  private platform: NodeJS.Platform;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  private phase: EnginePhase = "off";
  private detail: string | null = null;
  private step = 0;
  private problem: EngineProblem | null = null;
  private version: string | null = null;
  private baseUrl: string | null = null;
  private restarts = 0;
  private log = new LogRing(80);

  private gen = 0; // bumped by stop()/retry(): work started under an older generation abandons itself
  private abort = new AbortController(); // cancels a running Python download when the generation changes
  private runPromise: Promise<void> | null = null;
  private child: ChildProcess | null = null;
  private childDone: Promise<unknown> | null = null;
  private stopping = false;
  private crashTimes: number[] = [];
  private toolDirs: string[] = [];

  private listeners = new Set<(i: EngineInfo) => void>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ManagerDeps) {
    this.d = deps;
    this.platform = deps.platform ?? process.platform;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? Date.now;
  }

  // ---- public surface -------------------------------------------------------------------------

  info(): EngineInfo {
    return {
      ...offEngineInfo("managed"),
      phase: this.phase,
      detail: this.detail,
      step: this.step,
      problem: this.problem,
      log: this.log.tail(60),
      restarts: this.restarts,
      version: this.version,
      url: this.baseUrl,
    };
  }

  /** Base URL when the engine can take jobs right now. */
  url(): string | null {
    return this.phase === "ready" ? this.baseUrl : null;
  }

  onChange(cb: (i: EngineInfo) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Starts the engine if it is not running. Resolves when it is ready or has failed (see `info()`). */
  start(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    if (this.phase === "ready") return Promise.resolve();
    const gen = ++this.gen;
    this.restarts = 0;
    this.crashTimes = [];
    const p = this.setupAndLaunch(gen).finally(() => {
      if (this.runPromise === p) this.runPromise = null;
    });
    this.runPromise = p;
    return p;
  }

  /** Stops the engine and anything it is running. Safe to call at any time, including while installing. */
  async stop(): Promise<void> {
    this.gen++;
    this.abort.abort();
    this.abort = new AbortController();
    this.stopping = true;
    this.runPromise = null;
    const child = this.child;
    if (child) await this.terminate(child);
    this.child = null;
    this.childDone = null;
    this.baseUrl = null;
    this.stopping = false;
    this.problem = null;
    this.setPhase("off", 0, null);
  }

  /** Stop, then start again. `repair` also forgets that the packages were installed, so pip runs again. */
  async retry(opts: { repair?: boolean } = {}): Promise<void> {
    await this.stop();
    if (opts.repair) await rm(this.stampFile(), { force: true });
    this.log.clear();
    return this.start();
  }

  // ---- paths ----------------------------------------------------------------------------------

  private venvDir = () => join(this.d.engineDir, "venv");
  private venvPython = () => join(this.venvDir(), this.platform === "win32" ? "Scripts" : "bin", this.platform === "win32" ? "python.exe" : "python");
  private dataDir = () => join(this.d.engineDir, "data");
  private stampFile = () => join(this.d.engineDir, "setup.json");
  private modelStamp = (model: string) => join(this.d.engineDir, "models", `${model.replace(/[^\w.-]/g, "_")}.ok`);
  private requirementsFile = () => join(this.d.backendDir, "requirements.txt");

  // ---- setup ------------------------------------------------------------------------------------

  private async setupAndLaunch(gen: number): Promise<void> {
    try {
      this.problem = null;
      await this.ensureInstalled(gen);
      await this.ensureModel(gen);
      await this.launch(gen).catch((e: unknown) => {
        if (e instanceof LaunchFailed) throw new SetupProblem(startFailure(e.exit.code, e.tail));
        throw e;
      });
    } catch (e) {
      this.handleSetupError(e, gen);
    }
  }

  private handleSetupError(e: unknown, gen: number): void {
    if (e instanceof Abandoned || gen !== this.gen) return;
    if (e instanceof SetupProblem) return this.fail(e.problem);
    this.addLog(`fel: ${e instanceof Error ? e.message : String(e)}`);
    this.fail({ code: "unknown", title: "Något gick fel i motorn", hint: "Se loggen nedan. Försök igen, eller välj Reparera installationen." });
  }

  private guard(gen: number): void {
    if (gen !== this.gen) throw new Abandoned();
  }

  private async ensureInstalled(gen: number): Promise<void> {
    this.setPhase("preparing", 1, "Kontrollerar installationen…");
    await mkdir(this.d.engineDir, { recursive: true });
    const wanted = await this.requirementsStamp();
    const venvOk = await this.venvWorks();
    this.guard(gen);

    // A venv made from a Python that is too new for the packages cannot be repaired by running pip again, so it is
    // rebuilt (from the app's own Python if that can be fetched). Only when pip has to run anyway, never on a normal start.
    const stale = (await this.readStamp()) !== wanted;
    const venvTooNew = venvOk && stale && !!this.d.fetchPython && (await this.venvPythonTooNew());
    if (!venvOk || stale) {
      if (!venvOk || venvTooNew) {
        this.setPhase("preparing", 1, "Letar efter Python…");
        const found = await (this.d.findPython ?? defaultFindPython)();
        this.guard(gen);
        let py = found.python;
        let made: RunResult | null = null;
        let ownCopy = false;
        if (py?.untested && this.d.fetchPython) {
          // The engine's packages (onnxruntime, PyAV, tokenizers) tend to lack wheels for a brand-new Python.
          this.addLog(`python: ${py.major}.${py.minor}.${py.patch} är nyare än de versioner som motorns paket finns för, provar en egen Python i stället`);
          try {
            py = await this.obtainPython(gen, null);
            ownCopy = true;
          } catch (e) {
            if (!(e instanceof SetupProblem)) throw e; // stopped meanwhile (Abandoned) or an unexpected error
            this.addLog("python: den egna Python-kopian gick inte att hämta, använder systemets nya Python ändå");
            py = found.python;
          }
        }
        if (py) {
          if (!ownCopy) {
            this.addLog(`python: ${py.major}.${py.minor}.${py.patch} (${py.executable})`);
            if (py.untested) this.addLog("python: den här versionen är nyare än de som motorns paket är provade med; om installationen misslyckas, använd Python 3.12");
          }
          made = await this.makeVenv(gen, py);
          if (made.code !== 0 && this.d.fetchPython && !ownCopy) {
            this.addLog("python: systemets Python kunde inte skapa en egen miljö, provar en egen kopia av Python");
            py = null;
          }
        }
        if (!py) {
          if (!this.d.fetchPython) throw new SetupProblem(pythonMissing(found.tooOld));
          const earlier = made; // a venv failure on the system's Python explains more than a failed download does
          const own = await this.obtainPython(gen, earlier);
          made = await this.makeVenv(gen, own);
        }
        if (made!.code !== 0) throw new SetupProblem(venvFailure(made!.tail));
      }
      this.setPhase("installing", 2, "Installerar Python-paket. Första gången kan det ta flera minuter…");
      const installed = await this.exec(
        gen,
        this.venvPython(),
        ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", "--retries", "3", "--timeout", "30", "-r", this.requirementsFile()],
        "pip",
      );
      if (installed.code !== 0) {
        // Start over next time: a venv that pip could not fill may be from a Python that cannot work (see venvPythonTooNew),
        // and rebuilding one is cheap because pip keeps its downloads in a cache of its own.
        await rm(this.venvDir(), { recursive: true, force: true });
        throw new SetupProblem(installFailure(installed.tail));
      }
      await writeFile(this.stampFile(), wanted);
    }
    await this.runChecks(gen);
  }

  /** The venv's Python version is in pyvenv.cfg ("version = 3.14.0"). True when it is newer than the versions the engine's packages exist for. */
  private async venvPythonTooNew(): Promise<boolean> {
    try {
      const cfg = await readFile(join(this.venvDir(), "pyvenv.cfg"), "utf8");
      const m = /^version(?:_info)?\s*=\s*(\d+)\.(\d+)/m.exec(cfg);
      return !!m && Number(m[1]) === 3 && Number(m[2]) > WELL_SUPPORTED_MAX_MINOR;
    } catch {
      return false;
    }
  }

  private async makeVenv(gen: number, py: PythonInfo): Promise<RunResult> {
    this.setPhase("installing", 2, "Skapar Pythons egen miljö…");
    await rm(this.venvDir(), { recursive: true, force: true });
    return this.exec(gen, py.command, [...py.prefixArgs, "-m", "venv", this.venvDir()], "venv");
  }

  /** Downloads the app's own Python. If that fails after the system's Python already failed to make a venv, the venv problem is reported instead. */
  private async obtainPython(gen: number, earlier: RunResult | null): Promise<PythonInfo> {
    this.setPhase("installing", 2, earlier ? "Hämtar en egen kopia av Python (en gång, ca 50 MB)…" : "Hittade ingen Python. Hämtar en egen kopia (en gång, ca 50 MB)…");
    try {
      const py = await this.d.fetchPython!((line, replace) => this.addLog(`python: ${line}`, replace), this.abort.signal);
      this.guard(gen);
      this.addLog(`python: ${py.major}.${py.minor}.${py.patch} (appens egen kopia)`);
      return py;
    } catch (e) {
      this.guard(gen); // stopped meanwhile: not a failure
      const err = e instanceof PythonFetchError ? e : new PythonFetchError("invalid", e instanceof Error ? e.message : String(e));
      this.addLog(`python: kunde inte hämta en egen Python (${err.message})`);
      if (earlier) throw new SetupProblem(venvFailure(earlier.tail));
      throw new SetupProblem(pythonFetchFailure(err.kind, err.message));
    }
  }

  private async runChecks(gen: number): Promise<void> {
    const variants = this.d.toolDirs?.length ? this.d.toolDirs : [[]];
    let firstFailures: CheckEntry[] | null = null;
    for (const dirs of variants) {
      const res = await this.exec(gen, this.venvPython(), this.d.commands?.check?.() ?? ["-m", "clipsmith.system"], "kontroll", dirs);
      const report = parseCheckReport(res.tail);
      if (!report) {
        throw new SetupProblem({ code: "check-failed", title: "Kunde inte kontrollera installationen", hint: "Se loggen nedan. Välj Reparera installationen." });
      }
      if (report.ok) {
        this.toolDirs = dirs;
        return;
      }
      firstFailures ??= report.checks.filter((c) => c.required && !c.ok);
    }
    throw new SetupProblem(checkFailure(firstFailures ?? []));
  }

  private async ensureModel(gen: number): Promise<void> {
    const model = this.d.getConfig().whisperModel;
    if (await exists(this.modelStamp(model))) return;
    this.setPhase("model", 3, `Hämtar taligenkänningsmodellen "${model}". Det görs en gång och kan vara flera hundra MB…`);
    const res = await this.exec(gen, this.venvPython(), this.d.commands?.prefetch?.(model) ?? ["-m", "clipsmith.prefetch", "--model", model], "modell");
    if (res.code !== 0) throw new SetupProblem(modelFailure(model, res.tail));
    await mkdir(join(this.d.engineDir, "models"), { recursive: true });
    await writeFile(this.modelStamp(model), model);
  }

  // ---- running the engine -----------------------------------------------------------------------------

  private async launch(gen: number): Promise<void> {
    this.guard(gen);
    this.setPhase("starting", 4, "Startar motorn…");
    const port = await (this.d.freePort ?? defaultFreePort)();
    const url = `http://127.0.0.1:${port}`;
    const dataDir = this.dataDir();
    await mkdir(dataDir, { recursive: true });

    const args = this.d.commands?.serve?.(port, dataDir) ?? [
      "-m", "clipsmith.serve", "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir, "--exit-when-stdin-closes",
    ];
    const spawn = this.d.spawn ?? defaultSpawn;
    const child = spawn(this.venvPython(), args, {
      env: this.childEnv(true, this.toolDirs),
      cwd: this.d.backendDir,
      stdio: ["pipe", "pipe", "pipe"], // stdin stays open: when this process dies the OS closes it and the engine exits too
      detached: this.platform !== "win32",
      windowsHide: true,
    });
    child.stdin?.on("error", () => {});
    this.child = child;

    const tail = new LogRing(40);
    const splitters = [new LineSplitter(), new LineSplitter()];
    const onLine = (line: string, replace: boolean) => {
      tail.add(line, replace);
      this.addLog(`motor: ${line}`, replace);
    };
    [child.stdout, child.stderr].forEach((s, i) => {
      s?.setEncoding("utf8");
      s?.on("data", (d: string) => splitters[i]!.push(d, onLine));
    });
    const exited = new Promise<ExitInfo>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("close", (code, signal) => {
        for (const sp of splitters) sp.flush(onLine);
        resolve({ code, signal, error: null });
      });
    });
    this.childDone = exited;
    const early: { exit: ExitInfo | null } = { exit: null };
    void exited.then((x) => (early.exit = x));

    const ac = new AbortController();
    const deadline = this.now() + (this.d.startTimeoutMs ?? 120_000);
    let health: Health | null = null;
    try {
      while (!health) {
        if (early.exit) throw new LaunchFailed(early.exit, tail.tail());
        this.guard(gen);
        if (this.now() > deadline) {
          await this.terminate(child);
          throw new SetupProblem({ code: "start-failed", title: "Motorn svarade inte", hint: "Den startade men svarade inte inom två minuter. Se loggen nedan och försök igen." });
        }
        health = await (this.d.fetchHealth ?? defaultFetchHealth)(url, ac.signal);
        if (!health) await this.sleep(150);
      }
    } catch (e) {
      ac.abort();
      if (e instanceof Abandoned) await this.terminate(child);
      if (this.child === child) this.child = null;
      throw e;
    }

    this.version = health.version;
    this.baseUrl = url;
    this.setPhase("ready", 0, null);
    void exited.then((x) => this.onEngineExit(child, x, gen));
  }

  private async onEngineExit(child: ChildProcess, exit: ExitInfo, gen: number): Promise<void> {
    if (this.stopping || gen !== this.gen || this.child !== child) return;
    this.child = null;
    this.baseUrl = null;
    let last = exit;
    for (;;) {
      this.addLog(`motor: stannade (${last.error ? last.error.message : `kod ${last.code ?? last.signal}`})`);
      if (last.code === 3) return this.fail(startFailure(3, this.log.tail(20))); // a missing package will not fix itself by restarting

      const t = this.now();
      this.crashTimes = this.crashTimes.filter((x) => t - x < (this.d.crashWindowMs ?? 120_000));
      this.crashTimes.push(t);
      const delays = this.d.restartDelaysMs ?? [1000, 3000, 8000];
      if (this.crashTimes.length > delays.length) return this.fail(crashLoop());

      this.restarts++;
      const delay = delays[this.crashTimes.length - 1]!;
      this.setPhase("starting", 4, `Motorn stannade oväntat. Startar om om ${Math.max(1, Math.round(delay / 1000))} s…`);
      await this.sleep(delay);
      if (gen !== this.gen) return;
      try {
        await this.launch(gen);
        return;
      } catch (e) {
        if (e instanceof LaunchFailed) {
          last = e.exit;
          continue;
        }
        return this.handleSetupError(e, gen);
      }
    }
  }

  // ---- plumbing -------------------------------------------------------------------------------------------

  private childEnv(server: boolean, toolDirs: string[]): NodeJS.ProcessEnv {
    const cfg = this.d.getConfig();
    const env: NodeJS.ProcessEnv = { ...(this.d.env ?? process.env) };
    // The engine must only see what the app decided: a stray key or Python setting from the shell would silently change behaviour.
    for (const k of ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT", "VIRTUAL_ENV", "ANTHROPIC_API_KEY"]) delete env[k];
    const pathKey = this.platform === "win32" ? (Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "Path") : "PATH";
    env[pathKey] = [...toolDirs, env[pathKey]].filter(Boolean).join(delimiter);
    Object.assign(env, {
      PYTHONPATH: join(this.d.backendDir, "src"),
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_NO_INPUT: "1",
      HF_HOME: join(this.d.engineDir, "hf"),
      HF_HUB_DISABLE_TELEMETRY: "1",
      HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      CLIPSMITH_DATA_DIR: this.dataDir(),
      CLIPSMITH_WHISPER_MODEL: cfg.whisperModel,
      // The recording stays on this computer, so the engine's copy of a processed source is just wasted disk.
      CLIPSMITH_DELETE_SOURCE_AFTER: "1",
    });
    if (this.d.fontsDir) env.CLIPSMITH_FONTS_DIR = this.d.fontsDir;
    if (server && cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
    return env;
  }

  /** Runs a setup command to completion, logging its output. Throws Abandoned if stop()/retry() got in the way. */
  private async exec(gen: number, command: string, args: string[], tag: string, toolDirs: string[] = this.toolDirs): Promise<RunResult> {
    this.guard(gen);
    const started: { child: ChildProcess | null } = { child: null };
    const done = runCommand(command, args, {
      env: this.childEnv(false, toolDirs),
      cwd: this.d.backendDir,
      spawn: this.d.spawn,
      platform: this.platform,
      onLine: (line, replace) => this.addLog(`${tag}: ${line}`, replace),
      onChild: (c) => {
        started.child = c;
        this.child = c;
      },
    });
    this.childDone = done;
    const res = await done;
    if (this.child === started.child) this.child = null;
    if (res.error) this.addLog(`${tag}: kunde inte startas (${res.error.message})`);
    this.guard(gen);
    return res;
  }

  private async terminate(child: ChildProcess): Promise<void> {
    const done = this.childDone;
    const grace = this.d.stopGraceMs ?? 5000;
    killTree(child, "SIGTERM", { platform: this.platform, spawn: this.d.spawn });
    if (done && (await settledWithin(done, grace))) return;
    killTree(child, "SIGKILL", { platform: this.platform, spawn: this.d.spawn });
    if (done) await settledWithin(done, 3000);
  }

  private async venvWorks(): Promise<boolean> {
    if (!(await exists(this.venvPython()))) return false;
    const r = await runCommand(this.venvPython(), ["-c", "import sys"], { env: this.childEnv(false, []), spawn: this.d.spawn, platform: this.platform });
    return r.code === 0;
  }

  private async requirementsStamp(): Promise<string> {
    return stampFor(await readFile(this.requirementsFile(), "utf8").catch(() => ""));
  }

  private async readStamp(): Promise<string | null> {
    return readFile(this.stampFile(), "utf8").catch(() => null);
  }

  private fail(problem: EngineProblem): void {
    this.problem = problem;
    this.baseUrl = null;
    this.setPhase("failed", 0, null);
  }

  private setPhase(phase: EnginePhase, step: number, detail: string | null): void {
    this.phase = phase;
    this.step = Math.min(step, ENGINE_STEPS);
    this.detail = detail;
    this.emitNow();
  }

  private addLog(line: string, replace = false): void {
    this.log.add(this.scrub(line), replace);
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => this.emitNow(), 150);
    this.emitTimer.unref?.();
  }

  private scrub(line: string): string {
    const key = this.d.getConfig().apiKey;
    return key && key.length >= 8 ? line.split(key).join("[nyckel]") : line;
  }

  private emitNow(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    const info = this.info();
    for (const l of this.listeners) l(info);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** True if `p` settled before `ms` passed. Uses a real timer on purpose: tests inject a fast `sleep` for back-off, not for kill deadlines. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The check prints one JSON line on stdout; pip-like noise on stderr may surround it. */
export function parseCheckReport(lines: string[]): { ok: boolean; checks: CheckEntry[] } | null {
  for (const line of [...lines].reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as { ok?: unknown; checks?: unknown };
      if (typeof j.ok === "boolean" && Array.isArray(j.checks)) return { ok: j.ok, checks: j.checks as CheckEntry[] };
    } catch {
      /* keep looking */
    }
  }
  return null;
}
