/**
 * Which files the clipsmith://app/ address may serve. The rules are run with Windows path rules too, because that is
 * where the app is installed and where the first real start showed "Not found".
 */
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { describe, test } from "node:test";

import { resolveServed, type PathApi } from "../src/main/serve-path.ts";

const systems: [string, PathApi, string][] = [
  ["Windows", win32, "C:\\Users\\Ann\\AppData\\Local\\Programs\\Clipsmith\\resources\\app.asar\\dist\\main\\main"],
  ["Linux", posix, "/opt/Clipsmith/resources/app.asar/dist/main/main"],
];

for (const [name, p, here] of systems) {
  describe(`resolveServed on ${name}`, () => {
    const root = p.normalize(p.join(here, "..", "..", "renderer"));

    test("serves the pages, scripts and styles the UI asks for", () => {
      for (const path of ["/renderer/index.html", "/renderer/app.js", "/renderer/styles.css", "/shared/api.js", "/renderer/recorder.html"]) {
        const r = resolveServed(root, path, p);
        assert.ok(r.ok, `${path}`);
        if (r.ok) assert.equal(r.file, p.normalize(p.join(root, ...path.split("/"))));
      }
    });

    test("the file lies inside dist/renderer, next to renderer/ and shared/", () => {
      const r = resolveServed(root, "/renderer/index.html", p);
      assert.ok(r.ok);
      if (r.ok) assert.ok(r.file.includes(`dist${p.sep}renderer${p.sep}renderer${p.sep}index.html`), r.file);
    });

    test("nothing outside the folder is served, however the path is spelled", () => {
      // Raw paths, as they would arrive if a client did not normalize them, and percent-encoded ones, which the
      // URL parser leaves alone but decodeURIComponent turns into slashes.
      const attempts = ["/../main/main/index.js", "/renderer/../../main/main/index.js", "/..%2F..%2Fmain%2Fmain%2Findex.js"];
      // A backslash only separates folders on Windows; on Linux it is an ordinary (harmless) character in a file name.
      if (p === win32) attempts.push("/..%5C..%5Cmain%5Cmain%5Cindex.js");
      for (const path of attempts) {
        const arriving = path.includes("%") ? new URL(`clipsmith://app${path}`).pathname : path;
        assert.equal(resolveServed(root, arriving, p).ok, false, path);
      }
    });

    test("an address the URL parser has already tidied up stays inside the folder", () => {
      // clipsmith://app/renderer/../../main/x.js becomes /main/x.js, which is a (missing) file under dist/renderer.
      const r = resolveServed(root, new URL("clipsmith://app/renderer/../../main/main/index.js").pathname, p);
      assert.ok(r.ok);
      if (r.ok) assert.ok(r.file.startsWith(root + p.sep));
    });

    test("only html, js and css are served", () => {
      const png = resolveServed(root, "/renderer/logo.png", p);
      assert.deepEqual(png, { ok: false, reason: "filtypen serveras inte" });
      assert.equal(resolveServed(root, "/renderer/app.js.map", p).ok, false);
    });

    test("a broken percent escape is refused instead of throwing", () => {
      assert.deepEqual(resolveServed(root, "/renderer/%E0%A4%A.js", p), { ok: false, reason: "ogiltig adress" });
    });

    test("the root itself and a folder name are not files", () => {
      assert.equal(resolveServed(root, "/", p).ok, false);
      assert.equal(resolveServed(root, "/renderer", p).ok, false);
    });
  });
}
