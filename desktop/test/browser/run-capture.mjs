// Drives the real capture module in real Chromium (needs a display: run under xvfb-run).
// Usage: node run-capture.mjs <distRendererDir> <outDir> [seconds]
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import http from "node:http";
import { createWriteStream, mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const [dist, outDir, secs = "5"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const harness = new URL("./capture-harness.html", import.meta.url).pathname;
let sink = null, current = null;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST") {
    if (url.pathname === "/open") { current = url.searchParams.get("name"); const ext = current.includes("mp4") ? "mp4" : "webm"; sink = createWriteStream(join(outDir, `${current.replace(/[^a-z0-9]+/gi, "_")}.${ext}`)); }
    if (url.pathname === "/chunk") { req.pipe(sink, { end: false }); return req.on("end", () => res.end("ok")); }
    if (url.pathname === "/close") sink.end();
    req.resume(); return req.on("end", () => res.end("ok"));
  }
  const file = url.pathname === "/harness.html" ? harness : join(dist, url.pathname);
  if (!existsSync(file)) { res.statusCode = 404; return res.end("nf"); }
  res.setHeader("content-type", { ".js": "text/javascript", ".html": "text/html" }[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome",
  headless: false,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen",
         "--autoplay-policy=no-user-gesture-required", "--window-size=1280,720", "--window-position=0,0"],
});
const page = await browser.newPage({ viewport: null });
page.on("console", (m) => console.log("  [page]", m.text()));
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.goto(`${base}/harness.html`);
await page.waitForFunction(() => window.supported);
console.log("version:", browser.version());
console.log("supported:", JSON.stringify(await page.evaluate(() => window.supported)));

const cases = JSON.parse(process.env.CASES ?? "[]");
for (const c of cases) {
  try {
    const r = await page.evaluate((c) => window.runCapture(c), { seconds: Number(secs), ...c });
    console.log("RESULT", JSON.stringify({ case: c, ...r }));
  } catch (e) {
    console.log("RESULT", JSON.stringify({ case: c, failed: String(e.message).split("\n")[0] }));
  }
}
await browser.close();
server.close();
