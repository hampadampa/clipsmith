// Kopierar de filer i renderern som inte är TypeScript (html, css) bredvid den kompilerade koden.
// Samma sak görs av scripts/build.mjs; den här finns kvar för den som bara bygger renderern för hand.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath och inte URL:ens sökvägsfält: på Windows blir det "/C:/..." som Node tolkar som "C:\C:\...".
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src", "renderer");
const to = join(root, "dist", "renderer", "renderer");
mkdirSync(to, { recursive: true });
for (const f of readdirSync(from)) {
  if (/\.(html|css)$/.test(f)) cpSync(join(from, f), join(to, f));
}
console.log("copied static renderer files");
