// End-to-end: real Chromium recording (recorder bar + capture module) -> real Controller -> real BackendManager
// (spawns, health-checks and stops the engine process) -> real HTTP upload -> the backend's real pipeline (HTTP shell
// swapped for backend_shim.py, no pip install) -> download -> inspect the files.
// Everything except the Electron windows/IPC, pip and the real model is the code that ships.
//
//   xvfb-run -a -s "-screen 0 1280x720x24" node run-e2e.mjs <distRendererDir> <workDir> [recordSeconds]
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { extname, join } from "node:path";

import { buildCutStrip } from "../../src/shared/cutstrip.ts";
import { defaultPreferences } from "../../src/shared/preferences.ts";
import { BackendManager, stampFor } from "../../src/main/backend-manager.ts";
import { Controller } from "../../src/main/controller.ts";
import { findPython } from "../../src/main/python.ts";
import { SessionStore } from "../../src/main/sessions.ts";
import { SettingsStore } from "../../src/main/settings.ts";

const [dist, work, seconds = "50"] = process.argv.slice(2);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const here = new URL(".", import.meta.url).pathname;
const RECORD_MS = Number(seconds) * 1000;
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const ffprobe = (path, entries, stream = "v:0") => spawnSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "csv=p=0", path], { encoding: "utf8" }).stdout.trim();
const results = [];
const step = (name) => (cond, detail = "") => { results.push(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`); return cond; };
const t0 = Date.now();
const log = (msg) => console.error(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${msg}`);

// ---- the backend: started and supervised by the app's own BackendManager ------------------------------------------
const BACKEND = new URL("../../../backend", import.meta.url).pathname;
const SHIM = join(here, "backend_shim.py");
const engineDir = join(work, "engine");
const pythonExe = (await findPython()).python?.executable;
if (!pythonExe) throw new Error("no python3 on this machine");
// An "already installed" engine: what the first-run setup would have left behind (venv, requirements stamp, model stamp).
mkdirSync(join(engineDir, "venv", "bin"), { recursive: true });
symlinkSync(pythonExe, join(engineDir, "venv", "bin", "python"));
writeFileSync(join(engineDir, "setup.json"), stampFor(readFileSync(join(BACKEND, "requirements.txt"), "utf8")));
mkdirSync(join(engineDir, "models"), { recursive: true });
writeFileSync(join(engineDir, "models", "small.ok"), "small");
const dataDir = join(engineDir, "data");
const managers = [];
const makeEngine = () => {
  const m = new BackendManager({
    backendDir: BACKEND,
    engineDir,
    getConfig: () => ({ whisperModel: "small", apiKey: null }),
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
    commands: {
      check: () => ["-c", "import json; print(json.dumps({'ok': True, 'checks': []}))"],
      serve: (port, dir) => [SHIM, "--host", "127.0.0.1", "--port", String(port), "--data-dir", dir, "--exit-when-stdin-closes"],
    },
  });
  managers.push(m);
  return m;
};
/** What the stand-in server reported for each received file (it prints one UPLOAD line per upload; the manager keeps them in its log). */
const uploadsOf = (m) => m.info().log.filter((l) => l.startsWith("motor: UPLOAD ")).map((l) => JSON.parse(l.slice("motor: UPLOAD ".length)));

// ---- the recorder window, served like the real app serves it ----------------------------------------------------
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
const staticServer = http.createServer((req, res) => {
  const file = join(dist, new URL(req.url, "http://x").pathname);
  if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((r) => staticServer.listen(0, "127.0.0.1", r));

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", headless: false,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--auto-select-desktop-capture-source=Entire screen"],
});
const page = await (await browser.newContext({ viewport: { width: 400, height: 56 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

let controller;
let startedInfo = null;
await page.exposeFunction("__to", (name, payload) => {
  switch (name) {
    case "started": startedInfo = payload; void controller.onRecorderStarted(payload); break;
    case "state": controller.onRecorderState(payload); break;
    case "chunk": controller.onRecorderChunk(Buffer.from(payload, "base64")); break;
    case "stopped": void controller.onRecorderStopped(payload); break;
    case "error": void controller.onRecorderError(payload); break;
  }
});
await page.addInitScript(`(() => {
  let handler = null;
  window.__send = (cmd) => handler(cmd);
  const b64 = (ab) => { const u = new Uint8Array(ab); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  window.clipsmith = {
    onRecorderCommand: (cb) => { handler = cb; return () => {}; },
    recorderStarted: (i) => window.__to("started", i), recorderState: (s) => window.__to("state", s),
    recorderChunk: (d) => window.__to("chunk", b64(d)), recorderStopped: (i) => window.__to("stopped", i), recorderError: (m) => window.__to("error", m),
  };
})();`);
await page.goto(`http://127.0.0.1:${staticServer.address().port}/renderer/recorder.html`);

const folder = join(work, "saved");
mkdirSync(folder);
const host = {
  async listSources() { return []; },
  selectSource() {},
  openRecorder(config) { void page.evaluate((c) => window.__send({ type: "start", config: c }), config); },
  commandRecorder(cmd) { void page.evaluate((c) => window.__send({ type: c }), cmd); },
  closeRecorder() {}, setMainWindowVisible() {}, registerShortcuts() {}, unregisterShortcuts() {},
  async chooseFolder() { return folder; },
  reveal() {}, screenPermission: () => "granted", askMicrophone: async () => true,
};

async function makeController() {
  const sessions = new SessionStore(join(work, "recordings"));
  const settings = new SettingsStore(join(work, "settings.json"));
  await settings.load();
  await settings.save({ preferences: { ...defaultPreferences(), niche: "garage", pace: "balanced", num_shorts: 2, language: "sv", target_minutes: 1 } });
  const engine = makeEngine();
  const c = new Controller({ sessions, settings, host, engine, countdownSeconds: 1, pollIntervalMs: 500 });
  await c.init();
  return { c, sessions, engine };
}

const phases = [];
let uploadSamples = [];
const waitFor = (pred, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}; phase=${controller.getState().phase} error=${controller.getState().error}`)), ms);
  const check = (s) => { if (pred(s)) { clearTimeout(timer); off(); resolve(s); } };
  const off = controller.onState(check);
  check(controller.getState());
});

try {
  const made = await makeController();
  controller = made.c;
  controller.onState((s) => { if (phases.at(-1) !== s.phase) phases.push(s.phase); if (s.upload) uploadSamples.push(s.upload); });
  const engineUp = await waitFor((s) => s.engine.phase === "ready" || s.engine.phase === "failed", 30000, "the engine to start");
  step("engine: the app starts its own backend and it reports ready with a version")(engineUp.engine.phase === "ready" && engineUp.engine.version === "0.1.0" && /^http:\/\/127\.0\.0\.1:\d+$/.test(engineUp.engine.url ?? ""), `${engineUp.engine.phase} ${engineUp.engine.version} ${engineUp.engine.url} ${engineUp.engine.problem?.title ?? ""}`);
  step("engine: the job server address follows the engine, not the settings")(engineUp.server.url === engineUp.engine.url && engineUp.server.ok === true);

  // ---- 1. record ------------------------------------------------------------------------------------------------
  log("recording");
  await controller.startRecording({ sourceId: "screen:0:0", sourceName: "Skärm 1", systemAudio: true, micDeviceId: "", hideControls: true });
  await waitFor((s) => s.phase === "recording", 20000, "recording to start");
  await new Promise((r) => setTimeout(r, RECORD_MS * 0.4));
  controller.pause();
  await waitFor((s) => s.phase === "paused", 5000, "pause");
  await new Promise((r) => setTimeout(r, 2000));
  controller.resume();
  await waitFor((s) => s.phase === "recording", 5000, "resume");
  await new Promise((r) => setTimeout(r, RECORD_MS * 0.6));
  controller.stop();
  const ready = await waitFor((s) => s.phase === "ready" || s.phase === "failed", 30000, "recording to be saved");
  step("record: the recording is saved and ready to upload")(ready.phase === "ready", `phase=${ready.phase} ${ready.error ?? ""}`);
  const meta = ready.session;
  const file = made.sessions.filePath(meta);
  step("record: a real file with the right container is on disk")(statSync(file).size === meta.bytes && meta.bytes > 100_000 && meta.ext === "webm", `${meta.ext}, ${(meta.bytes / 1e6).toFixed(1)} MB, ${meta.mimeType}`);
  step("record: pause time is excluded from the reported duration")(meta.durationMs > RECORD_MS - 3000 && meta.durationMs < RECORD_MS + 3000, `${(meta.durationMs / 1000).toFixed(1)} s for ${(RECORD_MS / 1000).toFixed(0)} s of recording + 2 s pause`);
  step("record: whatever the recorder warned about reaches the user as a notice, never as an error")(
    JSON.stringify(startedInfo?.warnings ?? []) === JSON.stringify(ready.notice ? [ready.notice] : []) || (startedInfo.warnings.join(" ") === ready.notice),
    `recorder warnings: ${JSON.stringify(startedInfo?.warnings)}; notice: ${JSON.stringify(ready.notice)}`);
  step("record: no orphan sessions, history lists exactly this recording")(ready.sessions.length === 1 && ready.sessions[0].id === meta.id);

  // ---- 2. upload + process ------------------------------------------------------------------------------------------------
  log("uploading + processing");
  uploadSamples = [];
  await controller.uploadSession(meta.id);
  const done = controller.getState();
  step("pipeline: the job finishes")(done.phase === "done", `phase=${done.phase} ${done.error ?? ""} job.error=${done.job?.error ?? ""}`);
  if (done.phase !== "done") throw new Error("job did not finish: " + (done.error ?? ""));
  const uploads = uploadsOf(made.engine);
  step("upload: Content-Length was exact and the server received every byte")(uploads.length === 1 && uploads[0].content_length === uploads[0].received && uploads[0].file_bytes === meta.bytes, JSON.stringify(uploads[0]));
  step("upload: progress rose monotonically to 100 %")(uploadSamples.length >= 2 && uploadSamples.every((u, i) => i === 0 || u.sent >= uploadSamples[i - 1].sent) && uploadSamples.at(-1).sent === uploadSamples.at(-1).total, `${uploadSamples.length} samples`);
  if (phases[0] === "idle") phases.shift(); // the server health check from init() can land after we subscribed
  step("flow: phases happened in order")(JSON.stringify(phases) === JSON.stringify(["starting", "recording", "paused", "recording", "finalizing", "ready", "uploading", "processing", "done"]), phases.join(" > "));

  const result = done.job.result;
  const srcDur = result.source.duration;
  step("ingest: the cue-less MediaRecorder file got a sane duration")(Math.abs(srcDur - meta.durationMs / 1000 - 2) < 4 || Math.abs(srcDur - meta.durationMs / 1000) < 4, `backend says ${srcDur.toFixed(1)} s, recorder says ${(meta.durationMs / 1000).toFixed(1)} s active + 2 s pause`);
  step("edit: exactly the one deliberate retake was cut (the earlier take), nothing else")(
    result.main.cuts.length === 1 && result.main.cuts[0].reason === "retake" && result.main.cuts[0].from_id === 2 && result.main.dropped_units === 1,
    JSON.stringify(result.main.cuts));
  step("edit: pauses were tightened, so the edit is much shorter than the source")(result.main.duration < srcDur * 0.7, `${result.main.duration.toFixed(1)} s of ${srcDur.toFixed(1)} s`);
  step("shorts: at least one vertical short was made")(result.shorts.length >= 1, `${result.shorts.length} shorts`);

  const strip = buildCutStrip(done.edl, srcDur);
  step("cut strip: built from the real EDL and adds up to the source")(done.edl.length > 0 && Math.abs(strip.keptSeconds + strip.removedSeconds - srcDur) < 0.01 && Math.abs(strip.keptSeconds - result.main.duration) < 1.5, `kept ${strip.keptSeconds.toFixed(1)} s, main.mp4 ${result.main.duration.toFixed(1)} s`);

  // ---- 3. save the results ---------------------------------------------------------------------------------------------------
  log("saving results");
  const target = await controller.saveResults();
  const names = readdirSync(target).sort();
  step("save: main video, subtitles and every short were downloaded")(names.includes("main.mp4") && names.includes("main.srt") && result.shorts.every((s) => names.includes(s.file)), names.join(", "));
  const jobOut = join(dataDir, "jobs", done.job.id, "output");
  step("engine: the uploaded copy is deleted once the job is done (the recording itself stays in the app's folder)")(!existsSync(join(dataDir, "jobs", done.job.id, "source.webm")) && existsSync(file), readdirSync(join(dataDir, "jobs", done.job.id)).join(", "));
  step("save: downloaded files are byte-identical to what the backend produced")(names.every((n) => sha(join(target, n)) === sha(join(jobOut, n))));
  const mainDur = Number(ffprobe(join(target, "main.mp4"), "format=duration", "v:0"));
  step("main.mp4: plays, and its real duration matches the manifest")(Math.abs(mainDur - result.main.duration) < 1, `${mainDur.toFixed(2)} s vs ${result.main.duration.toFixed(2)} s`);
  const dims = result.shorts.map((s) => ffprobe(join(target, s.file), "stream=width,height"));
  step("shorts: 1080x1920 vertical")(dims.every((d) => d === "1080,1920"), dims.join(" "));
  step("main.mp4 and shorts carry audio")(["main.mp4", ...result.shorts.map((s) => s.file)].every((n) => ffprobe(join(target, n), "stream=codec_name", "a:0") !== ""));

  // ---- 4. app restart: re-attach to the job ----------------------------------------------------------------------------------
  const pid1 = made.engine.info().url;
  await controller.shutdown();
  step("quit: shutting the app down stops the engine (nothing keeps listening)")(made.engine.url() === null && (await fetch(`${pid1}/health`).then(() => false, () => true)), `engine phase ${made.engine.info().phase}`);
  const second = await makeController();
  controller = second.c;
  await waitFor((s) => s.engine.phase === "ready", 30000, "the engine to start again");
  const listed = controller.getState().sessions;
  step("restart: the recording is still in the history with its job id")(listed.length === 1 && listed[0].jobId === done.job.id);
  await controller.openJob(listed[0].id);
  const reopened = controller.getState();
  step("restart: opening the job from history shows the same finished result")(reopened.phase === "done" && reopened.job.result.main.duration === result.main.duration && reopened.edl?.length === done.edl.length);
} catch (e) {
  results.push(`FAIL aborted: ${e.stack ?? e}`);
} finally {
  results.push(pageErrors.length ? `FAIL page errors: ${pageErrors.join("; ")}` : "ok   no page errors in the recorder window");
  await browser.close();
  staticServer.close();
  await Promise.all(managers.map((m) => m.stop()));
  console.log(results.join("\n"));
  process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
}
