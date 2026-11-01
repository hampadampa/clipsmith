/** Guards for things that would silently break (or weaken) the app under Electron, checked on the source text. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { CHANNELS } from "../src/shared/ipc.ts";

const RENDERER = new URL("../src/renderer/", import.meta.url).pathname;

async function renderer(ext: RegExp): Promise<Array<[string, string]>> {
  const names = (await readdir(RENDERER)).filter((n) => ext.test(n));
  return Promise.all(names.map(async (n) => [n, await readFile(join(RENDERER, n), "utf8")] as [string, string]));
}

describe("renderer under the Content-Security-Policy", () => {
  test("never sets inline style attributes or injects HTML (style-src 'self' blocks the former, the latter is an XSS hole)", async () => {
    for (const [name, src] of await renderer(/\.ts$/)) {
      assert.doesNotMatch(src, /\bstyle:\s*["'`]/, `${name}: style attribute passed to h()`);
      assert.doesNotMatch(src, /setAttribute\(\s*["']style["']/, `${name}: setAttribute("style")`);
      assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, `${name}: HTML injection`);
      assert.doesNotMatch(src, /\beval\(|new Function\(/, `${name}: eval`);
    }
  });

  test("both pages declare a strict CSP without unsafe-inline or unsafe-eval", async () => {
    const pages = await renderer(/\.html$/);
    assert.deepEqual(pages.map(([n]) => n).sort(), ["index.html", "recorder.html"]);
    for (const [name, html] of pages) {
      const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
      assert.ok(csp, `${name}: no CSP meta tag`);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.doesNotMatch(csp, /unsafe-/);
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, `${name}: inline script`);
      assert.doesNotMatch(html, /\sstyle="/, `${name}: inline style`);
    }
  });
});

describe("IPC contract", () => {
  test("channel names are unique", () => {
    const values = Object.values(CHANNELS);
    assert.equal(new Set(values).size, values.length);
  });
});
