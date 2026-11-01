/**
 * Gives the engine a Python of its own when the computer has none (or none that works), so nobody has to
 * install Python by hand. Uses the "python-build-standalone" builds (the same ones `uv` downloads): a plain
 * relocatable CPython in one archive, no installer, no registry, no admin rights.
 *
 * What is downloaded is only used after its SHA-256 matches the checksum list published with the release.
 * Nothing here touches the system's Python; the result lives in the engine's own folder.
 *
 * Everything that talks to the outside world (fetch, tar, the interpreter probe) is injectable, so the whole
 * flow is tested against a local server. The real GitHub release layout is NOT verified in this repository's
 * tests (see README): that is why a failure here ends in an explanation and the python.org button, never a crash.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { MIN_PYTHON, PROBE_CODE, WELL_SUPPORTED_MAX_MINOR, defaultProbe, parseProbe } from "./python.ts";
import type { PythonInfo, ProbeFn } from "./python.ts";

/** The Python we ask for. 3.12 has binary wheels for every dependency of the engine on all three systems. */
export const MANAGED_SERIES = "3.12";
export const RELEASES_API = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";
/** Used only when the GitHub API cannot be read (rate limit, proxy). Taken from memory of the project's releases: unverified. */
export const FALLBACK = { tag: "20241016", version: "3.12.7", base: "https://github.com/astral-sh/python-build-standalone/releases/download" } as const;

const TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  // Windows on ARM is left out on purpose: the speech-recognition dependencies have no wheels for it.
};

export function targetTriple(platform: string, arch: string): string | null {
  return TRIPLES[`${platform}-${arch}`] ?? null;
}

export type FetchErrorKind = "unsupported" | "network" | "checksum" | "extract" | "invalid" | "disk" | "aborted";

export class PythonFetchError extends Error {
  readonly kind: FetchErrorKind;
  constructor(kind: FetchErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PythonFetchError";
    this.kind = kind;
  }
}

/** Picks the newest `cpython-3.12.N+DATE-<triple>-install_only.tar.gz` from a list of asset names. */
export function pickAsset(names: string[], triple: string, series: string = MANAGED_SERIES): string | null {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Older Windows builds carry "-shared" in the name; the "install_only" archives have no other variants.
  const re = new RegExp(`^cpython-${esc(series)}\\.(\\d+)\\+\\d+-${esc(triple)}(?:-shared)?-install_only\\.tar\\.gz$`);
  let best: { name: string; patch: number } | null = null;
  for (const name of names) {
    const m = re.exec(name);
    if (m && (!best || Number(m[1]) > best.patch)) best = { name, patch: Number(m[1]) };
  }
  return best?.name ?? null;
}

/** `SHA256SUMS`: one `<hex>  <file name>` per line (the name may start with `*` for binary mode). */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

export type ExtractFn = (archive: string, into: string) => Promise<void>;
export type LogFn = (line: string, replace?: boolean) => void;

export interface FetchDeps {
  /** Folder the engine owns for this; the Python ends up in `<destDir>/python`. */
  destDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  extract?: ExtractFn;
  probe?: ProbeFn;
  log?: LogFn;
  signal?: AbortSignal;
  apiUrl?: string;
  fallbackBase?: string;
  /** No bytes for this long means the connection is dead. */
  stallMs?: number;
}

interface Resolved {
  name: string;
  url: string;
  sha256: string;
}

const isEnospc = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOSPC";
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const tarExtract = (platform: NodeJS.Platform): ExtractFn => (archive, into) =>
  new Promise((resolve, reject) => {
    // On Windows, `tar` on PATH is often Git's GNU tar, which reads "C:\..." as a remote host. System32's bsdtar is the safe one.
    const tar = platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFile(tar, ["-xzf", archive, "-C", into], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve();
      reject(isEnospc(err) || /No space left|not enough space/i.test(String(stderr)) ? new PythonFetchError("disk", String(stderr || err.message)) : new PythonFetchError("extract", `${err.message} ${String(stderr)}`.trim()));
    });
  });

/** Where the interpreter is inside the extracted `python/` folder. */
export const interpreterCandidates = (platform: NodeJS.Platform): string[] =>
  platform === "win32" ? [join("python", "python.exe")] : [join("python", "bin", "python3"), join("python", "bin", "python")];

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function readText(res: Response, what: string): Promise<string> {
  try {
    return await res.text();
  } catch (e) {
    throw new PythonFetchError("network", `${what}: ${messageOf(e)}`, { cause: e });
  }
}

async function get(url: string, d: FetchDeps, init: RequestInit = {}): Promise<Response> {
  const f = d.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { ...init, signal: d.signal });
  } catch (e) {
    if (d.signal?.aborted) throw new PythonFetchError("aborted", "avbruten", { cause: e });
    const cause = (e as { cause?: unknown } | null)?.cause;
    throw new PythonFetchError("network", `${new URL(url).host}: ${messageOf(cause ?? e)}`, { cause: e });
  }
  if (!res.ok) throw new PythonFetchError("network", `${new URL(url).host} svarade ${res.status}`);
  return res;
}

async function resolveViaApi(triple: string, d: FetchDeps): Promise<Resolved> {
  const res = await get(d.apiUrl ?? RELEASES_API, d, { headers: { accept: "application/vnd.github+json", "user-agent": "Clipsmith" } });
  let release: { assets?: { name?: string; browser_download_url?: string; digest?: string }[] };
  try {
    release = JSON.parse(await readText(res, "release")) as typeof release;
  } catch (e) {
    if (e instanceof PythonFetchError) throw e;
    throw new PythonFetchError("invalid", "kunde inte läsa releaselistan");
  }
  const assets = (release.assets ?? []).filter((a): a is { name: string; browser_download_url: string; digest?: string } => typeof a.name === "string" && typeof a.browser_download_url === "string");
  const name = pickAsset(assets.map((a) => a.name), triple);
  if (!name) throw new PythonFetchError("invalid", `ingen Python ${MANAGED_SERIES} för ${triple} i den senaste releasen`);
  const asset = assets.find((a) => a.name === name)!;
  let sha256: string | undefined;
  const sums = assets.find((a) => a.name === "SHA256SUMS");
  if (sums) sha256 = parseSums(await readText(await get(sums.browser_download_url, d), "SHA256SUMS")).get(name);
  if (!sha256 && asset.digest?.startsWith("sha256:")) sha256 = asset.digest.slice(7).toLowerCase();
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new PythonFetchError("checksum", "releasen publicerar ingen kontrollsumma för filen");
  return { name, url: asset.browser_download_url, sha256 };
}

async function resolveViaFallback(triple: string, d: FetchDeps): Promise<Resolved> {
  const base = `${d.fallbackBase ?? FALLBACK.base}/${FALLBACK.tag}`;
  const name = `cpython-${FALLBACK.version}+${FALLBACK.tag}-${triple}-install_only.tar.gz`;
  const sha256 = parseSums(await readText(await get(`${base}/SHA256SUMS`, d), "SHA256SUMS")).get(name);
  if (!sha256) throw new PythonFetchError("checksum", "kontrollsumman för reservfilen saknas");
  return { name, url: `${base}/${encodeURIComponent(name)}`, sha256 };
}

async function download(r: Resolved, to: string, d: FetchDeps): Promise<void> {
  const log = d.log ?? (() => {});
  const stall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new Error("inga data på en minut")), d.stallMs ?? 60_000);
  };
  bump();
  try {
    const signal = d.signal ? AbortSignal.any([d.signal, stall.signal]) : stall.signal;
    const res = await get(r.url, { ...d, signal });
    if (!res.body) throw new PythonFetchError("network", "tomt svar");
    const total = Number(res.headers.get("content-length")) || 0;
    const hash = createHash("sha256");
    let got = 0;
    let lastLogged = 0;
    log(`hämtar ${r.name}${total ? ` (${(total / 1e6).toFixed(0)} MB)` : ""}`);
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        got += chunk.length;
        bump();
        if (got - lastLogged >= 5_000_000) {
          lastLogged = got;
          log(`${(got / 1e6).toFixed(0)}${total ? ` av ${(total / 1e6).toFixed(0)}` : ""} MB`, true);
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), counter, createWriteStream(to), { signal });
    } catch (e) {
      if (d.signal?.aborted) throw new PythonFetchError("aborted", "avbruten", { cause: e });
      if (isEnospc(e)) throw new PythonFetchError("disk", "disken är full", { cause: e });
      throw new PythonFetchError("network", `nedladdningen avbröts: ${messageOf(stall.signal.aborted ? stall.signal.reason : e)}`, { cause: e });
    }
    const actual = hash.digest("hex");
    if (actual !== r.sha256) throw new PythonFetchError("checksum", `kontrollsumman stämmer inte (väntade ${r.sha256.slice(0, 12)}…, fick ${actual.slice(0, 12)}…)`);
    log(`${(got / 1e6).toFixed(0)} MB hämtade, kontrollsumman stämmer`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Probes an interpreter and checks it can build a venv with pip. Returns null if it is not a usable 3.11+. */
async function validate(exe: string, probe: ProbeFn): Promise<PythonInfo | null> {
  const info = parseProbe(await probe(exe, ["-c", PROBE_CODE]));
  if (!info || info.major !== 3 || info.minor < MIN_PYTHON.minor) return null;
  if ((await probe(exe, ["-c", "import venv, ensurepip, ssl, sqlite3"])) === null) return null;
  return { command: exe, prefixArgs: [], ...info, untested: info.minor > WELL_SUPPORTED_MAX_MINOR };
}

/**
 * The app's own Python: reused when already in place and working, otherwise downloaded, verified, unpacked and tried.
 * Throws PythonFetchError (never anything else) so the caller can turn it into an explanation.
 */
export async function ensureManagedPython(d: FetchDeps): Promise<PythonInfo> {
  const platform = d.platform ?? process.platform;
  const arch = d.arch ?? process.arch;
  const probe = d.probe ?? defaultProbe;
  const log = d.log ?? (() => {});
  const marker = join(d.destDir, "runtime.json");

  // Already there?
  try {
    const saved = JSON.parse(await readFile(marker, "utf8")) as { executable?: string };
    if (typeof saved.executable === "string") {
      const info = await validate(join(d.destDir, saved.executable), probe);
      if (info) return info;
      log("den sparade Python-kopian fungerar inte längre, hämtar en ny");
    }
  } catch {
    /* not downloaded yet */
  }

  const triple = targetTriple(platform, arch);
  if (!triple) throw new PythonFetchError("unsupported", `${platform}/${arch} saknar färdig Python`);

  let resolved: Resolved;
  try {
    resolved = await resolveViaApi(triple, d);
  } catch (first) {
    if (first instanceof PythonFetchError && first.kind === "aborted") throw first;
    log(`kunde inte läsa senaste versionen (${messageOf(first)}), provar reservvägen`);
    try {
      resolved = await resolveViaFallback(triple, d);
    } catch (second) {
      throw second instanceof PythonFetchError && second.kind !== "aborted" ? first : second;
    }
  }

  const work = join(d.destDir, "work");
  const archive = join(work, resolved.name);
  try {
    await rm(d.destDir, { recursive: true, force: true });
    await mkdir(join(work, "x"), { recursive: true });
  } catch (e) {
    throw new PythonFetchError(isEnospc(e) ? "disk" : "extract", `kunde inte förbereda ${d.destDir}: ${messageOf(e)}`, { cause: e });
  }
  try {
    await download(resolved, archive, d);
    log("packar upp");
    await (d.extract ?? tarExtract(platform))(archive, join(work, "x"));
    let exe: string | null = null;
    for (const rel of interpreterCandidates(platform)) if (await exists(join(work, "x", rel))) exe = rel;
    if (!exe) throw new PythonFetchError("invalid", "arkivet innehöll ingen Python där den förväntades");
    await rename(join(work, "x", "python"), join(d.destDir, "python"));
    const info = await validate(join(d.destDir, exe), probe);
    if (!info) throw new PythonFetchError("invalid", "den hämtade Python-kopian kunde inte köras (eller saknar venv/pip)");
    await writeFile(marker, JSON.stringify({ executable: exe, version: `${info.major}.${info.minor}.${info.patch}`, asset: resolved.name }));
    log(`Python ${info.major}.${info.minor}.${info.patch} är på plats`);
    return info;
  } catch (e) {
    await rm(d.destDir, { recursive: true, force: true }).catch(() => {});
    throw e instanceof PythonFetchError ? e : new PythonFetchError("extract", messageOf(e), { cause: e });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
