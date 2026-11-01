// Läser i den färdigbyggda appen (app.asar) och kontrollerar att den innehåller allt den behöver.
//
//   node scripts/verify-package.mjs                 letar efter app.asar under release/
//   node scripts/verify-package.mjs <sökväg>        en app.asar, eller en mapp att leta i
//
// Den körs automatiskt efter electron-builder. Den finns för att en installationsfil utan gränssnitt eller utan
// motor ska stoppas på bygget, inte upptäckas av den som installerar den.
import { existsSync, mkdirSync, mkdtempSync, openSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED, verifyBuild } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads the file table of an asar archive. Format: four 32-bit numbers, then the table as JSON, then the file data. */
export function readAsar(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) < 16) throw new Error("filen är för kort för att vara ett asar-arkiv");
    const headerPickleSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    if (head.readUInt32LE(0) !== 4 || jsonLength === 0 || jsonLength > headerPickleSize) {
      throw new Error("filen ser inte ut som ett asar-arkiv");
    }
    const json = Buffer.alloc(jsonLength);
    readSync(fd, json, 0, jsonLength, 16);
    return { tree: JSON.parse(json.toString("utf8")), dataStart: 8 + headerPickleSize };
  } finally {
    closeSync(fd);
  }
}

/** Every file in the table as a map from archive path ("dist/main/main/index.js") to its entry. */
export function listAsar(tree, prefix = "", out = new Map()) {
  for (const [name, entry] of Object.entries(tree.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) listAsar(entry, p, out);
    else out.set(p, entry);
  }
  return out;
}

/** Writes the dist/ part of the archive to a folder, so the same checks as for a local build can run on it. */
function extractDist(asarPath, files, dataStart, into) {
  const fd = openSync(asarPath, "r");
  try {
    for (const [p, entry] of files) {
      if (!p.startsWith("dist/") || entry.unpacked || entry.link) continue;
      const buf = Buffer.alloc(entry.size);
      if (entry.size) readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
      mkdirSync(dirname(join(into, p)), { recursive: true });
      writeFileSync(join(into, p), buf);
    }
  } finally {
    closeSync(fd);
  }
}

/** All app.asar files below a folder (the build output has one per system: win-unpacked, mac-arm64, linux-unpacked). */
function findAsars(dir, depth = 0, out = []) {
  if (depth > 7 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) findAsars(p, depth + 1, out);
    else if (name === "app.asar") out.push(p);
  }
  return out;
}

// Which system the package was built for. Normally this machine; the variables are for checking another system's package.
const platform = process.env.CLIPSMITH_PLATFORM ?? process.platform;
const arch = process.env.CLIPSMITH_ARCH ?? process.arch;
const exe = platform === "win32" ? ".exe" : "";

/** Checks one app.asar and the folders next to it. Returns { problems, notes }. */
export function verifyPackage(asarPath) {
  const problems = [];
  const notes = [];
  const resources = dirname(asarPath);

  let table;
  try {
    table = readAsar(asarPath);
  } catch (e) {
    return { problems: [`kunde inte läsa ${asarPath}: ${e instanceof Error ? e.message : e}`], notes };
  }
  const files = listAsar(table.tree);
  notes.push(`${files.size} filer i app.asar`);

  if (!files.has("package.json")) problems.push("package.json saknas i app.asar");

  // Samma kontroll som efter ett vanligt bygge, men på det som faktiskt hamnade i paketet.
  const scratch = mkdtempSync(join(tmpdir(), "clipsmith-verify-"));
  try {
    extractDist(asarPath, files, table.dataStart, scratch);
    for (const p of verifyBuild(scratch)) problems.push(`i appen ${p}`);
    const present = REQUIRED.filter((r) => files.has(r));
    notes.push(`${present.length} av ${REQUIRED.length} nödvändiga filer finns i paketet`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // Motorn (Python-koden) och verktygen som körs utanför arkivet.
  for (const rel of ["backend/src/clipsmith/serve.py", "backend/src/clipsmith/prefetch.py", "backend/requirements.txt"]) {
    if (!existsSync(join(resources, rel))) problems.push(`saknas bredvid appen: ${rel}`);
  }
  const unpacked = join(resources, "app.asar.unpacked", "node_modules");
  if (!existsSync(join(unpacked, "ffmpeg-static", `ffmpeg${exe}`))) problems.push("ffmpeg saknas (app.asar.unpacked/node_modules/ffmpeg-static)");
  const probeDir = join(unpacked, "ffprobe-static", "bin");
  const probe = join(probeDir, platform, arch, `ffprobe${exe}`);
  if (!existsSync(probe)) problems.push(`ffprobe saknas för detta system (${platform}/${arch})`);

  // Inte ett fel, men ett tecken på att paketet blivit onödigt stort.
  if (existsSync(probeDir)) {
    const systems = [];
    for (const os of readdirSync(probeDir)) {
      for (const arch of readdirSync(join(probeDir, os))) systems.push(`${os}/${arch}`);
    }
    const own = `${platform}/${arch}`;
    const extra = systems.filter((s) => s !== own);
    notes.push(extra.length ? `OBS: ffprobe för andra system följer också med (${extra.join(", ")}), paketet blir onödigt stort` : `ffprobe: bara ${own}`);
  }
  return { problems, notes };
}

function main() {
  // `npm run dist -- --publish never` lägger flaggorna sist på kommandoraden, alltså efter det här skriptet. De
  // gäller electron-builder, som redan har dem, så de hoppas över här.
  const rest = process.argv.slice(2);
  const publish = rest.indexOf("--publish");
  if (publish >= 0) rest.splice(publish, 2);
  const arg = rest.find((a) => !a.startsWith("--"));
  const target = resolve(arg ?? join(root, "release"));
  const asars = target.endsWith(".asar") ? [target] : findAsars(target);
  if (!asars.length) {
    console.error(`Hittade ingen app.asar under ${target}. Har electron-builder körts?`);
    process.exit(1);
  }
  let failed = false;
  for (const asar of asars) {
    const { problems, notes } = verifyPackage(asar);
    console.log(`\n${asar}`);
    for (const n of notes) console.log(`  ${n}`);
    if (problems.length) {
      failed = true;
      console.error(`  FEL, paketet är inte komplett:`);
      for (const p of problems) console.error(`    - ${p}`);
    } else {
      console.log(`  OK, paketet innehåller gränssnitt, programkod, motor och ffmpeg.`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
