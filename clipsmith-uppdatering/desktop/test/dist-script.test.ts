/**
 * scripts/dist.mjs och scripts/start.mjs: varje steg startas för sig och ett misslyckat steg stoppar allt.
 *
 * Skripten kopieras till en tillfällig mapp med låtsas-steg (build.mjs, verify-package.mjs, ett falskt
 * electron-builder- och electron-paket) som bara skriver upp att de kördes. Det som prövas är skriptens beslut: ordning,
 * att inget steg hoppas över, att felkoder stoppar, att flaggor från npm når electron-builder. Att den riktiga
 * electron-builder tar emot flaggorna har jag inte kunnat pröva här.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

let tmp: string;
let n = 0;

/** A recording step: appends "<name> <args>" to calls.log and exits with the code in env var FAIL_<NAME>. */
const recorder = (name: string) => `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(join(process.cwd(), "calls.log"), ${JSON.stringify(name)} + " " + process.argv.slice(2).join(" ") + "\\n");
console.log("[${name}] ran");
process.exit(Number(process.env.FAIL_${name.toUpperCase()} ?? 0));
`;

interface Options {
  withBuilder?: boolean;
  withElectron?: boolean;
}

function project(o: Options = {}): string {
  const dir = join(tmp, `p${++n}`);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of ["dist.mjs", "start.mjs"]) cpSync(join(scriptsDir, f), join(dir, "scripts", f));
  writeFileSync(join(dir, "scripts", "build.mjs"), recorder("build"));
  writeFileSync(join(dir, "scripts", "verify-package.mjs"), recorder("verify"));
  writeFileSync(join(dir, "package.json"), '{"type":"module","main":"app.mjs"}');
  writeFileSync(join(dir, "app.mjs"), recorder("app"));
  if (o.withBuilder !== false) {
    mkdirSync(join(dir, "node_modules", "electron-builder"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "electron-builder", "package.json"), '{"name":"electron-builder","bin":{"electron-builder":"cli.js"}}');
    writeFileSync(join(dir, "node_modules", "electron-builder", "cli.js"), recorder("builder"));
  }
  if (o.withElectron !== false) {
    mkdirSync(join(dir, "node_modules", "electron"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "electron", "package.json"), '{"name":"electron","main":"index.js"}');
    // The real package exports the path of the electron program. Here the "program" is node itself, started as `node .`.
    writeFileSync(join(dir, "node_modules", "electron", "index.js"), `module.exports = ${JSON.stringify(process.execPath)};`);
  }
  return dir;
}

function run(dir: string, script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(dir, "scripts", script), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").map((l) => l.trim());
  } catch {
    // nothing was run
  }
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, calls };
}

describe("scripts/dist.mjs", () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "clipsmith-dist-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test("runs build, electron-builder and the package check, in that order, and nothing is skipped", () => {
    const r = run(project(), "dist.mjs");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["build", "builder --publish never", "verify"]);
    assert.match(r.out, /Klart: appen är byggd, paketerad och kontrollerad/);
  });

  test("flags that npm appends (--publish never) reach electron-builder once, not twice", () => {
    const r = run(project(), "dist.mjs", ["--publish", "never"]);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["build", "builder --publish never", "verify"]);
  });

  test("--dir is passed on (npm run pack)", () => {
    const r = run(project(), "dist.mjs", ["--dir"]);
    assert.deepEqual(r.calls, ["build", "builder --publish never --dir", "verify"]);
  });

  test("a failing build stops everything after it", () => {
    const r = run(project(), "dist.mjs", [], { FAIL_BUILD: "3" });
    assert.equal(r.code, 3, r.out);
    assert.deepEqual(r.calls, ["build"]);
    assert.match(r.out, /Steget "1\/3 Bygger appen" misslyckades/);
  });

  test("a failing electron-builder means the package check is never reached and the run fails", () => {
    const r = run(project(), "dist.mjs", [], { FAIL_BUILDER: "1" });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, ["build", "builder --publish never"]);
  });

  test("a package the check rejects fails the whole run", () => {
    const r = run(project(), "dist.mjs", [], { FAIL_VERIFY: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Steget "3\/3 Kontrollerar paketet" misslyckades/);
  });

  test("a missing electron-builder is explained before anything is built", () => {
    const r = run(project({ withBuilder: false }), "dist.mjs");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /electron-builder hittades inte/);
    assert.deepEqual(r.calls, []);
  });
});

describe("scripts/start.mjs", () => {
  before(() => {
    tmp ??= mkdtempSync(join(tmpdir(), "clipsmith-dist-"));
  });

  test("builds, then starts the app", () => {
    const r = run(project(), "start.mjs");
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, ["build", "app"]);
    assert.match(r.out, /Startar Clipsmith/);
  });

  test("a failed build means the app is not started", () => {
    const r = run(project(), "start.mjs", [], { FAIL_BUILD: "1" });
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(r.calls, ["build"]);
    assert.match(r.out, /appen startas inte/);
  });

  test("the app's exit code is passed on", () => {
    const r = run(project(), "start.mjs", [], { FAIL_APP: "7" });
    assert.equal(r.code, 7, r.out);
  });

  test("a missing electron is explained", () => {
    const r = run(project({ withElectron: false }), "start.mjs");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Electron hittades inte/);
  });

  test("ELECTRON_RUN_AS_NODE is not handed on to the app", () => {
    const dir = project();
    writeFileSync(join(dir, "app.mjs"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("env.txt", String(process.env.ELECTRON_RUN_AS_NODE));\n');
    const r = run(dir, "start.mjs", [], { ELECTRON_RUN_AS_NODE: "1" });
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(dir, "env.txt"), "utf8"), "undefined");
  });
});
