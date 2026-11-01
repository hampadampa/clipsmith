/** Small process helpers for the engine manager: line splitting, running a command to completion, killing a process tree. */
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createServer } from "node:net";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

/**
 * Splits a byte stream into lines. A lone "\r" ends a *progress update* (pip, Hugging Face downloads and
 * tqdm redraw one line over and over); the next line then replaces it instead of piling up in the log.
 */
export class LineSplitter {
  private pending = "";
  private crPending = false;
  private replaceNext = false;

  push(chunk: string, emit: (line: string, replace: boolean) => void): void {
    for (const ch of chunk) {
      if (this.crPending) {
        this.crPending = false;
        if (ch === "\n") {
          this.finish(emit, false); // "\r\n": an ordinary line end
          continue;
        }
        this.finish(emit, true); // a lone "\r": the line was a progress update
      }
      if (ch === "\r") this.crPending = true;
      else if (ch === "\n") this.finish(emit, false);
      else this.pending += ch;
    }
  }

  flush(emit: (line: string, replace: boolean) => void): void {
    if (this.crPending) {
      this.crPending = false;
      this.finish(emit, true);
    }
    if (this.pending) this.finish(emit, false);
  }

  private finish(emit: (line: string, replace: boolean) => void, progress: boolean): void {
    const line = this.pending;
    this.pending = "";
    if (line.trim() === "") {
      if (!progress) this.replaceNext = false; // a blank line ends whatever progress display came before
      return;
    }
    emit(line, this.replaceNext);
    this.replaceNext = progress;
  }
}

/** Bounded log of text lines; a progress update replaces the previous line. */
export class LogRing {
  private lines: string[] = [];
  private max: number;
  constructor(max = 80) {
    this.max = max;
  }

  add(line: string, replace = false): void {
    if (replace && this.lines.length) this.lines[this.lines.length - 1] = line;
    else this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  tail(n = this.max): string[] {
    return this.lines.slice(-n);
  }

  clear(): void {
    this.lines = [];
  }
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all (ENOENT, EACCES, ...). */
  error: Error | null;
  /** Last lines of combined output, for classifying failures. */
  tail: string[];
}

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  onLine?: (line: string, replace: boolean) => void;
  /** Called with the child as soon as it exists, so a caller can stop it. */
  onChild?: (child: ChildProcess) => void;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
}

/** Runs a command to completion, feeding every output line to `onLine`. Never rejects. */
export function runCommand(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? defaultSpawn;
  return new Promise((resolve) => {
    const tail = new LogRing(40);
    let settled = false;
    const done = (r: Omit<RunResult, "tail">) => {
      if (settled) return;
      settled = true;
      resolve({ ...r, tail: tail.tail() });
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (e) {
      return done({ code: null, signal: null, error: e instanceof Error ? e : new Error(String(e)) });
    }
    opts.onChild?.(child);
    const splitters = [new LineSplitter(), new LineSplitter()];
    const onLine = (line: string, replace: boolean) => {
      tail.add(line, replace);
      opts.onLine?.(line, replace);
    };
    [child.stdout, child.stderr].forEach((stream, i) => {
      stream?.setEncoding("utf8");
      stream?.on("data", (d: string) => splitters[i]!.push(d, onLine));
    });
    child.once("error", (error) => done({ code: null, signal: null, error }));
    child.once("close", (code, signal) => {
      for (const s of splitters) s.flush(onLine);
      done({ code, signal, error: null });
    });
  });
}

/**
 * Stops a process and everything it started. On POSIX the engine runs in its own process group, so the
 * whole group gets the signal (this is what stops an ffmpeg that the engine launched). On Windows
 * `taskkill /T` walks the tree.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals, opts: { platform?: NodeJS.Platform; spawn?: SpawnFn } = {}): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if ((opts.platform ?? process.platform) === "win32") {
    try {
      (opts.spawn ?? defaultSpawn)("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Asks the OS for a free loopback port. There is a tiny window before the engine binds it; a failed bind just restarts. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}
