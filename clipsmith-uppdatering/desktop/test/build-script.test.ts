/**
 * scripts/build.mjs: bygget ska aldrig lämna ifrån sig ett halvt resultat.
 *
 * Skriptet kopieras till en tillfällig mapp tillsammans med en låtsas-tsc som skriver (eller inte skriver) filer och
 * returnerar den felkod vi vill testa. Det som provas är alltså skriptets egna beslut: tolererar det typfel, stoppar
 * det när ett gränssnitt saknas, hittar det trasiga importer. Att den riktiga tsc gör rätt prövas av vanliga bygget.
 *
 * Det här är samma fel som gjorde att den första installationsfilen saknade gränssnittet (dist/renderer).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const realScript = join(here, "..", "scripts", "build.mjs");

/** A stand-in for tsc. FAKE_MAIN / FAKE_RENDERER = "ok" | "typeerrors" | "crash" | "typeerrors-nothing". */
const FAKE_TSC = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const config = process.argv[process.argv.indexOf("-p") + 1];
const root = dirname(config);
const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const mode = (config.includes("renderer") ? process.env.FAKE_RENDERER : process.env.FAKE_MAIN) ?? "ok";
if (mode === "crash") { console.error("error TS5058: The specified path does not exist"); process.exit(1); }
if (mode !== "typeerrors-nothing") {
  if (config.includes("renderer")) {
    put("dist/renderer/renderer/app.js", 'import { api } from "../shared/api.js";\\nexport const x = api;\\n');
    put("dist/renderer/renderer/recorder.js", "export const y = 1;\\n");
    put("dist/renderer/shared/api.js", "export const api = 1;\\n");
    if (process.env.FAKE_BAD_IMPORT) put("dist/renderer/renderer/app.js", 'import "./gone.js";\\n');
  } else {
    put("dist/main/main/index.js", 'import "./windows.js";\\nimport("./backend-manager.js");\\n');
    put("dist/main/main/windows.js", "export {};\\n");
    put("dist/main/main/backend-manager.js", "export {};\\n");
    put("dist/main/preload/preload.cjs", "module.exports = {};\\n");
  }
}
if (mode === "typeerrors" || mode === "typeerrors-nothing") { console.error("error TS2307: Cannot find module 'electron'"); process.exit(2); }
`;

let tmp: string;
let work: string;
let counter = 0;

/** A fresh project folder with the real build script, the fake tsc and the renderer's source files. */
function project(): string {
  const dir = join(tmp, `p${++counter}`);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(realScript, join(dir, "scripts", "build.mjs"));
  mkdirSync(join(dir, "src", "renderer"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  for (const f of ["styles.css", "recorder.css"]) writeFileSync(join(dir, "src", "renderer", f), "body{}\n");
  writeFileSync(join(dir, "src", "renderer", "index.html"), '<link rel="stylesheet" href="./styles.css"><script type="module" src="./app.js"></script>');
  writeFileSync(join(dir, "src", "renderer", "recorder.html"), '<link rel="stylesheet" href="./recorder.css"><script type="module" src="./recorder.js"></script>');
  writeFileSync(join(dir, "src", "renderer", "notes.txt"), "not copied\n");
  return dir;
}

function build(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(dir, "scripts", "build.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CLIPSMITH_TSC: join(work, "fake-tsc.mjs"), CLIPSMITH_TSC_ARGS: "", ...env },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("scripts/build.mjs", () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "clipsmith-build-"));
    work = join(tmp, "work");
    mkdirSync(work);
    writeFileSync(join(work, "fake-tsc.mjs"), FAKE_TSC);
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test("a clean build succeeds and copies html and css next to the compiled code", () => {
    const dir = project();
    const r = build(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Bygget är komplett/);
    for (const f of ["index.html", "recorder.html", "styles.css", "recorder.css"]) {
      assert.ok(existsSync(join(dir, "dist", "renderer", "renderer", f)), f);
    }
    assert.ok(!existsSync(join(dir, "dist", "renderer", "renderer", "notes.txt")), "only html and css are copied");
  });

  test("type errors alone do not stop a normal build, but stop --strict", () => {
    const dir = project();
    const lenient = build(dir, [], { FAKE_MAIN: "typeerrors", FAKE_RENDERER: "typeerrors" });
    assert.equal(lenient.code, 0, lenient.out);
    assert.match(lenient.out, /Typfel i main och renderer/);
    assert.match(lenient.out, /Bygget är komplett/);

    const strict = build(project(), ["--strict"], { FAKE_MAIN: "typeerrors" });
    assert.equal(strict.code, 1, strict.out);
    assert.match(strict.out, /--strict/);
  });

  test("a renderer that produced nothing stops the build, even when type errors are tolerated", () => {
    // This is the situation in the first installer: main built, the UI did not, and nobody noticed.
    const dir = project();
    const r = build(dir, [], { FAKE_RENDERER: "typeerrors-nothing" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Bygget är inte komplett/);
    assert.match(r.out, /saknas: dist\/renderer\/renderer\/app\.js/);
    assert.match(r.out, /saknas: dist\/renderer\/shared\/api\.js/);
    assert.doesNotMatch(r.out, /saknas: dist\/main/);
  });

  test("a compiler that cannot even start its project stops the build", () => {
    const r = build(project(), [], { FAKE_RENDERER: "crash" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Bygget är inte komplett/);
  });

  test("a missing tsc is reported in plain words", () => {
    // NODE_PATH is emptied so that a TypeScript installed somewhere on this machine cannot be found by accident.
    const r = build(project(), [], { CLIPSMITH_TSC: "", NODE_PATH: "" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /TypeScript hittades inte/);
  });

  test("an import of a file that was not built is caught", () => {
    const r = build(project(), [], { FAKE_BAD_IMPORT: "1" });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /app\.js pekar på \.\/gone\.js som inte finns/);
  });

  test("an html page that points at a script that does not exist is caught", () => {
    const dir = project();
    writeFileSync(join(dir, "src", "renderer", "index.html"), '<script type="module" src="./nowhere.js"></script>');
    const r = build(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /index\.html pekar på \.\/nowhere\.js som inte finns/);
  });

  test("stale files from an earlier build cannot hide a failure", () => {
    const dir = project();
    assert.equal(build(dir).code, 0);
    const again = build(dir, [], { FAKE_RENDERER: "typeerrors-nothing" });
    assert.equal(again.code, 1, "the old renderer output must have been removed first");
  });

  test("--verify-only checks without building", () => {
    const dir = project();
    assert.equal(build(dir).code, 0);
    assert.equal(build(dir, ["--verify-only"]).code, 0);
    rmSync(join(dir, "dist", "renderer", "renderer", "index.html"));
    const r = build(dir, ["--verify-only"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /saknas: dist\/renderer\/renderer\/index\.html/);
  });

  test("an empty file counts as missing", () => {
    const dir = project();
    assert.equal(build(dir).code, 0);
    writeFileSync(join(dir, "dist", "renderer", "renderer", "app.js"), "");
    const r = build(dir, ["--verify-only"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /är tom: dist\/renderer\/renderer\/app\.js/);
  });
});

describe("the real project files", () => {
  test("package.json builds and starts through scripts/build.mjs, not through a shell chain", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const name of ["build", "build:lenient", "start"]) {
      assert.ok(pkg.scripts[name], name);
      assert.doesNotMatch(pkg.scripts[name], /\|\|/, `${name} must not rely on shell ||`);
    }
    assert.match(pkg.scripts.build, /scripts\/build\.mjs --strict/);
    assert.match(pkg.scripts["build:lenient"], /scripts\/build\.mjs$/);
    assert.equal(pkg.scripts.start, "node scripts/start.mjs");
  });

  test("dist and pack run through scripts/dist.mjs, with no chain of commands for a Windows shell to drop", () => {
    // The first Windows build ran `a || echo .. && b || echo .. && c` through cmd.exe; only the first command ran, and
    // the step still counted as a success. See scripts/dist.mjs.
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.dist, "node scripts/dist.mjs");
    assert.equal(pkg.scripts.pack, "node scripts/dist.mjs --dir");
    for (const name of ["dist", "pack"]) assert.doesNotMatch(pkg.scripts[name], /&&|\|\|/, name);
    // The workflow may still say `npm run dist -- --publish never`; dist.mjs passes such flags on to electron-builder.
    const workflow = readFileSync(join(here, "..", "..", ".github", "workflows", "build.yml"), "utf8");
    assert.match(workflow, /run: npm run dist( -- --publish never)?\s*$/m);
  });

  test("copy-static.mjs converts the file URL properly (URL.pathname breaks on Windows)", () => {
    const text = readFileSync(join(here, "..", "scripts", "copy-static.mjs"), "utf8");
    assert.match(text, /fileURLToPath/);
    assert.doesNotMatch(text, /\.pathname/);
    const build = readFileSync(realScript, "utf8");
    assert.doesNotMatch(build, /\.pathname/);
  });
});
