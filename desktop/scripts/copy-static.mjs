// Copies the non-TypeScript renderer files (html, css) next to the compiled JS.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const from = new URL("../src/renderer/", import.meta.url).pathname;
const to = new URL("../dist/renderer/renderer/", import.meta.url).pathname;
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) {
  if (/\.(html|css)$/.test(f)) cpSync(join(from, f), join(to, f));
}
console.log("copied static renderer files");
