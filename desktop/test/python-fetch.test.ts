/**
 * The app's own Python: asset picking, checksums, and the whole download -> verify -> unpack -> try flow against a
 * local HTTP server that imitates GitHub's release layout. The archive is a real .tar.gz made by the system's `tar`
 * whose "python" is a small wrapper around this machine's python, so the real unpack and the real interpreter probe run.
 *
 * What this cannot show: that python-build-standalone's real release has exactly these file names and layout. That is
 * listed as unverified in the README.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { findPython } from "../src/main/python.ts";
import { FALLBACK, PythonFetchError, ensureManagedPython, parseSums, pickAsset, targetTriple } from "../src/main/python-fetch.ts";

const POSIX = process.platform !== "win32";
const TRIPLE = "x86_64-unknown-linux-gnu";
const NAME = (patch: number, date = "20260101") => `cpython-3.12.${patch}+${date}-${TRIPLE}-install_only.tar.gz`;

describe("choosing the file", () => {
  test("picks the newest 3.12 install_only archive for the platform and nothing else", () => {
    const names = [
      NAME(7, "20241016"),
      NAME(12, "20251014"),
      NAME(9, "20250101"),
      `cpython-3.13.1+20260101-${TRIPLE}-install_only.tar.gz`, // other series
      `cpython-3.12.99+20260101-aarch64-apple-darwin-install_only.tar.gz`, // other platform
      `cpython-3.12.99+20260101-${TRIPLE}-debug-full.tar.zst`, // not install_only
      `cpython-3.12.99+20260101-${TRIPLE}-install_only_stripped.tar.gz`, // variant we do not want
      `cpython-3.12.99+20260101-${TRIPLE}-install_only.tar.gz.sha256`, // checksum file
    ];
    assert.equal(pickAsset(names, TRIPLE), NAME(12, "20251014"));
  });

  test("an older Windows name with -shared is accepted; nothing matching gives null", () => {
    assert.equal(pickAsset(["cpython-3.12.3+20240415-x86_64-pc-windows-msvc-shared-install_only.tar.gz"], "x86_64-pc-windows-msvc"), "cpython-3.12.3+20240415-x86_64-pc-windows-msvc-shared-install_only.tar.gz");
    assert.equal(pickAsset([NAME(1)], "aarch64-apple-darwin"), null);
  });

  test("platforms: the five supported ones map to a triple, everything else (Windows on ARM, BSD, ...) does not", () => {
    assert.equal(targetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
    assert.equal(targetTriple("darwin", "arm64"), "aarch64-apple-darwin");
    assert.equal(targetTriple("darwin", "x64"), "x86_64-apple-darwin");
    assert.equal(targetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
    assert.equal(targetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
    assert.equal(targetTriple("win32", "arm64"), null);
    assert.equal(targetTriple("freebsd", "x64"), null);
  });

  test("SHA256SUMS parsing: both separators, binary-mode star, Windows line endings, junk ignored", () => {
    const h = (c: string) => c.repeat(64);
    const map = parseSums(`${h("a")}  one+1.tar.gz\r\n${h("B")} *two.tar.gz\n# comment\nnot a line\n${h("c")}\tthree.tar.gz`);
    assert.equal(map.get("one+1.tar.gz"), h("a"));
    assert.equal(map.get("two.tar.gz"), h("b"), "hex is lower-cased");
    assert.equal(map.get("three.tar.gz"), h("c"));
    assert.equal(map.size, 3);
  });
});

describe("downloading, verifying and unpacking", { skip: !POSIX && "builds a POSIX archive with a shell wrapper" }, () => {
  let tmp: string;
  let server: http.Server;
  let base: string;
  let realPython: string;
  let archive: Buffer;
  let archiveSha: string;
  let hits: string[];
  /** Per-test switches for the fake release server. */
  let mode: { apiStatus?: number; sums?: string | null; body?: () => Buffer; stall?: boolean; slow?: boolean; useDigest?: boolean };

  /** An archive whose python/bin/python3 forwards to the real interpreter, or fails a chosen check. */
  async function makeArchive(wrapper: (real: string) => string, layout = "python/bin/python3"): Promise<Buffer> {
    const dir = await mkdtemp(join(tmp, "arc-"));
    const file = join(dir, "root", layout);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, wrapper(realPython));
    await chmod(file, 0o755);
    const out = join(dir, "a.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", join(dir, "root"), "."]);
    return readFile(out);
  }
  const good = (real: string) => `#!/bin/sh\nexec "${real}" "$@"\n`;

  before(async () => {
    realPython = (await findPython()).python!.executable;
  });

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "clipsmith-fetch-"));
    hits = [];
    mode = {};
    archive = await makeArchive(good);
    archiveSha = createHash("sha256").update(archive).digest("hex");
    server = http.createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url!, "http://x").pathname);
      hits.push(path);
      if (path === "/api") {
        if (mode.apiStatus) return void res.writeHead(mode.apiStatus).end("denied");
        const assets = [{ name: NAME(5), browser_download_url: `${base}/dl/${encodeURIComponent(NAME(5))}`, ...(mode.useDigest ? { digest: `sha256:${archiveSha}` } : {}) }];
        if (!mode.useDigest) assets.push({ name: "SHA256SUMS", browser_download_url: `${base}/dl/SHA256SUMS` } as never);
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ assets }));
      }
      if (path === "/dl/SHA256SUMS" || path === `/fb/${FALLBACK.tag}/SHA256SUMS`) {
        if (mode.sums === null) return void res.writeHead(404).end();
        const name = path.startsWith("/fb") ? `cpython-${FALLBACK.version}+${FALLBACK.tag}-${TRIPLE}-install_only.tar.gz` : NAME(5);
        return void res.writeHead(200).end(mode.sums ?? `${archiveSha}  ${name}\n`);
      }
      if (path.startsWith("/dl/cpython") || path.startsWith(`/fb/${FALLBACK.tag}/cpython`)) {
        const body = mode.body ? mode.body() : archive;
        if (mode.stall) {
          res.writeHead(200, { "content-length": String(body.length) });
          res.write(body.subarray(0, 100));
          return; // never finishes
        }
        if (mode.slow) return void setTimeout(() => res.writeHead(200).end(body), 3000);
        return void res.writeHead(200, { "content-length": String(body.length) }).end(body);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(tmp, { recursive: true, force: true });
  });

  const deps = (over: object = {}) => ({ destDir: join(tmp, "runtime"), platform: "linux" as const, arch: "x64", apiUrl: `${base}/api`, fallbackBase: `${base}/fb`, ...over });
  const fails = async (p: Promise<unknown>): Promise<PythonFetchError> => {
    try {
      await p;
    } catch (e) {
      assert.ok(e instanceof PythonFetchError, `expected PythonFetchError, got ${e}`);
      return e;
    }
    throw new assert.AssertionError({ message: "expected a failure" });
  };

  test("happy path: downloads, checks the checksum, unpacks, tries the interpreter, remembers it, cleans up", async () => {
    const lines: string[] = [];
    const info = await ensureManagedPython(deps({ log: (l: string) => lines.push(l) }));
    assert.equal(info.major, 3);
    assert.ok(info.minor >= 11);
    assert.equal(info.executable, realPython, "the wrapper forwarded to the real interpreter");
    assert.equal(info.command, join(tmp, "runtime", "python", "bin", "python3"));
    assert.deepEqual(info.prefixArgs, []);
    assert.deepEqual(hits.filter((h) => h.startsWith("/dl/cpython")), [`/dl/${NAME(5)}`]);
    assert.ok(lines.some((l) => l.includes("kontrollsumman stämmer")), lines.join("\n"));
    assert.deepEqual((await readdir(join(tmp, "runtime"))).sort(), ["python", "runtime.json"], "no archive or temp folder is left behind");
    assert.equal(JSON.parse(await readFile(join(tmp, "runtime", "runtime.json"), "utf8")).asset, NAME(5));
  });

  test("a second call reuses the copy without any network traffic", async () => {
    await ensureManagedPython(deps());
    hits.length = 0;
    const info = await ensureManagedPython(deps({ apiUrl: "http://127.0.0.1:1/never" }));
    assert.equal(info.command, join(tmp, "runtime", "python", "bin", "python3"));
    assert.deepEqual(hits, []);
  });

  test("a damaged copy is noticed and replaced", async () => {
    await ensureManagedPython(deps());
    await writeFile(join(tmp, "runtime", "python", "bin", "python3"), "#!/bin/sh\nexit 1\n");
    hits.length = 0;
    const info = await ensureManagedPython(deps());
    assert.equal(info.executable, realPython);
    assert.ok(hits.some((h) => h.startsWith("/dl/cpython")), "downloaded again");
  });

  test("the checksum can come from the asset's own digest when no SHA256SUMS file is published", async () => {
    mode.useDigest = true;
    const info = await ensureManagedPython(deps());
    assert.equal(info.executable, realPython);
    assert.ok(!hits.includes("/dl/SHA256SUMS"));
  });

  test("a file that does not match its checksum is refused, and nothing is left on disk", async () => {
    mode.body = () => Buffer.concat([archive, Buffer.from("tampered")]);
    const e = await fails(ensureManagedPython(deps()));
    assert.equal(e.kind, "checksum");
    assert.match(e.message, /kontrollsumman stämmer inte/);
    assert.equal(await stat(join(tmp, "runtime")).then(() => true, () => false), false);
  });

  test("a release without any checksum is refused rather than trusted", async () => {
    mode.sums = null;
    const e = await fails(ensureManagedPython(deps()));
    assert.ok(e.kind === "checksum" || e.kind === "network", e.kind);
    assert.equal(await stat(join(tmp, "runtime", "python")).then(() => true, () => false), false);
  });

  test("GitHub's API refusing (rate limit, proxy) falls back to the fixed release", async () => {
    mode.apiStatus = 403;
    const lines: string[] = [];
    const info = await ensureManagedPython(deps({ log: (l: string) => lines.push(l) }));
    assert.equal(info.executable, realPython);
    assert.ok(lines.some((l) => l.includes("reservvägen")), lines.join("\n"));
    assert.ok(hits.some((h) => h.startsWith(`/fb/${FALLBACK.tag}/cpython`)));
  });

  test("API and fallback both unreachable: a network error that names the first cause", async () => {
    mode.apiStatus = 403;
    const e = await fails(ensureManagedPython(deps({ fallbackBase: `${base}/nothing-here` })));
    assert.equal(e.kind, "network");
    assert.match(e.message, /403/);
  });

  test("nobody listening at all is a network error, not a crash", async () => {
    const e = await fails(ensureManagedPython(deps({ apiUrl: "http://127.0.0.1:1/api", fallbackBase: "http://127.0.0.1:1/fb" })));
    assert.equal(e.kind, "network");
  });

  test("a dead connection (bytes stop arriving) gives up after the stall time", async () => {
    mode.stall = true;
    const started = Date.now();
    const e = await fails(ensureManagedPython(deps({ stallMs: 300 })));
    assert.equal(e.kind, "network");
    assert.match(e.message, /inga data|avbröts/);
    assert.ok(Date.now() - started < 5000);
  });

  test("an abort (the person pressed retry or closed the app) stops the download and reports 'aborted'", async () => {
    mode.slow = true;
    const ac = new AbortController();
    const run = ensureManagedPython(deps({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 300);
    const e = await fails(run);
    assert.equal(e.kind, "aborted");
    assert.equal(await stat(join(tmp, "runtime", "python")).then(() => true, () => false), false);
  });

  test("an unsupported platform is reported before anything is downloaded", async () => {
    const e = await fails(ensureManagedPython(deps({ platform: "win32", arch: "arm64" })));
    assert.equal(e.kind, "unsupported");
    assert.deepEqual(hits, []);
  });

  test("an archive without the interpreter where expected is 'invalid'", async () => {
    archive = await makeArchive(good, "python/somewhere-else/python3");
    archiveSha = createHash("sha256").update(archive).digest("hex");
    const e = await fails(ensureManagedPython(deps()));
    assert.equal(e.kind, "invalid");
  });

  test("an interpreter that cannot make a venv (no ensurepip) is rejected after unpacking, and removed", async () => {
    archive = await makeArchive((real) => `#!/bin/sh\ncase "$2" in *ensurepip*) exit 1;; esac\nexec "${real}" "$@"\n`);
    archiveSha = createHash("sha256").update(archive).digest("hex");
    const e = await fails(ensureManagedPython(deps()));
    assert.equal(e.kind, "invalid");
    assert.match(e.message, /venv|pip/);
    assert.equal(await stat(join(tmp, "runtime")).then(() => true, () => false), false);
  });

  test("a corrupt archive fails in the unpacking step and leaves no half-extracted Python", async () => {
    const junk = Buffer.from("this is not a gzip file at all".repeat(50));
    mode.body = () => junk;
    mode.sums = `${createHash("sha256").update(junk).digest("hex")}  ${NAME(5)}\n`;
    const e = await fails(ensureManagedPython(deps()));
    assert.equal(e.kind, "extract");
    assert.equal(await stat(join(tmp, "runtime", "python")).then(() => true, () => false), false);
  });
});
