/**
 * BackendManager against real child processes: the stand-in engine (test/e2e/backend_shim.py, which uses the
 * backend's real JobStore/JobRunner/pipeline), a real venv, real pip and the backend's real system check.
 *
 * What these cannot show: that pip can download the real dependencies (no network here), that FastAPI starts,
 * that faster-whisper loads a model. See the README's list of what is unverified.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { BackendManager, parseCheckReport, stampFor } from "../src/main/backend-manager.ts";
import type { EngineConfig, ManagerDeps } from "../src/main/backend-manager.ts";
import { findPython } from "../src/main/python.ts";
import type { PythonInfo } from "../src/main/python.ts";
import { PythonFetchError } from "../src/main/python-fetch.ts";
import type { EngineInfo, EnginePhase } from "../src/shared/engine.ts";
import { isAlive, waitUntil } from "./support/proc.ts";

const HERE = import.meta.dirname;
const BACKEND = resolve(HERE, "../../backend");
const SHIM = join(HERE, "e2e", "backend_shim.py");
const RUNNER = join(HERE, "support", "orphan-runner.ts");
const OK_CHECK = ["-c", "import json; print(json.dumps({'ok': True, 'checks': []}))"];

let tmp: string;
let managers: BackendManager[] = [];
let pythonExe: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "clipsmith-mgr-"));
  managers = [];
  pythonExe ??= (await findPython()).python!.executable;
});
afterEach(async () => {
  await Promise.all(managers.map((m) => m.stop()));
  await rm(tmp, { recursive: true, force: true });
});

/** An "already installed" engine folder: a venv whose python is the machine's python, plus the stamps setup would leave. */
async function installed(opts: { model?: boolean } = {}): Promise<string> {
  const engineDir = join(tmp, "engine");
  await mkdir(join(engineDir, "venv", "bin"), { recursive: true });
  await symlink(pythonExe, join(engineDir, "venv", "bin", "python"));
  await writeFile(join(engineDir, "setup.json"), stampFor(await readFile(join(BACKEND, "requirements.txt"), "utf8")));
  if (opts.model !== false) {
    await mkdir(join(engineDir, "models"), { recursive: true });
    await writeFile(join(engineDir, "models", "small.ok"), "small");
  }
  return engineDir;
}

const shimServe = (extraEnvArgs: string[] = []) => (port: number, dataDir: string) =>
  [SHIM, "--host", "127.0.0.1", "--port", String(port), "--data-dir", dataDir, "--exit-when-stdin-closes", ...extraEnvArgs];

function make(engineDir: string, over: Partial<ManagerDeps> & { config?: Partial<EngineConfig> } = {}): { m: BackendManager; phases: EnginePhase[]; cfg: EngineConfig } {
  const cfg: EngineConfig = { whisperModel: "small", apiKey: null, ...over.config };
  const { config: _c, ...rest } = over;
  const m = new BackendManager({
    backendDir: BACKEND,
    engineDir,
    getConfig: () => cfg,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CLIPSMITH_SHIM_DEBUG: "1" },
    commands: { check: () => OK_CHECK, serve: shimServe() },
    restartDelaysMs: [10, 10, 10],
    stopGraceMs: 3000,
    startTimeoutMs: 20_000,
    ...rest,
  });
  managers.push(m);
  const phases: EnginePhase[] = [];
  m.onChange((i) => {
    if (phases.at(-1) !== i.phase) phases.push(i.phase);
  });
  return { m, phases, cfg };
}

async function debugEnv(url: string) {
  return (await (await fetch(`${url}/debug/env`)).json()) as Record<string, unknown> & { pid: number; has_api_key: boolean; api_key_length: number };
}

describe("starting and stopping", () => {
  test("an installed engine goes preparing -> starting -> ready, and answers on the URL it reports", async () => {
    const { m, phases } = make(await installed());
    await m.start();
    const info = m.info();
    assert.equal(info.phase, "ready", JSON.stringify(info.problem) + info.log.join("\n"));
    assert.deepEqual(phases, ["preparing", "starting", "ready"], "no install or download step when everything is already in place");
    assert.match(m.url()!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(info.version, "0.1.0");
    const health = (await (await fetch(`${m.url()}/health`)).json()) as { ok: boolean };
    assert.equal(health.ok, true);
  });

  test("start() while ready or while starting does not start a second engine", async () => {
    const { m } = make(await installed());
    const a = m.start();
    const b = m.start();
    await Promise.all([a, b]);
    const pid = (await debugEnv(m.url()!)).pid;
    await m.start();
    assert.equal((await debugEnv(m.url()!)).pid, pid);
  });

  test("the engine gets exactly the environment the app decided on", async () => {
    const engineDir = await installed();
    const bundled = join(tmp, "bundled-bin");
    await mkdir(bundled);
    const { m } = make(engineDir, {
      config: { apiKey: "sk-ant-test-0123456789" },
      toolDirs: [[bundled]],
      env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-LEAKED-FROM-SHELL", PYTHONPATH: "/somewhere/else", CLIPSMITH_SHIM_DEBUG: "1" },
    });
    await m.start();
    const e = await debugEnv(m.url()!);
    assert.equal(e.api_key_length, "sk-ant-test-0123456789".length, "the key from the app, not the one from the shell");
    assert.equal(e.whisper_model, "small");
    assert.equal(e.path_head, bundled, "bundled ffmpeg dir is first on PATH");
    assert.equal(e.hf_home, join(engineDir, "hf"));
    assert.equal(e.data_dir, join(engineDir, "data"));
    assert.ok((e.argv as string[]).includes("--exit-when-stdin-closes"));
  });

  test("without a key in the app, a key in the shell's environment is not passed on", async () => {
    const { m } = make(await installed(), { env: { ...process.env, ANTHROPIC_API_KEY: "sk-ant-LEAKED-FROM-SHELL", CLIPSMITH_SHIM_DEBUG: "1" } });
    await m.start();
    assert.equal((await debugEnv(m.url()!)).has_api_key, false);
  });

  test("the API key never shows up in the log, even if the engine prints it", async () => {
    const key = "sk-ant-secret-0123456789abcdef";
    const wrapper = ["-c", `import os, sys, runpy; print('using ' + os.environ['ANTHROPIC_API_KEY'], flush=True); sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')`];
    const { m } = make(await installed(), {
      config: { apiKey: key },
      commands: { check: () => OK_CHECK, serve: (port, dataDir) => [...wrapper, ...shimServe()(port, dataDir)] },
    });
    await m.start();
    assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
    assert.ok(await waitUntil(() => m.info().log.some((l) => l.includes("using "))), "the line was captured");
    const log = m.info().log.join("\n");
    assert.ok(!log.includes(key));
    assert.match(log, /using \[nyckel\]/);
  });

  test("stop() ends the engine and the URL stops answering", async () => {
    const { m, phases } = make(await installed());
    await m.start();
    const url = m.url()!;
    const { pid } = await debugEnv(url);
    await m.stop();
    assert.equal(m.info().phase, "off");
    assert.equal(m.url(), null);
    assert.ok(await waitUntil(() => !isAlive(pid)));
    await assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }));
    assert.equal(phases.at(-1), "off");
  });

  test("stop() while the engine is still starting abandons the start and leaves nothing running", async () => {
    const { m } = make(await installed(), { env: { ...process.env, CLIPSMITH_SHIM_DEBUG: "1", CLIPSMITH_SHIM_START_DELAY: "30" } });
    const started = m.start();
    assert.ok(await waitUntil(() => m.info().phase === "starting"));
    await m.stop();
    await started; // must settle, not hang
    assert.equal(m.info().phase, "off");
    assert.equal(m.info().problem, null, "being stopped is not a failure");
  });

  test("a restart after stop gives a fresh, working engine", async () => {
    const { m } = make(await installed());
    await m.start();
    const first = (await debugEnv(m.url()!)).pid;
    await m.retry();
    assert.equal(m.info().phase, "ready");
    assert.notEqual((await debugEnv(m.url()!)).pid, first);
  });

  test("changing the key and restarting passes the new key", async () => {
    const { m, cfg } = make(await installed());
    await m.start();
    assert.equal((await debugEnv(m.url()!)).has_api_key, false);
    cfg.apiKey = "sk-ant-new-key-0123456789";
    await m.retry();
    const e = await debugEnv(m.url()!);
    assert.equal(e.has_api_key, true);
    assert.equal(e.api_key_length, cfg.apiKey.length);
  });
});

describe("supervision", () => {
  test("an engine that crashes is restarted on a new port and counted", async () => {
    const { m } = make(await installed());
    await m.start();
    const before = await debugEnv(m.url()!);
    const seen = new Set<EnginePhase>();
    m.onChange((i) => seen.add(i.phase));
    await fetch(`${m.url()}/debug/crash`, { method: "POST" }).catch(() => {});
    assert.ok(await waitUntil(() => m.info().restarts === 1 && m.info().phase === "ready", 15_000), JSON.stringify(m.info()));
    assert.ok(seen.has("starting"), "the UI is told the engine is coming back");
    const after = await debugEnv(m.url()!);
    assert.notEqual(after.pid, before.pid);
    assert.ok(m.info().log.some((l) => /stannade \(kod 7\)/.test(l)), m.info().log.join("\n"));
  });

  test("gives up after repeated quick crashes and says so", async () => {
    let launches = 0;
    const { m } = make(await installed(), {
      commands: {
        check: () => OK_CHECK,
        serve: (port, dataDir) => (++launches === 1 ? shimServe()(port, dataDir) : ["-c", "import sys; print('boom'); sys.exit(9)"]),
      },
    });
    await m.start();
    await fetch(`${m.url()}/debug/crash`, { method: "POST" }).catch(() => {});
    assert.ok(await waitUntil(() => m.info().phase === "failed", 15_000), JSON.stringify(m.info()));
    assert.equal(m.info().problem?.code, "crash-loop");
    assert.equal(m.url(), null);
    assert.equal(launches, 1 + 3, "one good start plus exactly the three allowed restarts");
  });

  test("an exit code 3 (missing Python package) is not retried", async () => {
    let launches = 0;
    const { m } = make(await installed(), { commands: { check: () => OK_CHECK, serve: () => (launches++, ["-c", "import sys; print('Missing Python package: fastapi', file=sys.stderr); sys.exit(3)"]) } });
    await m.start();
    assert.equal(m.info().phase, "failed");
    assert.equal(m.info().problem?.code, "start-failed");
    assert.match(m.info().problem!.title, /paket saknas/);
    assert.equal(launches, 1);
  });

  test("an engine that listens but never reports healthy is killed after the timeout", async () => {
    const { m } = make(await installed(), {
      startTimeoutMs: 800,
      env: { ...process.env, CLIPSMITH_SHIM_DEBUG: "1", CLIPSMITH_SHIM_NEVER_READY: "1" },
    });
    const t0 = Date.now();
    await m.start();
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(m.info().phase, "failed");
    assert.match(m.info().problem!.title, /svarade inte/);
    assert.equal(m.url(), null);
  });

  test("stopping kills the engine's own subprocesses too (an ffmpeg it launched must not outlive it)", { skip: process.platform === "win32" }, async () => {
    const pidFile = join(tmp, "grandchild.pid");
    const script = join(tmp, "engine_with_child.py");
    await writeFile(
      script,
      `import json, subprocess, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[sys.argv.index("--port") + 1])
child = subprocess.Popen(["sleep", "300"])
open(${JSON.stringify(pidFile)}, "w").write(str(child.pid))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"ok": True, "version": "9.9.9"}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(("127.0.0.1", port), H).serve_forever()
`,
    );
    const { m } = make(await installed(), { commands: { check: () => OK_CHECK, serve: (port) => [script, "--port", String(port)] } });
    await m.start();
    assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
    const grandchild = Number(await readFile(pidFile, "utf8"));
    assert.ok(isAlive(grandchild));
    await m.stop();
    assert.ok(await waitUntil(() => !isAlive(grandchild)), "the grandchild survived stop()");
  });

  test("an engine that ignores SIGTERM is killed after the grace period", { skip: process.platform === "win32" }, async () => {
    const script = join(tmp, "stubborn.py");
    await writeFile(
      script,
      `import json, signal, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
signal.signal(signal.SIGTERM, signal.SIG_IGN)
port = int(sys.argv[sys.argv.index("--port") + 1])
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        body = json.dumps({"ok": True, "version": "9.9.9"}).encode()
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(("127.0.0.1", port), H).serve_forever()
`,
    );
    const { m } = make(await installed(), { stopGraceMs: 400, commands: { check: () => OK_CHECK, serve: (port) => [script, "--port", String(port)] } });
    await m.start();
    const t0 = Date.now();
    await m.stop();
    assert.ok(Date.now() - t0 >= 350, "waited for the grace period first");
    assert.ok(Date.now() - t0 < 6000);
    assert.equal(m.info().phase, "off");
  });

  test("when the app process is killed outright, the engine exits on its own", { skip: process.platform === "win32" }, async () => {
    const engineDir = await installed();
    const runner = spawn(process.execPath, [RUNNER, engineDir, BACKEND, SHIM], { stdio: ["ignore", "pipe", "inherit"] });
    let line = "";
    runner.stdout.on("data", (d: Buffer) => (line += String(d)));
    try {
      assert.ok(await waitUntil(() => /READY \d+ /.test(line), 20_000), `runner said: ${line}`);
      const pid = Number(/READY (\d+) /.exec(line)![1]);
      assert.ok(isAlive(pid));
      runner.kill("SIGKILL"); // no clean-up code runs
      assert.ok(await waitUntil(() => !isAlive(pid), 8000), "the engine must notice that its parent is gone");
    } finally {
      runner.kill("SIGKILL");
    }
  });
});

describe("setup", () => {
  test("a missing Python is reported as such, with a download button", async () => {
    const { m } = make(join(tmp, "empty-engine"), { findPython: async () => ({ python: null, tooOld: [] }) });
    await m.start();
    assert.equal(m.info().phase, "failed");
    assert.equal(m.info().problem?.code, "python-missing");
    assert.ok(m.info().problem?.pythonDownload);
  });

  describe("the app's own Python", () => {
    const noPython = async () => ({ python: null, tooOld: [] as string[] });
    /** A throw-away backend with nothing to install, so a real venv and a real pip run offline. */
    async function tinyBackend(): Promise<string> {
      const backend = join(tmp, "backend");
      await mkdir(join(backend, "src"), { recursive: true });
      await writeFile(join(backend, "requirements.txt"), "# nothing to install offline\n");
      return backend;
    }
    const serveWithSources = (port: number, dir: string) => [
      "-c",
      `import sys, runpy; sys.path.insert(0, ${JSON.stringify(join(BACKEND, "src"))}); sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')`,
      ...shimServe()(port, dir),
    ];
    const own = (): PythonInfo => ({ command: pythonExe, prefixArgs: [], major: 3, minor: 12, patch: 0, executable: pythonExe, untested: false });

    test("no Python on the computer: the app fetches its own, builds the venv from it and the engine comes up", async () => {
      const asked: string[] = [];
      const { m, phases } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: noPython,
        fetchPython: async (log) => {
          asked.push("fetch");
          log("hämtar cpython-3.12.0 (50 MB)");
          return own();
        },
        commands: { check: () => OK_CHECK, serve: serveWithSources, prefetch: () => ["-c", "print('ok')"] },
      });
      await m.start();
      const info = m.info();
      assert.equal(info.phase, "ready", JSON.stringify(info.problem) + "\n" + info.log.join("\n"));
      assert.deepEqual(asked, ["fetch"]);
      assert.ok(info.log.includes("python: hämtar cpython-3.12.0 (50 MB)"), "the fetcher's progress reaches the log");
      assert.ok(info.log.some((l) => l.includes("appens egen kopia")));
      assert.deepEqual(phases, ["preparing", "installing", "model", "starting", "ready"]);
    });

    /** A system Python that is newer than the packages exist for (3.14 at the time of writing). */
    const tooNew = (command: string, prefixArgs: string[]): PythonInfo => ({ command, prefixArgs, major: 3, minor: 14, patch: 2, executable: "/usr/bin/python3.14", untested: true });
    const SERVICES = { check: () => OK_CHECK, serve: serveWithSources, prefetch: () => ["-c", "print('ok')"] };

    test("a system Python that is too new is passed over for the app's own copy (the first Windows run failed on onnxruntime)", async () => {
      const asked: string[] = [];
      // If the app wrongly built its venv from this one, the venv step would fail loudly.
      const trap = tooNew(process.execPath, ["-e", "console.error('THE TOO-NEW SYSTEM PYTHON WAS USED'); process.exit(1)", "--"]);
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: async () => ({ python: trap, tooOld: [] }),
        fetchPython: async () => {
          asked.push("fetch");
          return own();
        },
        commands: SERVICES,
      });
      await m.start();
      const info = m.info();
      assert.equal(info.phase, "ready", JSON.stringify(info.problem) + "\n" + info.log.join("\n"));
      assert.deepEqual(asked, ["fetch"]);
      assert.ok(info.log.some((l) => l.includes("3.14.2 är nyare än de versioner som motorns paket finns för")));
      assert.ok(info.log.some((l) => l.includes("appens egen kopia")));
      assert.ok(!info.log.some((l) => l.includes("THE TOO-NEW SYSTEM PYTHON WAS USED")));
    });

    test("...but if the own copy cannot be fetched, the new system Python is used after all instead of giving up", async () => {
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: async () => ({ python: tooNew(pythonExe, []), tooOld: [] }),
        fetchPython: async () => {
          throw new PythonFetchError("network", "api.github.com svarade 403");
        },
        commands: SERVICES,
      });
      await m.start();
      const info = m.info();
      assert.equal(info.phase, "ready", JSON.stringify(info.problem) + "\n" + info.log.join("\n"));
      assert.ok(info.log.some((l) => l.includes("kunde inte hämta en egen Python")));
      assert.ok(info.log.some((l) => l.includes("använder systemets nya Python ändå")));
    });

    test("a new system Python without any way to fetch another one is simply used, as before", async () => {
      const { m } = make(join(tmp, "engine"), { backendDir: await tinyBackend(), findPython: async () => ({ python: tooNew(pythonExe, []), tooOld: [] }), commands: SERVICES });
      await m.start();
      assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
      assert.ok(m.info().log.some((l) => l.includes("om installationen misslyckas, använd Python 3.12")));
    });

    describe("a venv that already exists", () => {
      /** An engine folder whose venv works but claims, in pyvenv.cfg, to come from the given Python version. */
      async function venvFrom(version: string): Promise<string> {
        const engineDir = await installed({ model: true });
        await writeFile(join(engineDir, "venv", "pyvenv.cfg"), `home = /usr/bin\nversion = ${version}\n`);
        return engineDir;
      }

      test("made from a too-new Python and pip has to run again: it is rebuilt from the app's own Python", async () => {
        const engineDir = await venvFrom("3.14.2");
        const asked: string[] = [];
        const { m } = make(engineDir, {
          backendDir: await tinyBackend(), // its requirements differ from the stamp, so pip must run
          findPython: noPython,
          fetchPython: async () => {
            asked.push("fetch");
            return own();
          },
          commands: SERVICES,
        });
        await m.start();
        assert.equal(m.info().phase, "ready", JSON.stringify(m.info().problem) + "\n" + m.info().log.join("\n"));
        assert.deepEqual(asked, ["fetch"], "without this, 'Försök igen' would run pip in the same unusable venv for ever");
        const cfg = await readFile(join(engineDir, "venv", "pyvenv.cfg"), "utf8");
        assert.doesNotMatch(cfg, /version = 3\.14/, "the old venv is gone");
      });

      test("made from a supported Python: pip runs in it and nothing is fetched", async () => {
        const engineDir = await venvFrom("3.12.4");
        const asked: string[] = [];
        const { m } = make(engineDir, {
          backendDir: await tinyBackend(),
          findPython: noPython,
          fetchPython: async () => {
            asked.push("fetch");
            return own();
          },
          commands: SERVICES,
        });
        await m.start();
        assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
        assert.deepEqual(asked, []);
      });

      test("made from a too-new Python but fully installed already: left alone on a normal start", async () => {
        const engineDir = await venvFrom("3.14.2"); // stamp matches the real backend's requirements
        const asked: string[] = [];
        const { m } = make(engineDir, {
          findPython: noPython,
          fetchPython: async () => {
            asked.push("fetch");
            return own();
          },
        });
        await m.start();
        assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
        assert.deepEqual(asked, [], "a working installation is never rebuilt just because its Python is new");
      });
    });

    test("an old system Python counts as no Python", async () => {
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: async () => ({ python: null, tooOld: ["3.9.6 (/usr/bin/python3)"] }),
        fetchPython: async () => own(),
        commands: { check: () => OK_CHECK, serve: serveWithSources, prefetch: () => ["-c", "print('ok')"] },
      });
      await m.start();
      assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
    });

    test("a system Python that cannot make a venv is replaced by the app's own copy", async () => {
      const broken: PythonInfo = { command: process.execPath, prefixArgs: ["-e", "console.error('ensurepip is not available'); process.exit(1)", "--"], major: 3, minor: 12, patch: 0, executable: "/usr/bin/python3", untested: false };
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: async () => ({ python: broken, tooOld: [] }),
        fetchPython: async () => own(),
        commands: { check: () => OK_CHECK, serve: serveWithSources, prefetch: () => ["-c", "print('ok')"] },
      });
      await m.start();
      const info = m.info();
      assert.equal(info.phase, "ready", JSON.stringify(info.problem) + "\n" + info.log.join("\n"));
      assert.ok(info.log.some((l) => l.includes("systemets Python kunde inte skapa en egen miljö")));
    });

    test("system venv failure AND failed download: the venv explanation wins, because it says what to do", async () => {
      const broken: PythonInfo = { command: process.execPath, prefixArgs: ["-e", "console.error('No module named ensurepip'); process.exit(1)", "--"], major: 3, minor: 12, patch: 0, executable: "/usr/bin/python3", untested: false };
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: async () => ({ python: broken, tooOld: [] }),
        fetchPython: async () => {
          throw new PythonFetchError("network", "github.com: getaddrinfo ENOTFOUND");
        },
      });
      await m.start();
      assert.equal(m.info().phase, "failed");
      assert.equal(m.info().problem?.code, "venv-failed");
      assert.match(m.info().problem!.hint, /python3-venv/);
      assert.ok(m.info().log.some((l) => l.includes("kunde inte hämta en egen Python")));
    });

    test("no Python and a failed download: an explanation with a retry and the python.org button, not a crash", async () => {
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: noPython,
        fetchPython: async () => {
          throw new PythonFetchError("network", "api.github.com svarade 403");
        },
      });
      await m.start();
      const p = m.info().problem!;
      assert.equal(m.info().phase, "failed");
      assert.equal(p.code, "python-download-failed");
      assert.match(p.title, /Kunde inte hämta Python/);
      assert.match(p.hint, /internetanslutningen/);
      assert.ok(p.pythonDownload, "the person can still install Python by hand");
      assert.equal(m.url(), null);
    });

    test("every failure kind has its own wording and none of them is empty", async () => {
      const { pythonFetchFailure } = await import("../src/main/engine-problems.ts");
      const titles = new Set<string>();
      for (const kind of ["unsupported", "network", "checksum", "extract", "invalid", "disk", "aborted"] as const) {
        const p = pythonFetchFailure(kind, "detalj");
        assert.equal(p.code, "python-download-failed");
        assert.ok(p.title.length > 5 && p.hint.length > 20, kind);
        titles.add(p.title);
      }
      assert.ok(titles.size >= 5);
    });

    test("stopping while the download runs cancels it and ends 'off', not 'failed'", async () => {
      let sawAbort = false;
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        findPython: noPython,
        fetchPython: (_log, signal) =>
          new Promise((_res, rej) => {
            signal.addEventListener("abort", () => {
              sawAbort = true;
              rej(new PythonFetchError("aborted", "avbruten"));
            });
          }),
      });
      const running = m.start();
      assert.ok(await waitUntil(() => m.info().phase === "installing", 5000));
      await m.stop();
      await running;
      assert.ok(sawAbort, "the download was told to stop");
      assert.equal(m.info().phase, "off");
      assert.equal(m.info().problem, null);
    });

    test("when the system has a working Python the app does not download anything", async () => {
      let fetched = false;
      const { m } = make(join(tmp, "engine"), {
        backendDir: await tinyBackend(),
        fetchPython: async () => {
          fetched = true;
          return own();
        },
        commands: { check: () => OK_CHECK, serve: serveWithSources, prefetch: () => ["-c", "print('ok')"] },
      });
      await m.start();
      assert.equal(m.info().phase, "ready", m.info().log.join("\n"));
      assert.equal(fetched, false);
    });
  });

  test("first run: real venv, real pip, then the model step, then the engine; the second run skips all of that", async () => {
    // A throw-away "backend" whose requirements are empty, so pip has nothing to download. The stand-in engine
    // still needs the real backend sources, so the serve command adds them to sys.path itself.
    const backend = join(tmp, "backend");
    await mkdir(join(backend, "src"), { recursive: true });
    await writeFile(join(backend, "requirements.txt"), "# nothing to install offline\n");
    const engineDir = join(tmp, "engine");
    const prefetched = join(tmp, "prefetch-args.txt");
    const commands: NonNullable<ManagerDeps["commands"]> = {
      check: () => OK_CHECK,
      prefetch: (model) => ["-c", `import sys; open(${JSON.stringify(prefetched)}, 'a').write(sys.argv[1] + '\\n'); print('hämtar')`, model],
      serve: (port, dir) => [
        "-c",
        `import sys, runpy; sys.path.insert(0, ${JSON.stringify(join(BACKEND, "src"))}); sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')`,
        ...shimServe()(port, dir),
      ],
    };
    const env = { ...process.env, ANTHROPIC_API_KEY: "", CLIPSMITH_SHIM_DEBUG: "1" };

    const a = make(engineDir, { backendDir: backend, env, commands });
    await a.m.start();
    assert.equal(a.m.info().phase, "ready", JSON.stringify(a.m.info().problem) + "\n" + a.m.info().log.join("\n"));
    assert.deepEqual(a.phases, ["preparing", "installing", "model", "starting", "ready"]);
    assert.ok(await stat(join(engineDir, "venv", "bin", "python")).then(() => true, () => false), "a real venv was created");
    assert.equal(await readFile(join(engineDir, "setup.json"), "utf8"), stampFor("# nothing to install offline\n"));
    assert.equal((await readFile(prefetched, "utf8")).trim(), "small");
    await a.m.stop();

    const b = make(engineDir, { backendDir: backend, env, commands });
    await b.m.start();
    assert.equal(b.m.info().phase, "ready", b.m.info().log.join("\n"));
    assert.deepEqual(b.phases, ["preparing", "starting", "ready"]);
    assert.equal((await readFile(prefetched, "utf8")).trim(), "small", "the model is not fetched twice");

    // "Repair" forgets the stamp, so pip runs again.
    b.phases.length = 0;
    await b.m.retry({ repair: true });
    assert.equal(b.m.info().phase, "ready", b.m.info().log.join("\n"));
    assert.ok(b.phases.includes("installing"), `phases: ${b.phases.join(",")}`);

    // A changed requirements.txt (an app update) also reinstalls, without recreating the venv.
    await b.m.stop();
    await writeFile(join(backend, "requirements.txt"), "# changed\n");
    const c = make(engineDir, { backendDir: backend, env, commands });
    await c.m.start();
    assert.ok(c.phases.includes("installing"), `phases: ${c.phases.join(",")}`);
    assert.equal(await readFile(join(engineDir, "setup.json"), "utf8"), stampFor("# changed\n"));
  });

  test("a new model triggers a download step even when the engine itself is installed", async () => {
    const engineDir = await installed();
    const script = join(tmp, "prefetch.py");
    const out = join(tmp, "models.txt");
    await writeFile(script, `import sys\nopen(${JSON.stringify(out)}, "a").write(sys.argv[1] + "\\n")\nprint("ok")\n`);
    const { m, cfg, phases } = make(engineDir, {
      commands: { check: () => OK_CHECK, serve: shimServe(), prefetch: (model) => [script, model] },
    });
    await m.start();
    assert.ok(!phases.includes("model"));
    cfg.whisperModel = "medium";
    phases.length = 0;
    await m.retry();
    assert.deepEqual(phases, ["off", "preparing", "model", "starting", "ready"]);
    assert.equal((await readFile(out, "utf8")).trim(), "medium");
    assert.equal((await debugEnv(m.url()!)).whisper_model, "medium");
  });

  test("a failed model download is reported as such and nothing is started", async () => {
    const engineDir = await installed({ model: false });
    const { m } = make(engineDir, { commands: { check: () => OK_CHECK, serve: shimServe(), prefetch: () => ["-c", "import sys; print('Failed to resolve huggingface.co', file=sys.stderr); sys.exit(1)"] } });
    await m.start();
    assert.equal(m.info().phase, "failed");
    assert.equal(m.info().problem?.code, "model-failed");
    assert.match(m.info().problem!.hint, /huggingface\.co/);
    assert.equal(m.url(), null);
    assert.ok(m.info().log.some((l) => l.includes("Failed to resolve")));
  });

  test("real pip without network: the failure is classified as a network problem and shown with its log", async () => {
    const backend = join(tmp, "backend");
    await mkdir(join(backend, "src"), { recursive: true });
    await writeFile(join(backend, "requirements.txt"), "definitely-not-a-real-package-xyz>=1\n");
    const { m } = make(join(tmp, "engine"), { backendDir: backend });
    await m.start();
    const info = m.info();
    assert.equal(info.phase, "failed", info.log.join("\n"));
    assert.equal(info.problem?.code, "install-failed");
    assert.ok(info.log.some((l) => l.startsWith("pip:")), "pip's own output is in the log");
    const stampExists = await stat(join(tmp, "engine", "setup.json")).then(() => true, () => false);
    assert.equal(stampExists, false, "a failed install must not be remembered as done");
    const venvExists = await stat(join(tmp, "engine", "venv")).then(() => true, () => false);
    assert.equal(venvExists, false, "the venv is removed so that the next try starts from the Python choice again");
    // The classification depends on this machine really being offline; on a machine with network the package simply doesn't exist.
    assert.match(info.problem!.title, /Kunde inte hämta|inget färdigt paket/);
  });

  test("the backend's real system check runs in the venv and its findings become a readable problem", async () => {
    // The engine's Python packages (fastapi, faster-whisper) cannot be installed here, so the real check must fail on them.
    const engineDir = await installed();
    const { m } = make(engineDir, { commands: { serve: shimServe() } }); // default check = python -m clipsmith.system
    await m.start();
    const info = m.info();
    const missingHere = await new Promise<boolean>((res) => {
      const p = spawn(pythonExe, ["-c", "import fastapi, faster_whisper"], { stdio: "ignore" });
      p.on("close", (c) => res(c !== 0));
    });
    if (missingHere) {
      assert.equal(info.phase, "failed");
      assert.equal(info.problem?.code, "check-failed");
      assert.match(info.problem!.title, /fastapi|faster-whisper|Taligenkänningen/);
      assert.ok(info.log.some((l) => l.startsWith("kontroll:")));
    } else {
      assert.equal(info.phase, "ready");
    }
  });

  test("the first PATH variant whose ffmpeg passes the check is used; later ones are the fallback", async () => {
    const bundled = join(tmp, "bundled");
    await mkdir(bundled);
    // A check that rejects any ffmpeg found in a directory called "bundled", like a build without libass would be rejected.
    const check = [
      "-c",
      "import json, shutil; p = shutil.which('ffmpeg') or ''; ok = bool(p) and 'bundled' not in p; print(json.dumps({'ok': ok, 'checks': [{'id': 'libass', 'ok': ok, 'required': True, 'detail': p}]}))",
    ];
    await writeFile(join(bundled, "ffmpeg"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const engineDir = await installed();
    const { m } = make(engineDir, { toolDirs: [[bundled], []], commands: { check: () => check, serve: shimServe() } });
    await m.start();
    assert.equal(m.info().phase, "ready", JSON.stringify(m.info().problem) + m.info().log.join("\n"));
    assert.notEqual((await debugEnv(m.url()!)).path_head, bundled, "the engine runs with the variant that passed");

    // And if no variant passes, the problem names what the first one lacked.
    await m.stop();
    const { m: m2 } = make(engineDir, { toolDirs: [[bundled]], commands: { check: () => check, serve: shimServe() } });
    await m2.start();
    assert.equal(m2.info().phase, "failed");
    assert.match(m2.info().problem!.title, /undertexter/);
  });
});

describe("parseCheckReport", () => {
  test("finds the JSON line among other output and rejects garbage", () => {
    assert.deepEqual(parseCheckReport(["warning", '{"ok": true, "checks": []}', "trailing"]), { ok: true, checks: [] });
    assert.equal(parseCheckReport(["{not json", "nothing"]), null);
    assert.equal(parseCheckReport(['{"ok": "yes"}']), null);
  });
});

test("info() reflects phase changes for the UI", async () => {
  const { m } = make(await installed());
  const infos: EngineInfo[] = [];
  m.onChange((i) => infos.push(i));
  await m.start();
  const starting = infos.find((i) => i.phase === "starting")!;
  assert.equal(starting.step, 4);
  assert.match(starting.detail!, /Startar motorn/);
  const ready = infos.at(-1)!;
  assert.equal(ready.phase, "ready");
  assert.equal(ready.step, 0);
  assert.equal(ready.detail, null);
  assert.equal(ready.mode, "managed");
  assert.equal(ready.url, m.url());
});
