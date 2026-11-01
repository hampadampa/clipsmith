import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { checkFailure, installFailure, modelFailure, pythonMissing, startFailure, venvFailure } from "../src/main/engine-problems.ts";
import { LineSplitter, LogRing, freePort, killTree, runCommand } from "../src/main/process-utils.ts";
import { candidateList, findPython, parseProbe, searchDirs } from "../src/main/python.ts";
import { isAlive, waitUntil } from "./support/proc.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "clipsmith-parts-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const collect = (chunks: string[]) => {
  const sp = new LineSplitter();
  const out: Array<[string, boolean]> = [];
  const emit = (l: string, r: boolean) => out.push([l, r]);
  for (const c of chunks) sp.push(c, emit);
  sp.flush(emit);
  return out;
};

describe("LineSplitter", () => {
  test("splits on \\n and \\r\\n and keeps a partial line until it ends", () => {
    assert.deepEqual(collect(["a\nb\r\nc"]), [["a", false], ["b", false], ["c", false]]);
    assert.deepEqual(collect(["hel", "lo\nwor", "ld\n"]), [["hello", false], ["world", false]]);
  });

  test("\\r\\n split across two chunks is still one ordinary line end", () => {
    assert.deepEqual(collect(["a\r", "\nb\n"]), [["a", false], ["b", false]]);
  });

  test("a lone \\r marks a progress line that the next line replaces", () => {
    assert.deepEqual(collect(["10%\r20%\r30%\rdone\nnext\n"]), [["10%", false], ["20%", true], ["30%", true], ["done", true], ["next", false]]);
  });

  test("blank lines are dropped and end a progress run", () => {
    assert.deepEqual(collect(["10%\r\n\nafter\n"]), [["10%", false], ["after", false]]);
  });

  test("handles multi-byte characters", () => {
    assert.deepEqual(collect(["Hämtar modellen… ✓\n"]), [["Hämtar modellen… ✓", false]]);
  });
});

describe("LogRing", () => {
  test("is bounded and replaces the last line for progress updates", () => {
    const r = new LogRing(3);
    for (const l of ["a", "b", "c", "d"]) r.add(l);
    assert.deepEqual(r.tail(), ["b", "c", "d"]);
    r.add("d 50%", true);
    assert.deepEqual(r.tail(), ["b", "c", "d 50%"]);
    assert.deepEqual(r.tail(2), ["c", "d 50%"]);
    r.clear();
    assert.deepEqual(r.tail(), []);
  });
});

describe("runCommand / killTree / freePort", () => {
  test("captures stdout and stderr lines and the exit code", async () => {
    const lines: string[] = [];
    const r = await runCommand(process.execPath, ["-e", "console.log('ut'); console.error('fel'); process.exit(4)"], { env: process.env, onLine: (l) => lines.push(l) });
    assert.equal(r.code, 4);
    assert.deepEqual(lines.sort(), ["fel", "ut"]);
    assert.deepEqual(r.tail.sort(), ["fel", "ut"]);
  });

  test("a command that cannot be started reports an error instead of throwing", async () => {
    const r = await runCommand(join(tmp, "finns-inte"), [], { env: process.env });
    assert.ok(r.error);
    assert.equal(r.code, null);
  });

  test("killTree stops the whole process group, including grandchildren", { skip: process.platform === "win32" }, async () => {
    const script = join(tmp, "tree.mjs");
    await writeFile(
      script,
      `import { spawn } from "node:child_process";
       const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
       console.log("GRANDCHILD " + g.pid);
       setInterval(()=>{},1000);`,
    );
    let grand = 0;
    let child: import("node:child_process").ChildProcess | null = null;
    const done = runCommand(process.execPath, [script], {
      env: process.env,
      onChild: (c) => (child = c),
      onLine: (l) => {
        const m = /GRANDCHILD (\d+)/.exec(l);
        if (m) grand = Number(m[1]);
      },
    });
    for (let i = 0; i < 100 && !grand; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(grand > 0, "grandchild pid was printed");
    assert.ok(isAlive(grand));
    killTree(child!, "SIGKILL");
    const res = await done;
    assert.equal(res.signal, "SIGKILL");
    assert.ok(await waitUntil(() => !isAlive(grand)), "the grandchild must die with its parent's group");
  });

  test("killTree on an already finished child is a no-op", async () => {
    let c: import("node:child_process").ChildProcess | null = null;
    await runCommand(process.execPath, ["-e", "0"], { env: process.env, onChild: (x) => (c = x) });
    assert.doesNotThrow(() => killTree(c!, "SIGKILL"));
  });

  test("freePort returns a port nobody is listening on yet", async () => {
    const port = await freePort();
    assert.ok(port > 1023 && port < 65536);
    await new Promise<void>((resolve, reject) => {
      const s = createServer().once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  });
});

describe("python discovery", () => {
  const probeFrom = (table: Record<string, string | null>) => async (command: string, args: string[]) => table[`${command} ${args.filter((a) => a !== "-c" && !a.startsWith("import")).join(" ")}`.trim()] ?? null;

  test("parseProbe reads the version line and tolerates noise", () => {
    assert.deepEqual(parseProbe("3 12 4 /usr/bin/python3.12\n"), { major: 3, minor: 12, patch: 4, executable: "/usr/bin/python3.12" });
    assert.deepEqual(parseProbe("warning: x\n3 11 0 C:\\Python311\\python.exe"), { major: 3, minor: 11, patch: 0, executable: "C:\\Python311\\python.exe" });
    assert.equal(parseProbe("Python 3.12"), null);
    assert.equal(parseProbe(null), null);
  });

  test("on macOS Homebrew's folders are searched even though the app inherited a minimal PATH", () => {
    const dirs = searchDirs("darwin", "/usr/bin:/bin");
    assert.ok(dirs.includes("/opt/homebrew/bin") && dirs.includes("/usr/local/bin"));
    assert.deepEqual(searchDirs("linux", "/a:/b:/a"), ["/a", "/b"]);
  });

  test("Windows asks the py launcher for specific versions before the generic names", async () => {
    const list = await candidateList("win32", []);
    assert.deepEqual(list[0], { command: "py", prefixArgs: ["-3.12"] });
    assert.deepEqual(list.at(-1), { command: "python3", prefixArgs: [] });
    assert.ok(list.some((c) => c.command === "python" && c.prefixArgs.length === 0));
  });

  test("prefers 3.12, then 3.13, then 3.11, and accepts the newest last (flagged)", async () => {
    const bin = join(tmp, "bin");
    await Promise.all(
      ["python3.11", "python3.12", "python3.13", "python3.14", "python3"].map(async (n) => {
        await writeFile(join(tmp, n), "#!/bin/sh\n");
        await chmod(join(tmp, n), 0o755);
      }),
    );
    void bin;
    const versions: Record<string, string> = {
      [join(tmp, "python3.11")]: `3 11 9 ${join(tmp, "python3.11")}`,
      [join(tmp, "python3.12")]: `3 12 7 ${join(tmp, "python3.12")}`,
      [join(tmp, "python3.13")]: `3 13 1 ${join(tmp, "python3.13")}`,
      [join(tmp, "python3.14")]: `3 14 0 ${join(tmp, "python3.14")}`,
      [join(tmp, "python3")]: `3 14 0 ${join(tmp, "python3.14")}`,
    };
    const probe = async (command: string) => versions[command] ?? null;
    const all = await findPython({ platform: "linux", pathEnv: tmp, probe });
    assert.equal(all.python?.minor, 12);
    assert.equal(all.python?.untested, false);

    delete versions[join(tmp, "python3.12")];
    assert.equal((await findPython({ platform: "linux", pathEnv: tmp, probe })).python?.minor, 13);

    delete versions[join(tmp, "python3.13")];
    assert.equal((await findPython({ platform: "linux", pathEnv: tmp, probe })).python?.minor, 11);

    delete versions[join(tmp, "python3.11")];
    const newest = await findPython({ platform: "linux", pathEnv: tmp, probe });
    assert.equal(newest.python?.minor, 14);
    assert.equal(newest.python?.untested, true);
  });

  test("reports interpreters that are too old, once each, and returns no python", async () => {
    await writeFile(join(tmp, "python3"), "#!/bin/sh\n");
    await chmod(join(tmp, "python3"), 0o755);
    await symlink(join(tmp, "python3"), join(tmp, "python"));
    const probe = async (command: string) => (command.endsWith("python3") || command.endsWith("python") ? `3 9 6 /usr/bin/python3` : null);
    const r = await findPython({ platform: "linux", pathEnv: tmp, probe });
    assert.equal(r.python, null);
    assert.deepEqual(r.tooOld, ["3.9.6 (/usr/bin/python3)"]);
    assert.match(pythonMissing(r.tooOld).hint, /3\.9\.6/);
    assert.equal(pythonMissing(r.tooOld).code, "python-too-old");
    assert.equal(pythonMissing([]).code, "python-missing");
    assert.ok(pythonMissing([]).pythonDownload);
  });

  test("macOS: Apple's /usr/bin/python3 stub is never executed", async () => {
    const probed: string[] = [];
    await findPython({ platform: "darwin", pathEnv: "/usr/bin", probe: async (c) => (probed.push(c), null) });
    assert.ok(!probed.includes("/usr/bin/python3"));
  });

  test("finds the python of this machine for real", async () => {
    const r = await findPython();
    assert.ok(r.python, "a Python 3.11+ is needed to run the engine, and the test machine has one");
    assert.ok(r.python.minor >= 11);
  });
});

describe("problem wording", () => {
  const sandboxPip = [
    "WARNING: Retrying (Retry(total=0)) after connection broken by 'NameResolutionError(\"HTTPSConnection(host='pypi.org', port=443): Failed to resolve 'pypi.org' ([Errno -2] Name or service not known)\")': /simple/fastapi/",
    "ERROR: Could not find a version that satisfies the requirement fastapi (from versions: none)",
    "ERROR: No matching distribution found for fastapi",
  ];

  test("a real offline pip run is described as a network problem, not a Python-version problem", () => {
    const p = installFailure(sandboxPip);
    assert.equal(p.code, "install-failed");
    assert.match(p.title, /Kunde inte hämta/);
    assert.match(p.hint, /internetanslutningen/);
    assert.ok(!p.pythonDownload);
  });

  test("no distribution without any network error points at the Python version", () => {
    const p = installFailure(["ERROR: Could not find a version that satisfies the requirement ctranslate2 (from versions: none)", "ERROR: No matching distribution found for ctranslate2"]);
    assert.match(p.title, /inget färdigt paket/);
    assert.ok(p.pythonDownload);
  });

  test("the pip failure from the first real Windows run (onnxruntime has no wheel for Python 3.14) is recognised", () => {
    // Taken from the engine log on a Windows machine. It says "no matching distributions", not "No matching distribution",
    // and its last line is ResolutionImpossible, so the older patterns missed it and showed only a generic message.
    const windowsLog = [
      "pip: INFO: This is taking longer than usual. You might need to provide the dependency resolver with stricter constraints to reduce runtime. See https://pip.pypa.io/warnings/backtracking for guidance. If you want to abort this run, press Ctrl + C.",
      "pip: ERROR: Cannot install -r C:\\Users\\x\\resources\\backend\\requirements.txt (line 7) because these package versions have conflicting dependencies.",
      "pip: The conflict is caused by:",
      "pip:     faster-whisper 1.2.1 depends on onnxruntime<2 and >=1.14",
      "pip: Additionally, some packages in these conflicts have no matching distributions available for your environment:",
      "pip:     onnxruntime",
      "pip: ERROR: ResolutionImpossible: for help visit https://pip.pypa.io/en/latest/topics/dependency-resolution/#dealing-with-dependency-conflicts",
    ];
    const p = installFailure(windowsLog);
    assert.match(p.title, /inget färdigt paket/);
    assert.match(p.hint, /Python 3\.12/);
    assert.match(p.hint, /Försök igen/);
    assert.ok(p.pythonDownload);
  });

  test("disk full, permissions and build failures", () => {
    assert.match(installFailure(["OSError: [Errno 28] No space left on device"]).title, /Disken är full/);
    assert.match(installFailure(["PermissionError: [Errno 13] Permission denied: '/x'"]).title, /behörighet/);
    assert.match(installFailure(["error: Microsoft Visual C++ 14.0 or greater is required", "Failed building wheel for av"]).title, /inget färdigt paket/);
    assert.match(installFailure(["something odd"]).title, /misslyckades/);
  });

  test("venv failure recognises the Debian/Ubuntu case", () => {
    const p = venvFailure(["The virtual environment was not created successfully because ensurepip is not", "available.  On Debian/Ubuntu systems, you need to install the python3-venv"]);
    assert.match(p.hint, /python3-venv/);
    assert.match(venvFailure(["boom"]).title, /Kunde inte skapa/);
  });

  test("check failures name the first problem and count the rest", () => {
    const p = checkFailure([
      { id: "libass", ok: false, required: true, detail: "x" },
      { id: "fastapi", ok: false, required: true, detail: "x" },
    ]);
    assert.match(p.title, /undertexter.*\(och 1 till\)/);
    assert.match(checkFailure([{ id: "mystery", ok: false, required: true, detail: "" }]).title, /klarar inte/);
    assert.match(checkFailure([]).title, /klarar inte/);
  });

  test("model and start failures", () => {
    assert.match(modelFailure("small", ["Failed to resolve 'huggingface.co'"]).hint, /huggingface\.co/);
    assert.match(modelFailure("small", ["???"]).title, /kunde inte hämtas/);
    assert.match(startFailure(3, []).title, /paket saknas/);
    assert.match(startFailure(1, ["OSError: [Errno 98] Address already in use"]).title, /Porten/);
    assert.match(startFailure(1, ["Traceback"]).title, /startade inte/);
  });
});
