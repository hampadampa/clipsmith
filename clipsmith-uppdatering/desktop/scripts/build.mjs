// Bygger hela skrivbordsappen till dist/ och kontrollerar att resultatet är komplett.
//
//   node scripts/build.mjs            bygger; typfel visas men stoppar inte (för den som bara vill ha appen)
//   node scripts/build.mjs --strict   bygger; typfel stoppar
//   node scripts/build.mjs --verify-only   bygger inget, kontrollerar bara att dist/ är komplett
//
// Skriptet finns för att bygget ska fungera likadant på Windows, Mac och Linux. Det anropar inget skal
// (&&, || och sökvägar tolkas olika i cmd.exe och bash), och det vägrar lämna ifrån sig ett halvt bygge:
// en app utan gränssnitt ska aldrig kunna packas till en installationsfil utan att någon märker det.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const verifyOnly = args.has("--verify-only");

/** Filer som måste finnas, relativt desktop/. Saknas någon är bygget oanvändbart. */
export const REQUIRED = [
  "dist/main/main/index.js",
  "dist/main/main/windows.js",
  "dist/main/main/backend-manager.js",
  "dist/main/preload/preload.cjs",
  "dist/renderer/renderer/index.html",
  "dist/renderer/renderer/app.js",
  "dist/renderer/renderer/styles.css",
  "dist/renderer/renderer/recorder.html",
  "dist/renderer/renderer/recorder.js",
  "dist/renderer/renderer/recorder.css",
  "dist/renderer/shared/api.js",
];

function findTsc() {
  const fromEnv = process.env.CLIPSMITH_TSC;
  if (fromEnv) return fromEnv;
  const local = join(root, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(local)) return local;
  try {
    return createRequire(join(root, "package.json")).resolve("typescript/bin/tsc");
  } catch {
    return null;
  }
}

function compile(tsc, config) {
  console.log(`\n> tsc -p ${config}`);
  const extra = (process.env.CLIPSMITH_TSC_ARGS ?? "").split(/\s+/).filter(Boolean);
  const r = spawnSync(process.execPath, [tsc, "-p", join(root, config), ...extra], { cwd: root, stdio: "inherit" });
  if (r.error) {
    console.error(`Kunde inte starta TypeScript: ${r.error.message}`);
    return false;
  }
  return r.status === 0;
}

/** Kopierar de filer som inte är TypeScript (html, css) bredvid den kompilerade koden. */
function copyStatic() {
  const from = join(root, "src", "renderer");
  const to = join(root, "dist", "renderer", "renderer");
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of readdirSync(from)) {
    if (/\.(html|css)$/.test(f)) {
      cpSync(join(from, f), join(to, f));
      n++;
    }
  }
  console.log(`\nKopierade ${n} html/css-filer till ${relative(root, to)}`);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;
const HTML_REF_RE = /(?:src|href)\s*=\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Returnerar en lista med problem. Tom lista betyder att bygget är komplett. */
export function verifyBuild(baseDir = root) {
  const problems = [];
  for (const rel of REQUIRED) {
    const p = join(baseDir, rel);
    if (!existsSync(p)) problems.push(`saknas: ${rel}`);
    else if (statSync(p).size === 0) problems.push(`är tom: ${rel}`);
  }
  // Varje relativ import och varje <script>/<link> ska peka på en fil som finns.
  for (const dir of ["dist/main", "dist/renderer"]) {
    for (const file of walk(join(baseDir, dir))) {
      if (!/\.(js|cjs|mjs|html)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      const re = file.endsWith(".html") ? HTML_REF_RE : IMPORT_RE;
      for (const m of text.matchAll(re)) {
        const target = resolve(dirname(file), m[1]);
        if (!existsSync(target)) problems.push(`${relative(baseDir, file)} pekar på ${m[1]} som inte finns`);
        else if (m[1].endsWith(".ts")) problems.push(`${relative(baseDir, file)} pekar på en .ts-fil (${m[1]}), den ska peka på .js`);
      }
    }
  }
  return problems;
}

function main() {
  if (!verifyOnly) {
    const tsc = findTsc();
    if (!tsc) {
      console.error("TypeScript hittades inte. Kör 'npm install' i mappen desktop först.");
      process.exit(1);
    }
    // Börja från ett tomt dist/ så att gamla filer aldrig kan dölja att något inte byggdes.
    rmSync(join(root, "dist", "main"), { recursive: true, force: true });
    rmSync(join(root, "dist", "renderer"), { recursive: true, force: true });

    const okMain = compile(tsc, "tsconfig.main.json");
    const okRenderer = compile(tsc, "tsconfig.renderer.json");
    copyStatic();

    if (!okMain || !okRenderer) {
      const which = [!okMain && "main", !okRenderer && "renderer"].filter(Boolean).join(" och ");
      if (strict) {
        console.error(`\nTypfel i ${which} (se ovan). Bygget stoppas eftersom --strict är påslaget.`);
        process.exit(1);
      }
      console.warn(`\nTypfel i ${which} (se ovan). De hindrar inte appen från att byggas, så vi fortsätter.`);
    }
  }

  const problems = verifyBuild();
  if (problems.length) {
    console.error("\nBygget är inte komplett, så det stoppas här:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nOm detta är första bygget: skicka hela texten ovanför till den som hjälper dig.");
    process.exit(1);
  }
  const count = (d) => walk(join(root, d)).length;
  console.log(`\nBygget är komplett: ${count("dist/main")} filer i dist/main, ${count("dist/renderer")} i dist/renderer.`);
}

// Körs bara som skript, inte när testerna importerar verifyBuild.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
