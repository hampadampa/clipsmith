/**
 * scripts/verify-package.mjs: kontrollen som läser i den färdiga appen innan en installationsfil sparas.
 *
 * Paketen här är små, handbyggda asar-arkiv med rätt filformat (fyra tal, filtabell som JSON, sedan data), så det
 * som prövas är kontrollens beslut. Att electron-builder själv skriver samma format har jag kontrollerat mot den
 * riktiga installationsfilen från bygget (där kontrollen också slår larm för att gränssnittet saknas), men aldrig
 * genom att köra electron-builder här.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "verify-package.mjs");

type Dir = { files: Record<string, Dir | { size: number; offset: string }> };

/** Writes an asar archive: 4 numbers, the file table as JSON padded to 4 bytes, then the file contents. */
function writeAsar(path: string, entries: Record<string, string>): void {
  const tree: Dir = { files: {} };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const [p, content] of Object.entries(entries)) {
    const buf = Buffer.from(content);
    const parts = p.split("/");
    let node = tree;
    for (const d of parts.slice(0, -1)) node = (node.files[d] ??= { files: {} }) as Dir;
    node.files[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
    chunks.push(buf);
    offset += buf.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(padded + 8, 4);
  head.writeUInt32LE(padded + 4, 8);
  head.writeUInt32LE(json.length, 12);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([head, json, Buffer.alloc(padded - json.length), ...chunks]));
}

/** What a complete app contains inside app.asar. */
function goodEntries(): Record<string, string> {
  return {
    "package.json": '{"main":"dist/main/main/index.js"}',
    "dist/main/main/index.js": 'import "./windows.js";\nimport("./backend-manager.js");\n',
    "dist/main/main/windows.js": "export {};\n",
    "dist/main/main/backend-manager.js": "export {};\n",
    "dist/main/preload/preload.cjs": "module.exports = {};\n",
    "dist/renderer/renderer/index.html": '<link rel="stylesheet" href="./styles.css"><script type="module" src="./app.js"></script>',
    "dist/renderer/renderer/app.js": 'import { api } from "../shared/api.js";\nexport const x = api;\n',
    "dist/renderer/renderer/styles.css": "body{}\n",
    "dist/renderer/renderer/recorder.html": '<link rel="stylesheet" href="./recorder.css"><script type="module" src="./recorder.js"></script>',
    "dist/renderer/renderer/recorder.js": "export {};\n",
    "dist/renderer/renderer/recorder.css": "body{}\n",
    "dist/renderer/shared/api.js": "export const api = 1;\n",
  };
}

interface Options {
  asar?: Record<string, string>;
  backend?: boolean;
  ffmpeg?: boolean;
  probes?: string[];
}

let tmp: string;
let n = 0;

/** A resources folder as electron-builder lays it out: app.asar, app.asar.unpacked, backend. */
function resources(o: Options = {}): string {
  const res = join(tmp, `r${++n}`, "resources");
  writeAsar(join(res, "app.asar"), o.asar ?? goodEntries());
  if (o.backend !== false) {
    for (const f of ["src/clipsmith/serve.py", "src/clipsmith/prefetch.py", "requirements.txt"]) {
      mkdirSync(dirname(join(res, "backend", f)), { recursive: true });
      writeFileSync(join(res, "backend", f), "# x\n");
    }
  }
  const modules = join(res, "app.asar.unpacked", "node_modules");
  if (o.ffmpeg !== false) {
    mkdirSync(join(modules, "ffmpeg-static"), { recursive: true });
    writeFileSync(join(modules, "ffmpeg-static", "ffmpeg"), "bin");
  }
  for (const p of o.probes ?? ["linux/x64"]) {
    mkdirSync(join(modules, "ffprobe-static", "bin", p), { recursive: true });
    writeFileSync(join(modules, "ffprobe-static", "bin", p, "ffprobe"), "bin");
  }
  return res;
}

function verify(path: string | null, extra: string[] = []) {
  const r = spawnSync(process.execPath, [script, ...(path ? [path] : []), ...extra], {
    encoding: "utf8",
    env: { ...process.env, CLIPSMITH_PLATFORM: "linux", CLIPSMITH_ARCH: "x64" },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("scripts/verify-package.mjs", () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "clipsmith-pkg-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test("a complete package passes", () => {
    const r = verify(join(resources(), "app.asar"));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK, paketet innehåller gränssnitt/);
    assert.match(r.out, /11 av 11 nödvändiga filer/);
    assert.match(r.out, /ffprobe: bara linux\/x64/);
  });

  test("a package without the UI is refused, whatever else is in it", () => {
    // The first installer looked exactly like this: programkod, motor and ffmpeg, but no dist/renderer.
    const asar = goodEntries();
    for (const k of Object.keys(asar)) if (k.startsWith("dist/renderer")) delete asar[k];
    const r = verify(join(resources({ asar }), "app.asar"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /saknas: dist\/renderer\/renderer\/index\.html/);
    assert.match(r.out, /saknas: dist\/renderer\/renderer\/app\.js/);
    assert.doesNotMatch(r.out, /saknas: dist\/main/);
  });

  test("an import that points at a file missing from the package is caught", () => {
    const asar = goodEntries();
    delete asar["dist/renderer/shared/api.js"];
    asar["dist/renderer/renderer/app.js"] = 'import { api } from "../shared/api.js";\n';
    const r = verify(join(resources({ asar }), "app.asar"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /pekar på \.\.\/shared\/api\.js som inte finns/);
  });

  test("a missing preload is caught", () => {
    const asar = goodEntries();
    delete asar["dist/main/preload/preload.cjs"];
    const r = verify(join(resources({ asar }), "app.asar"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /saknas: dist\/main\/preload\/preload\.cjs/);
  });

  test("a missing engine is caught", () => {
    const r = verify(join(resources({ backend: false }), "app.asar"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /saknas bredvid appen: backend\/src\/clipsmith\/serve\.py/);
  });

  test("missing ffmpeg or ffprobe is caught", () => {
    const noFfmpeg = verify(join(resources({ ffmpeg: false }), "app.asar"));
    assert.equal(noFfmpeg.code, 1, noFfmpeg.out);
    assert.match(noFfmpeg.out, /ffmpeg saknas/);

    const wrongProbe = verify(join(resources({ probes: ["darwin/arm64"] }), "app.asar"));
    assert.equal(wrongProbe.code, 1, wrongProbe.out);
    assert.match(wrongProbe.out, /ffprobe saknas för detta system \(linux\/x64\)/);
  });

  test("ffprobe for other systems is a warning about size, not a failure", () => {
    const r = verify(join(resources({ probes: ["linux/x64", "darwin/arm64", "win32/x64"] }), "app.asar"));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OBS: ffprobe för andra system följer också med \(darwin\/arm64, win32\/x64\)/);
  });

  test("a file that is not an asar archive is reported, not crashed on", () => {
    const bad = join(tmp, "not-asar", "app.asar");
    mkdirSync(dirname(bad), { recursive: true });
    writeFileSync(bad, "this is just text, long enough to have a header to read");
    const r = verify(bad);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /kunde inte läsa/);
  });

  test("a folder is searched, every package in it is checked, and one bad one fails the run", () => {
    const base = join(tmp, "release-dir");
    const good = resources();
    const asar = goodEntries();
    delete asar["dist/renderer/renderer/index.html"];
    const bad = resources({ asar });
    // Move both under one release folder, as win-unpacked and linux-unpacked would be.
    for (const [i, res] of [good, bad].entries()) {
      mkdirSync(join(base, `sys${i}`), { recursive: true });
      const r = spawnSync("cp", ["-r", res, join(base, `sys${i}`, "resources")]);
      assert.equal(r.status, 0);
    }
    const r = verify(base);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /sys0\/resources\/app\.asar(?:\n  [^\n]*){3}\n  OK,/);
    assert.match(r.out, /sys1\/resources\/app\.asar[\s\S]*saknas: dist\/renderer\/renderer\/index\.html/);
  });

  test("flags that npm appends to the end of the dist script are ignored", () => {
    // `npm run dist -- --publish never` ends up here as well as in electron-builder.
    const res = resources();
    assert.equal(verify(join(res, "app.asar"), ["--publish", "never"]).code, 0);
    const base = join(tmp, "release-flags");
    mkdirSync(base);
    const none = spawnSync(process.execPath, [script, "--publish", "never"], { cwd: base, encoding: "utf8" });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Hittade ingen app\.asar under .*release/, "falls back to the release folder, not to a folder called 'never'");
  });

  test("an empty release folder is reported", () => {
    const empty = join(tmp, "empty-release");
    mkdirSync(empty);
    const r = verify(empty);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Hittade ingen app\.asar/);
  });
});
