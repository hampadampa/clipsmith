// Bygger appen och startar den (npm start). Samma skäl som scripts/dist.mjs: inga kedjor av kommandon i package.json,
// varje steg startas för sig och dess exitkod kontrolleras här.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const build = spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root, stdio: "inherit" });
if (build.error || build.status !== 0) {
  console.error("\nBygget misslyckades, så appen startas inte.");
  process.exit(typeof build.status === "number" && build.status !== 0 ? build.status : 1);
}

let electron;
try {
  // Paketet "electron" exporterar sökvägen till själva programfilen.
  electron = createRequire(join(root, "package.json"))("electron");
} catch {
  electron = null;
}
if (typeof electron !== "string") {
  console.error("Electron hittades inte. Kör 'npm install' i mappen desktop först.");
  process.exit(1);
}

// Ärvs den här variabeln (t.ex. från en utvecklingsmiljö) startar Electron som ren Node och visar inget fönster.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
console.log("\nStartar Clipsmith...");
const app = spawn(electron, ["."], { cwd: root, stdio: "inherit", env });
app.on("error", (e) => {
  console.error(`Kunde inte starta Electron: ${e.message}`);
  process.exit(1);
});
app.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
