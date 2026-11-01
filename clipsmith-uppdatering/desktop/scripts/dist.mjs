// Bygger appen, paketerar den till en installationsfil och kontrollerar paketet, i den ordningen.
//
//   node scripts/dist.mjs            installationsfil för det system du kör på (npm run dist)
//   node scripts/dist.mjs --dir      bara den uppackade appen, ingen installationsfil (npm run pack)
//
// Varför ett eget skript i stället för `a && b && c` i package.json: på Windows kördes den första versionen av bygget
// genom cmd.exe, och en kedja av kommandon stannade tyst efter första kommandot men räknades som lyckad. Resultatet var
// en installationsfil utan gränssnitt. Här startas varje steg för sig, utan skal, och exitkoden kontrolleras av
// den här filen. Ett steg som misslyckas stoppar allt, och ett steg som hoppas över är inte möjligt.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "scripts");
// `npm run dist -- --publish never` lägger sina flaggor sist; de skickas vidare till electron-builder.
const extra = process.argv.slice(2);

/** electron-builders egen startfil (inte .cmd-genvägen i node_modules/.bin, som kräver ett skal). */
function builderCli() {
  const direct = join(root, "node_modules", "electron-builder", "package.json");
  let pkgPath = direct;
  if (!existsSync(direct)) {
    try {
      pkgPath = createRequire(join(root, "package.json")).resolve("electron-builder/package.json");
    } catch {
      return null;
    }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["electron-builder"];
  return bin ? join(dirname(pkgPath), bin) : null;
}

function step(title, args) {
  console.log(`\n=== ${title} ===`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `felkod ${r.status ?? r.signal}`;
    console.error(`\nSteget "${title}" misslyckades (${why}). Resten av bygget stoppas.`);
    process.exit(typeof r.status === "number" && r.status !== 0 ? r.status : 1);
  }
}

const cli = builderCli();
if (!cli) {
  console.error("electron-builder hittades inte. Kör 'npm install' i mappen desktop först.");
  process.exit(1);
}

step("1/3 Bygger appen", [join(here, "build.mjs")]);
step("2/3 Paketerar med electron-builder", [cli, ...(extra.includes("--publish") ? [] : ["--publish", "never"]), ...extra]);
step("3/3 Kontrollerar paketet", [join(here, "verify-package.mjs")]);
console.log("\nKlart: appen är byggd, paketerad och kontrollerad.");
