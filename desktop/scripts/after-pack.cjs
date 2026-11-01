// Körs av electron-builder (inställningen "afterPack") när appen är packad men innan installationsfilen skapas.
//
// ffprobe-static levererar färdiga program för alla system (Mac, Linux och Windows, 32 och 64 bitar), ungefär 350 MB
// tillsammans. Ett paket behöver bara det egna systemets. Här tas resten bort så att installationsfilen inte blir
// flera hundra megabyte större än nödvändigt.
//
// Det här är en .cjs-fil eftersom electron-builder läser hooks med require().
const { existsSync, readdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

// electron-builders talkoder för processorarkitektur
const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

/**
 * Tar bort ffprobe-program för andra system än det som byggs. Returnerar vad som togs bort och vad som finns kvar.
 * Kastar fel om det egna systemets program inte finns, för då fungerar inte appen.
 */
function pruneFfprobe(resourcesDir, platform, arch) {
  const bin = join(resourcesDir, "app.asar.unpacked", "node_modules", "ffprobe-static", "bin");
  if (!existsSync(bin)) return { removed: [], kept: [], skipped: true };

  const keep = (os, a) => os === platform && (arch === "universal" || a === arch);
  const removed = [];
  const kept = [];
  for (const os of readdirSync(bin)) {
    for (const a of readdirSync(join(bin, os))) {
      const id = `${os}/${a}`;
      if (keep(os, a)) {
        kept.push(id);
      } else {
        rmSync(join(bin, os, a), { recursive: true, force: true });
        removed.push(id);
      }
    }
    if (readdirSync(join(bin, os)).length === 0) rmSync(join(bin, os), { recursive: true, force: true });
  }
  if (!kept.length) {
    throw new Error(`ffprobe-static har inget program för ${platform}/${arch}. Appen skulle sakna ffprobe. Fanns: ${removed.join(", ") || "inget"}`);
  }
  return { removed, kept, skipped: false };
}

/** Mappen där appens resurser ligger: bredvid exe-filen på Windows/Linux, inuti .app-paketet på Mac. */
function resourcesDirOf(appOutDir, platform) {
  if (platform !== "darwin") return join(appOutDir, "resources");
  const app = readdirSync(appOutDir).find((n) => n.endsWith(".app"));
  if (!app) throw new Error(`Hittade ingen .app i ${appOutDir}`);
  return join(appOutDir, app, "Contents", "Resources");
}

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName; // "win32" | "darwin" | "linux"
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch);
  const result = pruneFfprobe(resourcesDirOf(context.appOutDir, platform), platform, arch);
  if (result.skipped) console.log("  • ffprobe-static finns inte i paketet, inget att städa");
  else console.log(`  • ffprobe: behåller ${result.kept.join(", ")}, tog bort ${result.removed.join(", ") || "inget"}`);
};
module.exports.pruneFfprobe = pruneFfprobe;
module.exports.resourcesDirOf = resourcesDirOf;
