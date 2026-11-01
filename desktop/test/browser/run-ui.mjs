// Drives the real renderer in real Chromium against a fake Bridge: every screen, the main flows,
// CSP violations and console errors. Needs a display: run under xvfb-run.
//
//   ffmpeg-made media in <mediaDir>: main.mp4 (16:9), short_1.mp4 .. short_4.mp4 (9:16)
//   xvfb-run -a -s "-screen 0 1400x1000x24" node run-ui.mjs <distRendererDir> <outDir> <mediaDir>
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";

const [dist, outDir, mediaDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// ---- static server: the renderer plus the job files the result view plays -------------------------------
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".mp4": "video/mp4" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/favicon.ico") { res.statusCode = 204; return res.end(); }
  const media = /^\/jobs\/[0-9a-f]{32}\/files\/([\w.]+)$/.exec(url.pathname);
  const file = media ? join(mediaDir, media[1]) : join(dist, url.pathname);
  if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end("not found"); }
  const size = statSync(file).size;
  const sniffed = media && readFileSync(file).subarray(0, 4).toString("hex") === "1a45dfa3" ? "video/webm" : null;
  res.setHeader("content-type", sniffed ?? TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("accept-ranges", "bytes");
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range && media) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader("content-length", size);
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- fixtures ----------------------------------------------------------------------------------------------
const JOB = "d".repeat(32);
const kept = [[0, 60], [95, 150], [210, 300], [372, 430], [520, 610], [690, 760], [860, 950], [1040, 1110], [1560, 1630]];
let out = 0;
const edl = kept.map(([a, b]) => { const e = { src_start: a, src_end: b, out_start: out }; out += b - a; return e; });
const reasons = ["dead_air", "retake", "dead_air", "repetition", "false_start", "dead_air", "off_topic", "retake", "meta_talk", "dead_air", "low_value", "dead_air"];
const manifest = {
  preferences: {},
  source: { duration: 1880, width: 1920, height: 1080 },
  storyline: "Från trasig vattenpump till körklar bil, med felsökningen i tydlig ordning.",
  main: {
    file: "main.mp4", subtitles: "main.srt", edl: "main.edl.json", duration: out, target: 600, segments: kept.length, dropped_units: 0,
    cuts: reasons.map((reason, i) => ({ from_id: i * 10, to_id: i * 10 + 4, reason, confidence: 0.9 })),
  },
  shorts: [
    ["Så hittar du läckan på 30 sekunder", 38, "Ett tydligt påstående som får tittaren att vilja veta hur."],
    ["Därför lossnar mutter nummer tre", 45, "Ett överraskande misstag som många gör."],
    ["Verktyget alla glömmer", 52, "Kort, konkret och lätt att känna igen sig i."],
    ["Det här gör jag aldrig om", 31, "Berättelsen har en vändning mitt i."],
  ].map(([title, duration, reason], i) => ({ file: `short_${i + 1}.mp4`, title, score: 0.9, reason, duration, source_start: 100 * i, source_end: 100 * i + duration, unit_range: [1, 2] })),
};
const doneJob = { id: JOB, status: "done", stage: "done", progress: 1, error: null, created_at: 0, preferences: {}, outputs: ["main.mp4", "main.srt", "short_1.mp4", "short_2.mp4", "short_3.mp4", "short_4.mp4"], result: manifest };
const sessions = [
  { id: "20261031-120401-a1b2c3", createdAt: Date.parse("2026-10-31T12:04:01"), state: "uploaded", sourceName: "Skärm 1", mimeType: "video/webm", ext: "webm", durationMs: 1880000, bytes: 412_000_000, jobId: JOB, note: null },
  { id: "20261030-190012-d4e5f6", createdAt: Date.parse("2026-10-30T19:00:12"), state: "stopped", sourceName: "Visual Studio Code", mimeType: "video/webm", ext: "webm", durationMs: 734000, bytes: 150_000_000, jobId: null, note: null },
  { id: "20261029-081500-0a0b0c", createdAt: Date.parse("2026-10-29T08:15:00"), state: "recovered", sourceName: "Skärm 1", mimeType: "video/webm", ext: "webm", durationMs: null, bytes: 22_000_000, jobId: null, note: "Appen avslutades under inspelningen. Det som hann sparas finns kvar." },
];
const engineReady = { mode: "managed", phase: "ready", detail: null, step: 0, problem: null, restarts: 0, version: "0.1.0", url: base,
  log: ["motor: clipsmith engine 0.1.0 on http://127.0.0.1:51234 (data: /home/anna/.config/Clipsmith/engine/data)", "motor: INFO uvicorn.error: Application startup complete."] };
const installingLog = ["python: 3.12.7 (/usr/bin/python3.12)", "venv: created", "pip: Collecting fastapi>=0.115", "pip: Downloading fastapi-0.118.0-py3-none-any.whl (97 kB)", "pip: Collecting faster-whisper>=1.0", "pip: Downloading faster_whisper-1.2.0-py3-none-any.whl (1.1 MB)", "pip: Downloading ctranslate2-4.6.0-cp312-cp312-manylinux_2_17_x86_64.whl (38.5 MB)"];
const engineInstalling = { ...engineReady, phase: "installing", detail: "Installerar Python-paket. Första gången kan det ta flera minuter…", step: 2, version: null, url: null, log: installingLog };
const engineModel = { ...engineInstalling, phase: "model", step: 3, detail: "Hämtar taligenkänningsmodellen \"small\". Det görs en gång och kan vara flera hundra MB…", log: [...installingLog, "modell: model.bin:  41%|████      | 198M/484M [00:12<00:17, 16.4MB/s]"] };
const engineNoPython = { ...engineReady, phase: "failed", version: null, url: null, log: ["python: hämtar cpython-3.12.12+20251014-x86_64-pc-windows-msvc-install_only.tar.gz (48 MB)", "python: kunde inte hämta en egen Python (api.github.com: getaddrinfo ENOTFOUND api.github.com)"],
  problem: { code: "python-download-failed", title: "Kunde inte hämta Python", hint: "Clipsmith hittade ingen Python på datorn och försökte hämta en egen, men fick ingen kontakt med github.com (api.github.com: getaddrinfo ENOTFOUND api.github.com). Kontrollera internetanslutningen, proxy och brandvägg och försök igen. Du kan också installera Python 3.12 själv från python.org/downloads (på Windows: kryssa i \"Add python.exe to PATH\") och starta om Clipsmith.", pythonDownload: true } };
const enginePythonFetch = { ...engineReady, phase: "installing", detail: "Hittade ingen Python. Hämtar en egen kopia (en gång, ca 50 MB)…", step: 2, version: null, url: null,
  log: ["python: hämtar cpython-3.12.12+20251014-x86_64-pc-windows-msvc-install_only.tar.gz (48 MB)", "python: 23 av 48 MB"] };
const engineOffline = { ...engineReady, phase: "failed", version: null, url: null, log: [...installingLog.slice(0, 3), "pip: WARNING: Retrying (Retry(total=2)) after connection broken by NameResolutionError(\"Failed to resolve 'pypi.org'\")", "pip: ERROR: No matching distribution found for faster-whisper>=1.0"],
  problem: { code: "install-failed", title: "Kunde inte hämta Python-paketen", hint: "Det gick inte att nå paketservern (pypi.org). Kontrollera internetanslutningen, proxy och brandvägg och försök igen. Det behövs bara första gången." } };
const engineRestarting = { ...engineReady, phase: "starting", step: 4, detail: "Motorn stannade oväntat. Startar om om 1 s…", restarts: 1, version: null, url: null, log: [...engineReady.log, "motor: stannade (kod 7)"] };
const engineExternal = { mode: "external", phase: "off", detail: null, step: 0, problem: null, log: [], restarts: 0, version: null, url: null };
const baseState = {
  phase: "idle", session: null, upload: null, job: null, edl: null, notice: null, error: null, sessions,
  server: { url: base, ok: true, version: "0.1.0" }, engine: engineReady, hasApiKey: true, needsProfile: false,
  shortcuts: { stop: "CommandOrControl+Shift+R", pause: "CommandOrControl+Shift+P" },
};

// ---- the fake bridge, injected before the app loads ----------------------------------------------------
const fakeBridge = (fx) => `(() => {
  const fx = ${JSON.stringify(fx)};
  window.__calls = [];
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
  let state = structuredClone(fx.initial);
  const listeners = new Set();
  window.__push = (patch) => { state = { ...structuredClone(fx.base), ...patch }; listeners.forEach((l) => l(structuredClone(state))); };
  const shot = (label, w, h, hue) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "hsl(" + hue + ",35%,28%)"); gr.addColorStop(1, "hsl(" + (hue + 40) + ",40%,45%)"); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.fillStyle = "rgba(255,255,255,.85)"; g.fillRect(16, 16, w - 32, 22); g.fillStyle = "rgba(255,255,255,.35)"; g.fillRect(16, 52, (w - 32) * 0.6, 12); g.fillRect(16, 74, (w - 32) * 0.4, 12); return c.toDataURL("image/jpeg", 0.7); };
  const sources = [
    { id: "screen:0:0", name: "Skärm 1", kind: "screen", thumbnail: shot("a", 320, 200, 210) },
    { id: "screen:1:0", name: "Skärm 2", kind: "screen", thumbnail: shot("b", 320, 200, 150) },
    { id: "window:11:0", name: "Visual Studio Code", kind: "window", thumbnail: shot("c", 320, 200, 260) },
    { id: "window:12:0", name: "Firefox: Volvo 240 vattenpump", kind: "window", thumbnail: shot("d", 320, 200, 30) },
  ];
  let prefs = fx.prefs;
  let serverUrl = fx.base.server.url;
  const engineSettings = { mode: fx.initial.engine.mode, whisperModel: "small", hasApiKey: fx.initial.hasApiKey, keyStorage: fx.initial.hasApiKey ? "encrypted" : "none" };
  const call = (name, ...args) => { window.__calls.push([name, ...args]); };
  window.clipsmith = {
    getState: async () => structuredClone(state),
    onState: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    getSettings: async () => ({ serverUrl: serverUrl, preferences: prefs, engine: { ...engineSettings } }),
    saveSettings: async (patch) => {
      call("saveSettings", patch);
      if (patch.preferences) { prefs = patch.preferences; window.__push({ ...state, needsProfile: false }); }
      if (patch.serverUrl) serverUrl = patch.serverUrl.startsWith("http") ? patch.serverUrl : "http://" + patch.serverUrl;
      if (patch.engine) {
        Object.assign(engineSettings, patch.engine);
        if (patch.engine.mode) window.__push({ ...state, engine: patch.engine.mode === "external" ? fx.external : fx.base.engine, server: patch.engine.mode === "external" ? { url: serverUrl, ok: true, version: "0.1.0" } : fx.base.server });
      }
      return { serverUrl, preferences: prefs, engine: { ...engineSettings } };
    },
    setApiKey: async (key) => { call("setApiKey", key); if (window.__keyError) throw new Error(window.__keyError); engineSettings.hasApiKey = key !== null; engineSettings.keyStorage = key === null ? "none" : "encrypted"; window.__push({ ...state, hasApiKey: key !== null }); return { serverUrl, preferences: prefs, engine: { ...engineSettings } }; },
    retryEngine: async (repair) => call("retryEngine", repair),
    openPythonDownload: async () => call("openPythonDownload"),
    checkServer: async (url) => { call("checkServer", url); return window.__serverCheck ?? { ok: true, version: "0.1.0" }; },
    listSources: async () => sources,
    startRecording: async (r) => call("startRecording", r),
    pauseRecording: async () => call("pauseRecording"), resumeRecording: async () => call("resumeRecording"), stopRecording: async () => call("stopRecording"),
    discardSession: async (id) => call("discardSession", id), uploadSession: async (id) => call("uploadSession", id), openJob: async (id) => call("openJob", id),
    revealSession: async (id) => call("revealSession", id), cancel: async () => call("cancel"),
    saveResults: async () => { call("saveResults"); return "/home/anna/Videos/Clipsmith 2026-10-31 17.12"; },
    newRecording: async () => call("newRecording"),
    onRecorderCommand: () => () => {}, recorderStarted() {}, recorderState() {}, recorderChunk() {}, recorderStopped() {}, recorderError() {},
  };
})();`;

const prefsDefault = { niche: "other", niche_notes: "", pace: "balanced", caption_style: "pop", source_type: "screen", language: "sv", target_minutes: 10, num_shorts: 4, remove_fillers: null };
const prefsSaved = { ...prefsDefault, niche: "garage", niche_notes: "Jag lagar gamla Volvo. Behåll alltid skämten.", pace: "balanced" };

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome",
  headless: false,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen", "--autoplay-policy=no-user-gesture-required"],
});

const problems = [];
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}\n       ${String(e.message).split("\n").filter(Boolean).slice(0, 6).join("\n       ")}`); problems.push(name); } };

async function newPage(theme, initial, prefs, viewport = { width: 1040, height: 780 }) {
  const ctx = await browser.newContext({ colorScheme: theme, viewport, locale: "sv-SE" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console.error: ${m.text()}`); });
  await page.addInitScript(fakeBridge({ initial, base: baseState, prefs, external: engineExternal }));
  await page.goto(`${base}/renderer/index.html`);
  await page.waitForSelector("h1");
  return page;
}
let pagesChecked = 0;
async function done(page) {
  const violations = await page.evaluate(() => window.__csp).catch(() => []);
  pagesChecked++;
  if (violations.length) problems.push(`CSP violations: ${violations.join(", ")}`);
  await page.context().close();
}
const calls = (page) => page.evaluate(() => window.__calls);
const push = async (page, patch) => { await page.evaluate((p) => window.__push(p), patch); await page.waitForTimeout(120); };
const snap = (page, theme, name) => page.screenshot({ path: join(outDir, `${theme}-${name}.png`), fullPage: true });

// ---- screens, both themes ------------------------------------------------------------------------------------
for (const theme of ["light", "dark"]) {
  // first run
  let page = await newPage(theme, { ...baseState, needsProfile: true }, null);
  await snap(page, theme, "01-profile-first-run");
  if (theme === "light") {
    await check("first run: profile form is forced, navigation to recording is disabled", async () => {
      assert.match(await page.textContent("h1"), /Berätta hur du vill ha dina videor/);
      assert.equal(await page.locator("nav button", { hasText: "Spela in" }).isDisabled(), true);
    });
    await check("first run: choices are saved exactly as picked and the app moves on to recording", async () => {
      await page.getByLabel("Mekanik och garage").check();
      await page.getByLabel("Snabbt").check();
      await page.getByLabel("Karaoke").check();
      await page.locator("#fillers").selectOption("yes");
      await page.locator("#language").selectOption("en");
      await page.evaluate(() => { const r = document.getElementById("minutes"); r.value = "12"; r.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.locator("#notes").fill("Lagar gamla Volvo.");
      await page.getByRole("button", { name: "Spara och fortsätt" }).click();
      await page.waitForSelector("h1:has-text('Spela in')");
      const saved = (await calls(page)).find((c) => c[0] === "saveSettings")[1].preferences;
      assert.deepEqual(saved, { niche: "garage", niche_notes: "Lagar gamla Volvo.", pace: "fast", caption_style: "karaoke", source_type: "screen", language: "en", target_minutes: 12, num_shorts: 4, remove_fillers: true });
    });
  }
  await done(page);

  // home
  page = await newPage(theme, baseState, prefsSaved);
  await page.waitForSelector(".source");
  await snap(page, theme, "02-home");
  if (theme === "light") {
    await check("home: sources listed, first screen preselected, one selection at a time", async () => {
      assert.equal(await page.locator(".source").count(), 4);
      assert.equal(await page.locator(".source[aria-pressed=true]").count(), 1);
      assert.match(await page.locator(".source[aria-pressed=true]").textContent(), /Skärm 1/);
      await page.locator(".source", { hasText: "Visual Studio Code" }).click();
      assert.equal(await page.locator(".source[aria-pressed=true]").count(), 1);
      assert.match(await page.locator(".source[aria-pressed=true]").textContent(), /Visual Studio Code/);
    });
    await check("home: the start button is visible without scrolling in a 1040x780 window", async () => {
      const box = await page.getByRole("button", { name: "Starta inspelning" }).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 780, `button at y=${box?.y} h=${box?.height}`);
      await page.screenshot({ path: join(outDir, `${theme}-02b-home-viewport.png`) });
    });
    await check("home: cannot start without any audio; start passes exactly what was chosen", async () => {
      const start = page.getByRole("button", { name: "Starta inspelning" });
      await page.getByLabel("Mikrofon", { exact: true }).uncheck();
      await page.getByLabel("Systemljud").uncheck();
      assert.equal(await start.isDisabled(), true);
      await page.getByLabel("Mikrofon", { exact: true }).check();
      assert.equal(await start.isDisabled(), false);
      await start.click();
      const req = (await calls(page)).find((c) => c[0] === "startRecording")[1];
      assert.deepEqual(req, { sourceId: "window:11:0", sourceName: "Visual Studio Code", systemAudio: false, micDeviceId: "", hideControls: true });
    });
    await check("home: remembered choices survive a reload", async () => {
      await page.reload();
      await page.waitForSelector(".source");
      assert.equal(await page.getByLabel("Systemljud").isChecked(), false);
      assert.equal(await page.getByLabel("Mikrofon", { exact: true }).isChecked(), true);
    });
    await check("history: three rows with the right buttons; delete needs a second click", async () => {
      assert.equal(await page.locator(".hrow").count(), 3);
      const first = page.locator(".hrow").nth(0);
      const second = page.locator(".hrow").nth(1);
      assert.ok(await first.getByRole("button", { name: "Visa resultat" }).isVisible());
      assert.ok(await second.getByRole("button", { name: "Skicka till redigering" }).isVisible());
      await second.getByRole("button", { name: "Ta bort" }).click();
      assert.equal((await calls(page)).filter((c) => c[0] === "discardSession").length, 0, "one click must not delete");
      await second.getByRole("button", { name: "Behåll" }).click();
      await second.getByRole("button", { name: "Ta bort" }).click();
      await second.getByRole("button", { name: "Ta bort filen" }).click();
      assert.deepEqual((await calls(page)).filter((c) => c[0] === "discardSession"), [["discardSession", "20261030-190012-d4e5f6"]]);
      await first.getByRole("button", { name: "Visa resultat" }).click();
      await second.getByRole("button", { name: "Skicka till redigering" }).click();
      const c = await calls(page);
      assert.ok(c.some((x) => x[0] === "openJob" && x[1] === "20261031-120401-a1b2c3"));
      assert.ok(c.some((x) => x[0] === "uploadSession" && x[1] === "20261030-190012-d4e5f6"));
      assert.match(await first.textContent(), /31:20/);
    });
  }
  await done(page);

  // pipeline phases
  page = await newPage(theme, baseState, prefsSaved);
  await push(page, { phase: "starting", session: { ...sessions[1] } });
  await snap(page, theme, "03a-starting");
  await push(page, { phase: "recording", session: { ...sessions[1] } });
  await snap(page, theme, "03b-recording");
  await push(page, { phase: "paused", session: { ...sessions[1] } });
  await snap(page, theme, "03c-paused");
  await push(page, { phase: "ready", session: { ...sessions[1] }, notice: "Systemljud är inte tillgängligt på den här datorn. Bara mikrofonen spelas in." });
  await snap(page, theme, "04-ready");
  if (theme === "light") {
    await check("ready: facts and the carried-over warning are shown", async () => {
      const text = await page.locator("main").textContent();
      assert.match(text, /12:14/);
      assert.match(text, /150 MB/);
      assert.match(text, /Systemljud är inte tillgängligt/);
    });
    await check("banner can be dismissed", async () => {
      await page.locator(".banner").getByRole("button", { name: "Stäng" }).click();
      assert.equal(await page.locator(".banner").count(), 0);
    });
  }
  await push(page, { phase: "uploading", session: { ...sessions[1] }, upload: { sent: 63_000_000, total: 150_000_000 } });
  await snap(page, theme, "05-uploading");
  if (theme === "light") {
    await check("uploading: bar and text follow the progress, then switch to 'server receiving'", async () => {
      assert.equal(await page.getByRole("progressbar").getAttribute("aria-valuenow"), "42");
      assert.match(await page.locator("main").textContent(), /63,0 MB av 150 MB/);
      await push(page, { phase: "uploading", session: { ...sessions[1] }, upload: { sent: 150_000_000, total: 150_000_000 } });
      assert.match(await page.locator("main").textContent(), /Motorn tar emot filen/);
      assert.ok(await page.locator(".bar.indeterminate").count());
      await page.getByRole("button", { name: "Avbryt" }).click();
      assert.ok((await calls(page)).some((c) => c[0] === "cancel"));
    });
  }
  await push(page, { phase: "processing", session: { ...sessions[1] }, job: { ...doneJob, status: "processing", stage: "rendering_short_2", progress: 0.55, outputs: [], result: null } });
  await snap(page, theme, "06-processing");
  if (theme === "light") {
    await check("processing: stage is explained in Swedish with percent", async () => {
      const text = await page.locator("main").textContent();
      assert.match(text, /Renderar short 2/);
      assert.match(text, /55 %/);
    });
  }
  await push(page, { phase: "failed", session: { ...sessions[1] }, error: "Motorn kunde inte bearbeta inspelningen. Försök igen, eller titta i loggen under fliken Motor.", engine: { ...engineReady, phase: "failed", url: null, version: null, problem: { code: "crash-loop", title: "Motorn fortsätter stanna", hint: "x" } }, server: { url: "", ok: false, version: null } });
  await snap(page, theme, "08-failed");
  if (theme === "light") {
    await check("failed: error is announced, recovery actions match the situation", async () => {
      assert.equal(await page.locator(".banner.error[role=alert]").count(), 1);
      assert.ok(await page.getByRole("button", { name: "Skicka till redigering igen" }).isVisible());
      assert.ok(await page.getByRole("button", { name: "Öppna Motor" }).isVisible());
    });
  }
  await done(page);

  // results
  page = await newPage(theme, baseState, prefsSaved);
  await push(page, { phase: "done", session: { ...sessions[0] }, job: doneJob, edl });
  await page.waitForFunction(() => document.querySelector("video.main-video")?.readyState >= 1, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  await snap(page, theme, "07-results");
  if (theme === "light") {
    await check("results: the cut strip adds up and the summary is right", async () => {
      const text = await page.locator("main").textContent();
      assert.match(text, /Huvudvideon blev 10:53 av 31:20/);
      assert.match(text, /65 % klipptes bort/);
      assert.match(text, /Behållet 10:53/);
      assert.match(text, /Borttaget 20:27/);
      assert.match(text, /5 tomgångar/);
      assert.equal(await page.locator(".strip .seg.kept").count(), kept.length);
      assert.equal(await page.locator(".strip .seg.cut").count(), kept.length, "gaps between, plus the tail after the last kept range");
    });
    await check("results: real video files load with the right aspect ratios", async () => {
      assert.equal(await page.locator(".shorts video").count(), 4);
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.readyState >= 1), null, { timeout: 8000 });
      const sizes = await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => [v.videoWidth, v.videoHeight]));
      assert.deepEqual(sizes[0], [1280, 720]);
      for (const s of sizes.slice(1)) assert.deepEqual(s, [720, 1280]);
    });
    await check("results: save reports where the files went", async () => {
      await page.getByRole("button", { name: "Spara alla filer" }).click();
      await page.waitForSelector(".saved:has-text('Sparat i')");
      assert.ok((await calls(page)).some((c) => c[0] === "saveResults"));
    });
    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForTimeout(150);
    await snap(page, theme, "07b-results-narrow");
    await check("results: no horizontal scroll at the minimum window width", async () => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    });
  }
  await done(page);

  // profile + server tabs
  page = await newPage(theme, baseState, prefsSaved);
  await page.locator("nav button", { hasText: "Profil" }).click();
  await page.waitForSelector("form");
  await snap(page, theme, "09-profile");
  await page.locator("nav button", { hasText: "Motor" }).click();
  await page.waitForSelector("#apikey");
  await snap(page, theme, "10-engine-ready");
  if (theme === "light") {
    await check("engine: ready state, model choice and the honest explanation of what a key does", async () => {
      const text = await page.locator("main").textContent();
      assert.match(text, /Motorn är redo \(v0\.1\.0\)/);
      assert.match(text, /En nyckel är sparad\. Den är krypterad/);
      assert.match(text, /videon blir inte kortare än så/);
      assert.equal(await page.getByLabel("Liten (ca 0,5 GB)").isChecked(), true);
      await page.getByLabel("Medel (ca 1,5 GB)").check();
      await page.waitForSelector("text=Modellen byts");
      assert.deepEqual((await calls(page)).filter((c) => c[0] === "saveSettings").at(-1)[1], { engine: { whisperModel: "medium" } });
    });
    await check("engine: the key field never shows an existing key, saving clears it, an empty field is refused", async () => {
      assert.equal(await page.locator("#apikey").inputValue(), "");
      assert.equal(await page.locator("#apikey").getAttribute("type"), "password");
      await page.getByRole("button", { name: "Byt nyckel" }).click();
      await page.waitForSelector("text=Klistra in nyckeln först.");
      await page.locator("#apikey").fill("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
      await page.getByRole("button", { name: "Byt nyckel" }).click();
      await page.waitForSelector("text=Nyckeln är sparad");
      assert.deepEqual((await calls(page)).filter((c) => c[0] === "setApiKey"), [["setApiKey", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"]]);
      assert.equal(await page.locator("#apikey").inputValue(), "", "the typed key is cleared after saving");
      assert.ok(!(await page.locator("main").innerHTML()).includes("abcdefghijklmnopqrstuvwxyz"), "the key is not rendered anywhere");
    });
    await check("engine: a rejected key shows the reason and keeps the field's text", async () => {
      await page.evaluate(() => { window.__keyError = "Error invoking remote method 'engine:set-key': Error: Nyckeln är för kort. Kopiera hela nyckeln från console.anthropic.com."; });
      await page.locator("#apikey").fill("kort");
      await page.getByRole("button", { name: "Byt nyckel" }).click();
      await page.waitForSelector("text=Nyckeln är för kort");
      assert.equal(await page.locator("#apikey").inputValue(), "kort");
    }).finally(() => page.evaluate(() => { window.__keyError = null; }));
    await check("engine: removing the key needs a second click", async () => {
      await page.getByRole("button", { name: "Ta bort nyckeln" }).click();
      assert.equal((await calls(page)).filter((c) => c[0] === "setApiKey" && c[1] === null).length, 0);
      await page.getByRole("button", { name: "Ta bort nyckeln" }).last().click();
      await page.waitForSelector("text=Nyckeln är borttagen");
      assert.ok((await calls(page)).some((c) => c[0] === "setApiKey" && c[1] === null));
      assert.match(await page.locator("main").textContent(), /Ingen nyckel är sparad/);
    });
    await check("engine: restart button calls retry without repair", async () => {
      await page.getByRole("button", { name: "Starta om motorn" }).click();
      assert.deepEqual((await calls(page)).filter((c) => c[0] === "retryEngine").at(-1), ["retryEngine", false]);
    });
    await check("engine: switching to your own server shows its address form and tests the connection", async () => {
      await page.locator("summary", { hasText: "Avancerat" }).click();
      await page.getByLabel("Använd min egen server").check();
      await page.waitForSelector("#url");
      assert.match(await page.locator("main").textContent(), /Du använder en egen server/);
      assert.equal((await page.locator("#apikey").count()), 0, "model and key belong to the other server now");
      await page.locator("#url").fill("backend.local:9000");
      await page.getByRole("button", { name: "Testa anslutningen" }).click();
      await page.waitForSelector("text=Servern svarar (version 0.1.0).");
      await page.getByRole("button", { name: "Spara adressen" }).click();
      assert.ok((await calls(page)).some((c) => c[0] === "saveSettings" && c[1].serverUrl === "backend.local:9000"));
      assert.match(await page.locator(".top").textContent(), /Servern svarar/);
      await snap(page, theme, "10b-engine-external");
      await page.getByLabel("Använd min egen server").uncheck();
      await page.waitForSelector("#apikey");
      assert.match(await page.locator(".top").textContent(), /Motorn är redo/);
    });
    await check("profile: edits are validated and saved without leaving the page", async () => {
      await page.locator("nav button", { hasText: "Profil" }).click();
      await page.waitForSelector("form");
      assert.equal(await page.getByLabel("Mekanik och garage").isChecked(), true, "saved profile is loaded");
      await page.getByLabel("Lugnt").check();
      await page.getByRole("button", { name: "Spara profil" }).click();
      await page.waitForSelector(".saved");
      const saved = (await calls(page)).filter((c) => c[0] === "saveSettings" && c[1].preferences).at(-1)[1].preferences;
      assert.equal(saved.pace, "calm");
      assert.equal(saved.niche, "garage");
    });
  }
  await done(page);

  // engine setup / problems on the Motor tab, and what the other tabs say about it meanwhile
  page = await newPage(theme, { ...baseState, engine: engineInstalling, server: { url: "", ok: false, version: null } }, prefsSaved);
  await page.waitForSelector(".source");
  if (theme === "light") {
    await check("setup in progress: banner on home, recording stays possible, no scary words", async () => {
      assert.match(await page.locator(".banner.notice").first().textContent(), /Redigeringsmotorn görs i ordning/);
      assert.equal(await page.locator(".banner.error").count(), 0);
      assert.equal(await page.getByRole("button", { name: /Starta inspelning/ }).isEnabled(), true);
      assert.match(await page.locator(".top").textContent(), /Förbereder motorn \(steg 2 av 4\)/);
    });
  }
  await snap(page, theme, "11-home-while-installing");
  await page.locator("nav button", { hasText: "Motor" }).click();
  await page.waitForSelector(".steps li");
  await snap(page, theme, "12-engine-installing");
  if (theme === "light") {
    await check("installing: four steps with the right one active, detail text and a live log", async () => {
      const states = await page.locator(".steps li").evaluateAll((els) => els.map((e) => e.dataset.state));
      assert.deepEqual(states, ["done", "active", "todo", "todo"]);
      assert.match(await page.locator("main").textContent(), /Första gången kan det ta flera minuter/);
      await page.locator("details.log summary").click();
      assert.match(await page.locator(".logbox").textContent(), /Downloading ctranslate2/);
    });
    await check("installing: progress pushes do not wipe a half-typed key or the open log", async () => {
      await page.locator("#apikey").fill("sk-ant-halvskriven");
      await push(page, { engine: { ...engineInstalling, log: [...installingLog, "pip: Installing collected packages: ctranslate2"] } });
      assert.equal(await page.locator("#apikey").inputValue(), "sk-ant-halvskriven");
      assert.equal(await page.locator("details.log").evaluate((d) => d.open), true);
      assert.match(await page.locator(".logbox").textContent(), /Installing collected packages/);
    });
  }
  await push(page, { engine: enginePythonFetch });
  await snap(page, theme, "12b-engine-python-fetch");
  if (theme === "light") {
    await check("no Python on the computer: the app says it is fetching its own, with progress, as part of step two", async () => {
      const states = await page.locator(".steps li").evaluateAll((els) => els.map((e) => e.dataset.state));
      assert.deepEqual(states, ["done", "active", "todo", "todo"]);
      assert.match(await page.locator("main").textContent(), /Hämtar en egen kopia/);
      assert.match(await page.locator(".logbox").textContent(), /23 av 48 MB/);
      assert.equal(await page.locator(".problem").count(), 0);
    });
  }
  await push(page, { engine: engineModel });
  await snap(page, theme, "13-engine-model");
  if (theme === "light") {
    await check("model download: step three is active and the progress line from the log is visible", async () => {
      const states = await page.locator(".steps li").evaluateAll((els) => els.map((e) => e.dataset.state));
      assert.deepEqual(states, ["done", "done", "active", "todo"]);
      assert.match(await page.locator(".logbox").textContent(), /198M\/484M/);
    });
  }
  await push(page, { engine: engineRestarting });
  if (theme === "light") {
    await check("after a crash: says it restarts, does not show the failure screen yet", async () => {
      assert.match(await page.locator("main").textContent(), /Startar om om 1 s/);
      assert.equal(await page.locator(".problem").count(), 0);
    });
  }
  await push(page, { engine: engineNoPython, server: { url: "", ok: false, version: null } });
  await page.waitForSelector(".problem");
  await snap(page, theme, "14-engine-no-python");
  if (theme === "light") {
    await check("Python download failed: the cause, what to do, and a button that opens python.org as the last resort", async () => {
      const text = await page.locator(".problem").textContent();
      assert.match(text, /Kunde inte hämta Python/);
      assert.match(text, /internetanslutningen/);
      assert.match(text, /Add python\.exe to PATH/);
      await page.getByRole("button", { name: "Öppna python.org" }).click();
      assert.ok((await calls(page)).some((c) => c[0] === "openPythonDownload"));
      await page.getByRole("button", { name: "Försök igen" }).click();
      assert.deepEqual((await calls(page)).filter((c) => c[0] === "retryEngine").at(-1), ["retryEngine", false]);
      await page.getByRole("button", { name: "Reparera installationen" }).click();
      assert.deepEqual((await calls(page)).filter((c) => c[0] === "retryEngine").at(-1), ["retryEngine", true]);
    });
  }
  await push(page, { engine: engineOffline });
  await snap(page, theme, "15-engine-offline");
  if (theme === "light") {
    await check("package download failed: the log shows pip's own error next to the explanation", async () => {
      assert.match(await page.locator(".problem").textContent(), /Kunde inte hämta Python-paketen/);
      assert.match(await page.locator(".logbox").textContent(), /No matching distribution found/);
      assert.equal(await page.locator("details.log").evaluate((d) => d.open), true, "the log opens by itself when something failed");
    });
    await check("engine down: the record tab warns and the recording can still be made", async () => {
      await page.locator("nav button", { hasText: "Spela in" }).click();
      await page.waitForSelector(".source");
      assert.match(await page.locator(".banner.error").first().textContent(), /Redigeringsmotorn fungerar inte/);
      assert.equal(await page.getByRole("button", { name: /Starta inspelning/ }).isEnabled(), true);
    });
  }
  await done(page);

  // a saved recording while the engine is not usable: the send button explains itself
  page = await newPage(theme, { ...baseState, phase: "ready", session: { ...sessions[0] }, engine: engineModel, server: { url: "", ok: false, version: null } }, prefsSaved);
  await page.waitForSelector("text=Inspelningen är sparad");
  await snap(page, theme, "16-ready-engine-not-ready");
  if (theme === "light") {
    await check("ready while engine prepares: send is disabled with the reason, enabled again when ready", async () => {
      const send = page.getByRole("button", { name: "Skicka till redigering" });
      assert.equal(await send.isDisabled(), true);
      assert.match(await page.locator("main").textContent(), /Redigeringsmotorn görs i ordning/);
      assert.equal(await page.locator(".banner").count(), 0, "one message, not two");
      assert.equal(await page.getByRole("button", { name: "Öppna Motor" }).isVisible(), true);
      await push(page, { phase: "ready", session: { ...sessions[0] }, engine: engineReady });
      assert.equal(await send.isEnabled(), true);
      assert.equal(await page.getByRole("button", { name: "Öppna Motor" }).isHidden(), true);
      assert.doesNotMatch(await page.locator("main").textContent(), /görs i ordning/);
    });
  }
  await done(page);

  // no key yet: the home screen says what that means, and the notice leads to the key field
  page = await newPage(theme, { ...baseState, hasApiKey: false }, prefsSaved);
  await page.waitForSelector(".source");
  await snap(page, theme, "17-home-no-key");
  if (theme === "light") {
    await check("no API key: honest notice on home, leads to the Motor tab, gone once a key exists", async () => {
      assert.match(await page.locator("main").textContent(), /Ingen AI-nyckel än/);
      assert.match(await page.locator("main").textContent(), /videon blir inte kortare än så/);
      await page.getByRole("button", { name: "Öppna Motor" }).click();
      await page.waitForSelector("#apikey");
      assert.match(await page.locator("main").textContent(), /Ingen nyckel är sparad/);
      await page.locator("#apikey").fill("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
      await page.getByRole("button", { name: "Spara nyckeln" }).click();
      await page.waitForSelector("text=Nyckeln är sparad");
      await page.locator("nav button", { hasText: "Spela in" }).click();
      await page.waitForSelector(".source");
      assert.doesNotMatch(await page.locator("main").textContent(), /Ingen AI-nyckel än/);
    });
  }
  await done(page);

  // your own server: no engine banners, the Motor tab shows only the address
  page = await newPage(theme, { ...baseState, engine: engineExternal, hasApiKey: false }, prefsSaved);
  await page.waitForSelector(".source");
  if (theme === "light") {
    await check("own server: no engine or key notices on home", async () => {
      assert.equal(await page.locator(".banner").count(), 0);
    });
  }
  await done(page);
}

// ---- keyboard focus is visible ---------------------------------------------------------------------------------
{
  const page = await newPage("light", baseState, prefsSaved);
  await page.waitForSelector(".source");
  await page.focus(".source");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  await check("keyboard focus shows an outline", async () => assert.notEqual(outline, "none"));
  await done(page);
}

await browser.close();
server.close();
if (!problems.some((p) => p.startsWith("CSP"))) results.push(`ok   no Content-Security-Policy violations on ${pagesChecked} page loads`);
console.log(results.join("\n"));
const unexpected = problems.filter((p) => !results.some((r) => r.includes(p)));
if (unexpected.length) console.log("\nPROBLEMS:\n" + unexpected.join("\n"));
process.exit(problems.length ? 1 : 0);
