// Drives the recorder bar window (recorder.html + the real capture module) in real Chromium with a fake Bridge.
// Needs a display: xvfb-run -a -s "-screen 0 1280x720x24" node run-recorder.mjs <distRendererDir> <outDir>
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";

const [dist, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
const server = http.createServer((req, res) => {
  if (req.url === "/favicon.ico") { res.statusCode = 204; return res.end(); }
  const file = join(dist, new URL(req.url, "http://x").pathname);
  if (!existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const bridge = `(() => {
  window.__log = []; let t0 = performance.now(); let handler = null;
  const log = (name, extra) => window.__log.push({ name, extra, at: Math.round(performance.now() - t0) });
  window.__send = (cmd) => handler(cmd);
  window.clipsmith = {
    onRecorderCommand: (cb) => { handler = cb; return () => {}; },
    recorderStarted: (i) => log("started", i), recorderState: (s) => log("state", s),
    recorderChunk: (d) => log("chunk", d.byteLength), recorderStopped: (i) => log("stopped", i), recorderError: (m) => log("error", m),
  };
})();`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", headless: false,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"],
});
const results = []; let failed = 0;
const check = async (name, fn) => { try { await fn(); results.push(`ok   ${name}`); } catch (e) { failed++; results.push(`FAIL ${name}\n       ${String(e.message).split("\n")[0]}`); } };
const errors = [];

async function open(theme = "dark", opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 56 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(bridge);
  // Simulate a platform that cannot capture system audio: the display stream arrives without audio tracks.
  if (opts.stripAudio) await page.addInitScript(`(() => { const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (c) => { const s = await orig(c); s.getAudioTracks().forEach((t) => { s.removeTrack(t); t.stop(); }); return s; }; })();`);
  await page.goto(`${base}/renderer/recorder.html`);
  return page;
}
const log = (page) => page.evaluate(() => window.__log);
const config = { sessionId: "20261031-171200-abcdef", systemAudio: true, micDeviceId: "", countdownSeconds: 2, hideControls: true };
const shot = (page, name) => page.screenshot({ path: join(outDir, `bar-${name}.png`) });

{
  const page = await open();
  await page.evaluate((c) => window.__send({ type: "start", config: c }), config);
  await page.waitForSelector(".count");
  await shot(page, "1-countdown");
  await check("countdown shows the seconds left and nothing is captured yet", async () => {
    assert.match(await page.textContent(".count"), /^[12]$/);
    assert.equal((await log(page)).length, 0);
  });
  await page.waitForSelector(".time", { timeout: 15000 });
  await page.waitForTimeout(2500);
  await shot(page, "2-recording");
  await check("recording starts after the countdown; 'started' precedes the first chunk and carries the format", async () => {
    const l = await log(page);
    const started = l.findIndex((e) => e.name === "started");
    const firstChunk = l.findIndex((e) => e.name === "chunk");
    assert.ok(started >= 0, "no started event");
    assert.ok(firstChunk > started, `first chunk at ${firstChunk}, started at ${started}`);
    assert.match(l[started].extra.mimeType, /^video\/(webm|mp4)/);
    assert.ok(Array.isArray(l[started].extra.warnings));
    assert.ok(l[firstChunk].extra > 0);
  });
  await check("the timer counts up", async () => {
    const t = await page.textContent(".time");
    assert.match(t, /^0:0[1-9]$/);
  });
  await check("pause via the button reports 'paused' and freezes the timer; resume continues", async () => {
    await page.getByRole("button", { name: "Pausa" }).click();
    await page.waitForSelector("text=Pausad");
    await shot(page, "3-paused");
    const frozen = await page.textContent(".time");
    await page.waitForTimeout(1500);
    assert.equal(await page.textContent(".time"), frozen);
    await page.getByRole("button", { name: "Fortsätt" }).click();
    await page.waitForTimeout(1300);
    assert.notEqual(await page.textContent(".time"), frozen);
    const states = (await log(page)).filter((e) => e.name === "state").map((e) => e.extra);
    assert.deepEqual(states, ["paused", "recording"]);
  });
  await check("a pause command from the main process (global shortcut) behaves like the button", async () => {
    await page.evaluate(() => window.__send({ type: "pause" }));
    await page.waitForSelector("text=Pausad");
    await page.evaluate(() => window.__send({ type: "resume" }));
    await page.waitForSelector(".dot:not(.paused)");
  });
  await check("stop finishes cleanly: all chunks delivered before 'stopped', active time excludes pauses", async () => {
    await page.getByRole("button", { name: "Stoppa" }).click();
    await page.waitForFunction(() => window.__log.some((e) => e.name === "stopped"), null, { timeout: 8000 });
    const l = await log(page);
    const stopped = l.findIndex((e) => e.name === "stopped");
    assert.equal(l.slice(stopped + 1).filter((e) => e.name === "chunk").length, 0, "chunk after stopped");
    assert.equal(l.filter((e) => e.name === "error").length, 0);
    const wall = l[stopped].at - l.find((e) => e.name === "started").at;
    const active = l[stopped].extra.durationMs;
    assert.ok(active > 3000 && active < wall, `active ${active} ms, wall ${wall} ms`);
    const bytes = l.filter((e) => e.name === "chunk").reduce((n, e) => n + e.extra, 0);
    assert.ok(bytes > 20_000, `only ${bytes} bytes recorded`);
  });
  await shot(page, "4-after-stop");
  await page.context().close();
}

{
  const page = await open("light");
  await page.evaluate((c) => window.__send({ type: "start", config: { ...c, countdownSeconds: 3 } }), config);
  await page.waitForSelector(".count");
  await shot(page, "5-countdown-light");
  await check("cancel during the countdown reports 'cancelled' and never starts capturing", async () => {
    await page.getByRole("button", { name: "Avbryt" }).click();
    await page.waitForTimeout(3600);
    const l = await log(page);
    assert.deepEqual(l.map((e) => [e.name, e.extra]), [["error", "cancelled"]]);
  });
  await page.context().close();
}

{
  const page = await open();
  await check("a start command while already running is ignored (no second capture)", async () => {
    await page.evaluate((c) => window.__send({ type: "start", config: { ...c, countdownSeconds: 0 } }), config);
    await page.waitForSelector(".time", { timeout: 15000 });
    await page.evaluate((c) => window.__send({ type: "start", config: { ...c, countdownSeconds: 0 } }), config);
    await page.waitForTimeout(1500);
    assert.equal((await log(page)).filter((e) => e.name === "started").length, 1);
    await page.evaluate(() => window.__send({ type: "stop" }));
    await page.waitForFunction(() => window.__log.some((e) => e.name === "stopped"), null, { timeout: 8000 });
  });
  await page.context().close();
}

{
  const page = await open("dark", { stripAudio: true });
  await check("no system audio but a microphone: recording goes ahead with a warning that says what is missing", async () => {
    await page.evaluate((c) => window.__send({ type: "start", config: { ...c, countdownSeconds: 0 } }), config);
    await page.waitForSelector(".time", { timeout: 15000 });
    await page.waitForTimeout(2200);
    const l = await log(page);
    const started = l.find((e) => e.name === "started");
    assert.equal(started.extra.warnings.length, 1);
    assert.match(started.extra.warnings[0], /Systemljud är inte tillgängligt.*Bara mikrofonen/);
    assert.ok(l.some((e) => e.name === "chunk" && e.extra > 0), "no data from the microphone-only recording");
    await page.evaluate(() => window.__send({ type: "stop" }));
    await page.waitForFunction(() => window.__log.some((e) => e.name === "stopped"), null, { timeout: 8000 });
  });
  await page.context().close();
}

{
  const page = await open("dark", { stripAudio: true });
  await check("no system audio and no microphone: refuses with a clear reason instead of recording silence", async () => {
    await page.evaluate((c) => window.__send({ type: "start", config: { ...c, micDeviceId: null, countdownSeconds: 0 } }), config);
    await page.waitForFunction(() => window.__log.some((e) => e.name === "error"), null, { timeout: 15000 });
    const l = await log(page);
    assert.deepEqual(l.map((e) => e.name), ["error"], "nothing may be started or recorded");
    assert.match(l[0].extra, /inget ljud att spela in/);
  });
  await page.context().close();
}

await browser.close(); server.close();
console.log(results.join("\n"));
if (errors.length) { console.log("\nPAGE ERRORS:\n" + [...new Set(errors)].join("\n")); failed++; }
process.exit(failed ? 1 : 0);
