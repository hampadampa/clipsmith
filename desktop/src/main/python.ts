/**
 * Finds a Python the engine can run on. The engine needs 3.11+; 3.14 is accepted last because the
 * speech-recognition wheels (ctranslate2, onnxruntime, PyAV) tend to appear for a new Python later than
 * for the previous ones, so the oldest-supported-first order below is the safe one.
 */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";

export const MIN_PYTHON = { major: 3, minor: 11 } as const;
/** Newest minor we expect binary wheels for. Newer Pythons are tried last and flagged. */
export const WELL_SUPPORTED_MAX_MINOR = 13;

export interface PythonInfo {
  command: string; // what to execute (absolute path when found by searching directories)
  prefixArgs: string[]; // e.g. ["-3.12"] for the Windows `py` launcher
  major: number;
  minor: number;
  patch: number;
  executable: string; // sys.executable as the interpreter reports it
  /** True when newer than the versions we know have wheels for the engine's dependencies. */
  untested: boolean;
}

export interface FindResult {
  python: PythonInfo | null;
  /** Interpreters that were found but are too old, e.g. "3.9.6 (/usr/bin/python3)". For the error message. */
  tooOld: string[];
}

/** Runs `command args...` and returns stdout, or null if it could not be started or failed. */
export type ProbeFn = (command: string, args: string[]) => Promise<string | null>;

export const PROBE_CODE = "import sys; print(sys.version_info[0], sys.version_info[1], sys.version_info[2], sys.executable)";

export const defaultProbe: ProbeFn = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });

interface Candidate {
  command: string;
  prefixArgs: string[];
}

const MINORS = [12, 13, 11, 14]; // preference order, see the header comment

/** Directories GUI apps do not get on macOS (they are launched with a minimal PATH, not the shell's). */
const DARWIN_EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/Library/Frameworks/Python.framework/Versions/Current/bin"];

export function searchDirs(platform: NodeJS.Platform, pathEnv: string | undefined): string[] {
  const fromPath = (pathEnv ?? "").split(delimiter).filter(Boolean);
  const dirs = platform === "darwin" ? [...DARWIN_EXTRA_DIRS, ...fromPath] : fromPath;
  return [...new Set(dirs)];
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstOnPath(names: string[], dirs: string[], skip: (path: string) => boolean): Promise<string | null> {
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name);
      if (skip(full)) continue;
      if (await isExecutable(full)) return full;
    }
  }
  return null;
}

export async function candidateList(platform: NodeJS.Platform, dirs: string[]): Promise<Candidate[]> {
  if (platform === "win32") {
    // The `py` launcher is the reliable way to ask for a specific version; plain `python` may be the Microsoft Store stub.
    const list: Candidate[] = MINORS.map((m) => ({ command: "py", prefixArgs: [`-3.${m}`] }));
    list.push({ command: "py", prefixArgs: ["-3"] }, { command: "python", prefixArgs: [] }, { command: "python3", prefixArgs: [] });
    return list;
  }
  // /usr/bin/python3 on macOS is Apple's stub (3.9, and it can pop up an "install developer tools" dialog when run).
  const skip = (path: string) => platform === "darwin" && path === "/usr/bin/python3";
  const list: Candidate[] = [];
  for (const name of [...MINORS.map((m) => `python3.${m}`), "python3", "python"]) {
    const found = await firstOnPath([name], dirs, skip);
    if (found) list.push({ command: found, prefixArgs: [] });
  }
  return list;
}

export function parseProbe(out: string | null): { major: number; minor: number; patch: number; executable: string } | null {
  const m = /^(\d+) (\d+) (\d+) (.+)$/m.exec((out ?? "").trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), executable: m[4]!.trim() } : null;
}

export async function findPython(opts: { platform?: NodeJS.Platform; pathEnv?: string; probe?: ProbeFn } = {}): Promise<FindResult> {
  const platform = opts.platform ?? process.platform;
  const probe = opts.probe ?? defaultProbe;
  const dirs = searchDirs(platform, opts.pathEnv ?? process.env.PATH);
  const tooOld: string[] = [];
  const seen = new Set<string>();

  for (const c of await candidateList(platform, dirs)) {
    const info = parseProbe(await probe(c.command, [...c.prefixArgs, "-c", PROBE_CODE]));
    if (!info || info.major !== 3) continue;
    if (seen.has(info.executable)) continue; // python3 and python3.12 are often the same file
    seen.add(info.executable);
    if (info.minor < MIN_PYTHON.minor) {
      tooOld.push(`${info.major}.${info.minor}.${info.patch} (${info.executable})`);
      continue;
    }
    return {
      python: { command: c.command, prefixArgs: c.prefixArgs, ...info, untested: info.minor > WELL_SUPPORTED_MAX_MINOR },
      tooOld,
    };
  }
  return { python: null, tooOld };
}
