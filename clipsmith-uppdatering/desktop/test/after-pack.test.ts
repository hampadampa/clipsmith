/**
 * scripts/after-pack.cjs: tar bort ffprobe för andra system än det som byggs (ca 290 MB per installationsfil).
 *
 * Det som prövas här är beslutet och filarbetet. Att electron-builder verkligen anropar hooken med de värden som
 * antas (electronPlatformName, arch som tal, appOutDir) följer dess dokumentation men har aldrig körts här.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const require = createRequire(import.meta.url);
const hook = require("../scripts/after-pack.cjs") as ((ctx: unknown) => Promise<void>) & {
  pruneFfprobe: (dir: string, platform: string, arch: string) => { removed: string[]; kept: string[]; skipped: boolean };
  resourcesDirOf: (appOutDir: string, platform: string) => string;
};

const ALL = ["darwin/arm64", "darwin/x64", "linux/ia32", "linux/x64", "win32/ia32", "win32/x64"];

let tmp: string;
let n = 0;

/** A resources folder holding ffprobe-static the way the npm package lays it out. */
function resources(systems: string[] = ALL): string {
  const res = join(tmp, `res${++n}`);
  for (const s of systems) {
    const dir = join(res, "app.asar.unpacked", "node_modules", "ffprobe-static", "bin", s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, s.startsWith("win32") ? "ffprobe.exe" : "ffprobe"), "binary");
  }
  return res;
}

const probe = (res: string, s: string) => existsSync(join(res, "app.asar.unpacked", "node_modules", "ffprobe-static", "bin", s));

describe("scripts/after-pack.cjs", () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "clipsmith-afterpack-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test("Windows x64 keeps only win32/x64", () => {
    const res = resources();
    const r = hook.pruneFfprobe(res, "win32", "x64");
    assert.deepEqual(r.kept, ["win32/x64"]);
    assert.equal(r.removed.length, 5);
    for (const s of ALL) assert.equal(probe(res, s), s === "win32/x64", s);
    assert.ok(!existsSync(join(res, "app.asar.unpacked", "node_modules", "ffprobe-static", "bin", "darwin")), "empty system folders are removed too");
  });

  test("Mac arm64 and Linux x64 each keep their own", () => {
    const mac = resources();
    assert.deepEqual(hook.pruneFfprobe(mac, "darwin", "arm64").kept, ["darwin/arm64"]);
    assert.ok(!probe(mac, "darwin/x64"));
    const linux = resources();
    assert.deepEqual(hook.pruneFfprobe(linux, "linux", "x64").kept, ["linux/x64"]);
    assert.ok(!probe(linux, "linux/ia32"));
  });

  test("a universal Mac build keeps both Mac programs", () => {
    const res = resources();
    assert.deepEqual(hook.pruneFfprobe(res, "darwin", "universal").kept.sort(), ["darwin/arm64", "darwin/x64"]);
  });

  test("it refuses to leave an app without ffprobe for its own system", () => {
    const res = resources(["linux/x64", "darwin/arm64"]);
    assert.throws(() => hook.pruneFfprobe(res, "win32", "x64"), /inget program för win32\/x64/);
  });

  test("a package without ffprobe-static is left alone", () => {
    const res = join(tmp, "plain");
    mkdirSync(res);
    assert.deepEqual(hook.pruneFfprobe(res, "win32", "x64"), { removed: [], kept: [], skipped: true });
  });

  test("the hook translates electron-builder's context (platform name, numeric arch, folder layout)", async () => {
    // Windows / Linux: resources sit next to the executable.
    const winOut = join(tmp, "win-unpacked");
    const winRes = join(winOut, "resources");
    for (const s of ALL) {
      mkdirSync(join(winRes, "app.asar.unpacked", "node_modules", "ffprobe-static", "bin", s), { recursive: true });
    }
    await hook({ electronPlatformName: "win32", arch: 1, appOutDir: winOut });
    assert.ok(probe(winRes, "win32/x64") && !probe(winRes, "linux/x64"));

    // Mac: resources sit inside the .app bundle.
    const macOut = join(tmp, "mac-arm64");
    const macRes = join(macOut, "Clipsmith.app", "Contents", "Resources");
    for (const s of ALL) {
      mkdirSync(join(macRes, "app.asar.unpacked", "node_modules", "ffprobe-static", "bin", s), { recursive: true });
    }
    assert.equal(hook.resourcesDirOf(macOut, "darwin"), macRes);
    await hook({ electronPlatformName: "darwin", arch: 3, appOutDir: macOut });
    assert.ok(probe(macRes, "darwin/arm64") && !probe(macRes, "darwin/x64") && !probe(macRes, "win32/x64"));
  });
});

describe("the electron-builder settings", () => {
  test("package.json points at the hook and does not replace the file list", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      build: { afterPack?: string; files: string[] };
    };
    assert.equal(pkg.build.afterPack, "scripts/after-pack.cjs");
    assert.ok(existsSync(join(import.meta.dirname, "..", pkg.build.afterPack)));
    assert.deepEqual(pkg.build.files, ["dist/**/*", "package.json"]);
  });
});
