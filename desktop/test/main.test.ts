import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { ApiError, ClipsmithApi } from "../src/shared/api.ts";
import { offEngineInfo } from "../src/shared/engine.ts";
import type { EngineInfo } from "../src/shared/engine.ts";
import { RECORDER_CANCELLED } from "../src/shared/ipc.ts";
import type { AppState, RecorderConfig } from "../src/shared/ipc.ts";
import { defaultPreferences } from "../src/shared/preferences.ts";
import { Controller } from "../src/main/controller.ts";
import type { Engine, Host } from "../src/main/controller.ts";
import { downloadFile } from "../src/main/download.ts";
import { RecordingSink } from "../src/main/recording-sink.ts";
import { SessionStore } from "../src/main/sessions.ts";
import { ApiKeyStore } from "../src/main/secrets.ts";
import type { SecretCodec } from "../src/main/secrets.ts";
import { SettingsStore } from "../src/main/settings.ts";
import { json, parseMultipart, readBody, startServer } from "./support/server.ts";
import type { TestServer } from "./support/server.ts";

const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");
const noSleep = async () => {};

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "clipsmith-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

class FakeHost implements Host {
  calls: string[] = [];
  recorderConfig: RecorderConfig | null = null;
  mainVisible = true;
  shortcuts = false;
  folder: string | null = null;
  revealed: string[] = [];
  screen: "granted" | "denied" | "unknown" = "granted";
  mic = true;
  selected: { id: string; audio: boolean } | null = null;
  async listSources() {
    return [{ id: "screen:0", name: "Skärm 1", kind: "screen" as const, thumbnail: "data:," }];
  }
  selectSource(id: string, audio: boolean) { this.selected = { id, audio }; }
  openRecorder(c: RecorderConfig) { this.recorderConfig = c; this.calls.push("open"); }
  commandRecorder(cmd: "pause" | "resume" | "stop") { this.calls.push(cmd); }
  closeRecorder() { this.calls.push("close"); }
  setMainWindowVisible(v: boolean) { this.mainVisible = v; }
  registerShortcuts() { this.shortcuts = true; }
  unregisterShortcuts() { this.shortcuts = false; }
  async chooseFolder() { return this.folder; }
  reveal(p: string) { this.revealed.push(p); }
  screenPermission() { return this.screen; }
  async askMicrophone() { return this.mic; }
}

interface Backend {
  server: TestServer;
  uploads: Array<{ prefs: Record<string, unknown>; filename: string; sha: string; bytes: number; contentLength: string }>;
  jobScript: Array<Record<string, unknown>>;
  files: Record<string, Buffer>;
  jobId: string;
}

const JOB_ID = "d".repeat(32);

async function startBackend(): Promise<Backend> {
  const b: Backend = {
    uploads: [],
    jobId: JOB_ID,
    files: {
      "main.mp4": randomBytes(5000),
      "main.srt": Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nhej\n"),
      "short_1.mp4": randomBytes(3000),
      "manifest.json": Buffer.from("{}"),
      "main.edl.json": Buffer.from(JSON.stringify([{ src_start: 1, src_end: 5, out_start: 0 }])),
    },
    jobScript: [
      { status: "processing", stage: "transcribing", progress: 0.2 },
      { status: "done", stage: "done", progress: 1, outputs: ["main.mp4", "main.srt", "short_1.mp4", "manifest.json", "main.edl.json"] },
    ],
    server: undefined as unknown as TestServer,
  };
  let polls = 0;
  b.server = await startServer(async (req, res) => {
    const url = req.url ?? "";
    if (url === "/health") return json(res, 200, { ok: true, version: "0.1.0" });
    if (req.method === "POST" && url === "/jobs") {
      const body = await readBody(req);
      const parts = parseMultipart(body, String(req.headers["content-type"]));
      const video = parts.find((p) => p.name === "video")!;
      b.uploads.push({ prefs: JSON.parse(parts.find((p) => p.name === "preferences")!.data.toString()), filename: video.filename!, sha: sha(video.data), bytes: video.data.length, contentLength: String(req.headers["content-length"]) });
      return json(res, 202, { id: b.jobId, status: "queued", stage: null, progress: 0, error: null, outputs: [], result: null });
    }
    const m = /^\/jobs\/([0-9a-f]{32})(?:\/files\/(.+))?$/.exec(url);
    if (m && !m[2]) {
      const step = b.jobScript[Math.min(polls++, b.jobScript.length - 1)]!;
      return json(res, 200, { id: m[1], created_at: 0, preferences: {}, error: null, outputs: [], result: null, ...step });
    }
    if (m && m[2]) {
      const file = b.files[decodeURIComponent(m[2])];
      if (!file) return json(res, 404, { detail: "File not found" });
      res.setHeader("content-length", String(file.length));
      return void res.end(file);
    }
    json(res, 404, { detail: "Not found" });
  });
  return b;
}

async function setup(host: FakeHost, backend: Backend, opts: { profile?: boolean } = {}) {
  const sessions = new SessionStore(join(tmp, "recordings"));
  const settings = new SettingsStore(join(tmp, "settings.json"));
  await settings.load();
  await settings.save({ serverUrl: backend.server.url, preferences: opts.profile === false ? null : { ...defaultPreferences(), niche: "tutorial" } });
  const controller = new Controller({
    sessions, settings, host,
    createApi: (url) => new ClipsmithApi({ baseUrl: url, sleep: noSleep, uploadRetries: 0 }),
    countdownSeconds: 0, startTimeoutMs: 200, pollIntervalMs: 1,
    now: () => Date.parse("2026-10-31T17:12:00Z"),
  });
  await controller.init();
  return { controller, sessions, settings };
}

const START = { sourceId: "screen:0", sourceName: "Skärm 1", systemAudio: true, micDeviceId: "", hideControls: true };

function waitFor(controller: Controller, pred: (s: AppState) => boolean, ms = 3000): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const now = controller.getState();
    if (pred(now)) return resolve(now);
    const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for state; phase=${controller.getState().phase}`)); }, ms);
    const off = controller.onState((s) => { if (pred(s)) { clearTimeout(timer); off(); resolve(s); } });
  });
}

async function record(controller: Controller, chunks: Buffer[], mime = "video/webm;codecs=vp9,opus") {
  await controller.startRecording(START);
  await controller.onRecorderStarted({ mimeType: mime });
  for (const c of chunks) controller.onRecorderChunk(c); // deliberately not awaited, like IPC
  await controller.onRecorderStopped({ durationMs: 12_345 });
}

describe("RecordingSink", () => {
  test("keeps order for many un-awaited appends and reports bytes", async () => {
    const path = join(tmp, "r.webm");
    const sink = await RecordingSink.open(path);
    const chunks = Array.from({ length: 800 }, (_, i) => Buffer.alloc(1000 + (i % 7), i % 251));
    const writes = chunks.map((c) => sink.append(c));
    await Promise.all(writes);
    assert.equal(await sink.close(), chunks.reduce((n, c) => n + c.length, 0));
    assert.equal(sha(await readFile(path)), sha(Buffer.concat(chunks)));
    await assert.rejects(sink.append(Buffer.alloc(1)), /closed/);
    assert.equal(await sink.close(), sink.bytes, "close is idempotent");
  });
});

describe("SessionStore", () => {
  test("create/update/list, atomic json, id validation", async () => {
    const store = new SessionStore(join(tmp, "s"));
    const a = await store.create({ sourceName: "A", now: new Date("2026-10-31T10:00:00Z") });
    const b = await store.create({ sourceName: "B", now: new Date("2026-10-31T11:00:00Z") });
    await store.update(a.id, { state: "stopped", bytes: 5 });
    assert.deepEqual((await store.list()).map((m) => m.sourceName), ["B", "A"], "newest first");
    assert.equal((await store.get(a.id))!.bytes, 5);
    assert.deepEqual((await readdir(store.dir(a.id))).filter((n) => n.endsWith(".tmp")), []);
    assert.throws(() => store.dir("../../etc"), /Invalid session id/);
    assert.equal(await store.get("not-an-id"), null);
    await store.remove(b.id);
    assert.equal((await store.list()).length, 1);
  });

  test("recoverOrphans keeps interrupted recordings that have data and drops empty ones", async () => {
    const store = new SessionStore(join(tmp, "s"));
    const kept = await store.create({ sourceName: "kept" });
    await store.update(kept.id, { state: "recording", ext: "webm" });
    await writeFile(store.filePath((await store.get(kept.id))!)!, randomBytes(2048));
    const empty = await store.create({ sourceName: "empty", now: new Date(Date.now() + 5000) });
    await store.update(empty.id, { state: "recording", ext: "webm" });
    const done = await store.create({ sourceName: "done", now: new Date(Date.now() + 9000) });
    await store.update(done.id, { state: "stopped", ext: "mp4", bytes: 10 });

    const recovered = await store.recoverOrphans();
    assert.deepEqual(recovered.map((m) => [m.sourceName, m.state, m.bytes]), [["kept", "recovered", 2048]]);
    assert.equal(await store.get(empty.id), null);
    assert.equal((await store.get(done.id))!.state, "stopped");
  });
});

describe("SettingsStore", () => {
  test("persists, validates and survives a corrupt file", async () => {
    const path = join(tmp, "settings.json");
    const s = new SettingsStore(path);
    assert.equal((await s.load()).preferences, null);
    await assert.rejects(s.save({ serverUrl: "ftp://nope" }), /http/);
    await assert.rejects(s.save({ preferences: { ...defaultPreferences(), num_shorts: 99 } }), /shorts/);
    await s.save({ serverUrl: "myserver:9000", preferences: { ...defaultPreferences(), niche: "garage" } });
    const again = await new SettingsStore(path).load();
    assert.equal(again.serverUrl, "http://myserver:9000");
    assert.equal(again.preferences!.niche, "garage");
    await writeFile(path, "{ not json");
    assert.equal((await new SettingsStore(path).load()).preferences, null);
  });
});

describe("downloadFile", () => {
  test("streams to disk with progress; failures leave no partial file", async () => {
    const data = randomBytes(300_000);
    const srv = await startServer((req, res) => {
      if (req.url === "/ok") { res.setHeader("content-length", String(data.length)); return void res.end(data); }
      json(res, 404, { detail: "File not found" });
    });
    try {
      let last = 0;
      const n = await downloadFile(`${srv.url}/ok`, join(tmp, "out.bin"), { onProgress: (b) => (last = b) });
      assert.equal(n, data.length);
      assert.equal(last, data.length);
      assert.equal(sha(await readFile(join(tmp, "out.bin"))), sha(data));
      await assert.rejects(downloadFile(`${srv.url}/missing`, join(tmp, "x.bin")), (e: unknown) => e instanceof ApiError && e.status === 404);
      assert.deepEqual((await readdir(tmp)).filter((f) => f.startsWith("x.bin")), []);
    } finally {
      await srv.close();
    }
  });
});

describe("Controller: the whole flow", () => {
  test("record -> stop -> upload -> process -> save results", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller, sessions } = await setup(host, backend);
      assert.equal(controller.getState().server.url, backend.server.url);
      await waitFor(controller, (s) => s.server.ok === true);

      await controller.startRecording(START);
      assert.equal(controller.getState().phase, "starting");
      assert.equal(host.mainVisible, false, "main window gets out of the way");
      assert.deepEqual(host.selected, { id: "screen:0", audio: true });
      assert.equal(host.recorderConfig!.sessionId, controller.getState().session!.id);
      assert.equal(host.recorderConfig!.hideControls, true, "the hide-controls choice reaches the recorder window");

      await controller.onRecorderStarted({ mimeType: "video/webm;codecs=vp9,opus" });
      assert.equal(controller.getState().phase, "recording");
      assert.equal(host.shortcuts, true);
      const chunks = Array.from({ length: 50 }, () => randomBytes(10_000));
      for (const c of chunks) controller.onRecorderChunk(c);
      controller.onRecorderState("paused");
      assert.equal(controller.getState().phase, "paused");
      controller.onRecorderState("recording");
      await controller.onRecorderStopped({ durationMs: 12_345 });

      let s = controller.getState();
      assert.equal(s.phase, "ready");
      assert.equal(s.session!.bytes, 500_000);
      assert.equal(s.session!.durationMs, 12_345);
      assert.equal(s.session!.state, "stopped");
      assert.equal(host.mainVisible, true);
      assert.equal(host.shortcuts, false);
      assert.equal(sha(await readFile(sessions.filePath(s.session!)!)), sha(Buffer.concat(chunks)), "file on disk equals what was sent");

      const id = s.session!.id;
      await controller.uploadSession(id);
      s = controller.getState();
      assert.equal(s.phase, "done", s.error ?? "");
      assert.equal(backend.uploads.length, 1);
      const up = backend.uploads[0]!;
      assert.equal(up.sha, sha(Buffer.concat(chunks)));
      assert.equal(up.filename, "recording.webm");
      assert.equal(up.prefs.niche, "tutorial");
      assert.equal(up.prefs.source_type, "screen");
      assert.equal(s.session!.state, "uploaded");
      assert.equal(s.session!.jobId, JOB_ID);
      assert.deepEqual(s.edl, [{ src_start: 1, src_end: 5, out_start: 0 }]);
      assert.equal(s.upload, null);

      host.folder = join(tmp, "Videor");
      await mkdir(host.folder);
      const target = await controller.saveResults();
      assert.ok(target && target.startsWith(host.folder));
      assert.deepEqual((await readdir(target!)).sort(), ["main.mp4", "main.srt", "short_1.mp4"], "internal files are not exported");
      assert.equal(sha(await readFile(join(target!, "main.mp4"))), sha(backend.files["main.mp4"]!));
      assert.deepEqual(host.revealed, [target]);
      assert.notEqual(await controller.saveResults(), target, "a second save gets its own folder");

      controller.newRecording();
      assert.equal(controller.getState().phase, "idle");
      assert.equal(controller.getState().sessions.length, 1, "recording stays in the history");
    } finally {
      await backend.server.close();
    }
  });

  test("refuses to start without audio, without permission, or with a blocked microphone", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await controller.startRecording({ ...START, systemAudio: false, micDeviceId: null });
      assert.equal(controller.getState().phase, "idle");
      assert.match(controller.getState().error!, /mikrofon eller systemljud/);

      host.screen = "denied";
      await controller.startRecording(START);
      assert.match(controller.getState().error!, /tillåtelse/);
      host.screen = "granted";

      host.mic = false;
      await controller.startRecording(START);
      assert.match(controller.getState().error!, /Mikrofonen är blockerad/);
      assert.equal(host.calls.includes("open"), false, "no recorder window was opened");
      assert.equal((await controller.getState().sessions).length, 0, "no empty session left behind");
    } finally {
      await backend.server.close();
    }
  });

  test("a recorder that never starts is cleaned up", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await controller.startRecording(START);
      await controller.onRecorderError("NotAllowedError: Permission denied");
      const s = controller.getState();
      assert.equal(s.phase, "idle");
      assert.match(s.error!, /kunde inte starta.*NotAllowedError/);
      assert.equal(s.sessions.length, 0);
      assert.equal(host.mainVisible, true);
      assert.ok(host.calls.includes("close"));

      await controller.startRecording(START); // and the start timeout does the same
      await waitFor(controller, (x) => x.phase === "idle" && !!x.error, 2000);
      assert.match(controller.getState().error!, /aldrig igång/);
    } finally {
      await backend.server.close();
    }
  });

  test("cancelling during the countdown is silent and leaves nothing behind", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await controller.startRecording(START);
      assert.equal(controller.getState().phase, "starting");
      await controller.onRecorderError(RECORDER_CANCELLED);
      const s = controller.getState();
      assert.equal(s.phase, "idle");
      assert.equal(s.error, null, "a cancel is not an error");
      assert.equal(s.sessions.length, 0);
      assert.equal(host.mainVisible, true);
      assert.ok(host.calls.includes("close"));
    } finally {
      await backend.server.close();
    }
  });

  test("warnings from the recorder (e.g. no system audio) survive until the recording is saved", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await controller.startRecording(START);
      await controller.onRecorderStarted({ mimeType: "video/webm", warnings: ["Systemljud är inte tillgängligt på den här datorn.", "Bara mikrofonen spelas in."] });
      controller.onRecorderChunk(randomBytes(500));
      await controller.onRecorderStopped({ durationMs: 1000 });
      const s = controller.getState();
      assert.equal(s.phase, "ready");
      assert.match(s.notice!, /Systemljud är inte tillgängligt.*Bara mikrofonen/);
    } finally {
      await backend.server.close();
    }
  });

  test("a recorder error mid-recording keeps what was recorded", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await controller.startRecording(START);
      await controller.onRecorderStarted({ mimeType: "video/mp4;codecs=avc1.640028,mp4a.40.2" });
      controller.onRecorderChunk(randomBytes(4000));
      await controller.onRecorderError("MediaRecorder encoding error");
      const s = controller.getState();
      assert.equal(s.phase, "ready");
      assert.equal(s.session!.bytes, 4000);
      assert.equal(s.session!.ext, "mp4");
      assert.match(s.notice!, /avbröts.*sparat/);
    } finally {
      await backend.server.close();
    }
  });

  test("recording that produced no bytes fails clearly and leaves nothing behind", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await record(controller, []);
      const s = controller.getState();
      assert.equal(s.phase, "failed");
      assert.match(s.error!, /Ingen video sparades/);
      assert.equal(s.sessions.length, 0);
    } finally {
      await backend.server.close();
    }
  });

  test("a failing disk stops the recorder and keeps the partial file", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await controller.startRecording(START);
      await controller.onRecorderStarted({ mimeType: "video/webm" });
      controller.onRecorderChunk(randomBytes(3000));
      const sink = await (controller as unknown as { sinkReady: Promise<RecordingSink> }).sinkReady;
      await new Promise((r) => setTimeout(r, 20));
      sink.append = () => Promise.reject(new Error("ENOSPC: no space left on device"));
      controller.onRecorderChunk(randomBytes(3000));
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(host.calls.includes("stop"), "recorder was told to stop");
      await controller.onRecorderStopped({ durationMs: 1000 });
      const s = controller.getState();
      assert.equal(s.phase, "ready");
      assert.equal(s.session!.bytes, 3000);
      assert.match(s.notice!, /ENOSPC/);
    } finally {
      await backend.server.close();
    }
  });

  test("a job that fails on the server shows an actionable message, and the user can retry", async () => {
    const backend = await startBackend();
    backend.jobScript = [{ status: "failed", stage: "analysing", error: "The video has no audio track, so there is no speech to edit." }];
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend);
      await record(controller, [randomBytes(2000)]);
      await controller.uploadSession(controller.getState().session!.id);
      let s = controller.getState();
      assert.equal(s.phase, "failed");
      assert.match(s.error!, /saknar ljud/);
      assert.equal(s.session!.jobId, JOB_ID);

      backend.jobScript = [{ status: "done", stage: "done", progress: 1, outputs: ["main.mp4"] }];
      await controller.uploadSession(s.session!.id); // allowed from 'failed'
      assert.equal(controller.getState().phase, "done");
      assert.equal(backend.uploads.length, 2);
    } finally {
      await backend.server.close();
    }
  });

  test("an unreachable server fails with advice and keeps the recording", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller, settings } = await setup(host, backend);
      await record(controller, [randomBytes(2000)]);
      await settings.save({ serverUrl: "http://127.0.0.1:1" });
      await controller.uploadSession(controller.getState().session!.id);
      const s = controller.getState();
      assert.equal(s.phase, "failed");
      assert.match(s.error!, /Kan inte nå servern/);
      assert.equal(s.session!.state, "stopped", "still not uploaded, still on disk");
      assert.equal((await stat(join(tmp, "recordings", s.session!.id, "recording.webm"))).size, 2000);
    } finally {
      await backend.server.close();
    }
  });

  test("cancelling an upload returns to 'ready' with the file intact", async () => {
    const backend = await startBackend();
    const slow = await startServer(async (req, res) => {
      req.pause(); // never read the body: backpressure stalls the upload mid-way
      req.on("error", () => {});
      res.on("error", () => {});
    });
    const host = new FakeHost();
    try {
      const { controller, settings } = await setup(host, backend);
      await record(controller, [randomBytes(8_000_000)]);
      await settings.save({ serverUrl: slow.url });
      const id = controller.getState().session!.id;
      const running = controller.uploadSession(id);
      await waitFor(controller, (s) => s.phase === "uploading" && (s.upload?.sent ?? 0) > 0);
      controller.cancel();
      await running;
      const s = controller.getState();
      assert.equal(s.phase, "ready");
      assert.equal(s.session!.state, "stopped");
      assert.equal(s.upload, null);
    } finally {
      await slow.close();
      await backend.server.close();
    }
  });

  test("openJob re-attaches to a server job after a restart", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const first = await setup(host, backend);
      await record(first.controller, [randomBytes(2000)]);
      await first.controller.uploadSession(first.controller.getState().session!.id);
      const id = first.controller.getState().session!.id;

      const second = await setup(new FakeHost(), backend); // a fresh process over the same folders
      assert.equal(second.controller.getState().phase, "idle");
      await second.controller.openJob(id);
      const s = second.controller.getState();
      assert.equal(s.phase, "done");
      assert.ok(s.edl);
    } finally {
      await backend.server.close();
    }
  });

  test("uploading without a profile asks for one; shutdown stops a running recording", async () => {
    const backend = await startBackend();
    const host = new FakeHost();
    try {
      const { controller } = await setup(host, backend, { profile: false });
      assert.equal(controller.getState().needsProfile, true);
      await controller.uploadSession("20261031-171200-abcdef");
      assert.match(controller.getState().error!, /profil/);

      await controller.startRecording(START);
      await controller.onRecorderStarted({ mimeType: "video/webm" });
      controller.onRecorderChunk(randomBytes(500));
      const quit = controller.shutdown(2000);
      await new Promise((r) => setTimeout(r, 10));
      assert.ok(host.calls.includes("stop"));
      await controller.onRecorderStopped({ durationMs: 500 }); // the recorder answers the stop command
      await quit;
      assert.equal(controller.getState().phase, "ready");
    } finally {
      await backend.server.close();
    }
  });

  test("crash recovery at startup shows a notice and lists the recording", async () => {
    const backend = await startBackend();
    const sessions = new SessionStore(join(tmp, "recordings"));
    const m = await sessions.create({ sourceName: "Skärm 1" });
    await sessions.update(m.id, { state: "recording", ext: "webm" });
    await writeFile(sessions.filePath((await sessions.get(m.id))!)!, randomBytes(1500));
    try {
      const { controller } = await setup(new FakeHost(), backend);
      const s = controller.getState();
      assert.match(s.notice!, /återställdes/);
      assert.equal(s.sessions[0]!.state, "recovered");
      assert.equal(s.sessions[0]!.bytes, 1500);
      await controller.uploadSession(m.id);
      assert.equal(controller.getState().phase, "done");
    } finally {
      await backend.server.close();
    }
  });
});


// ---- the built-in engine ------------------------------------------------------------------------------

/** A reversible stand-in for the OS keychain: obviously not secret, but it proves the plain text is not what lands on disk. */
const fakeCodec = (available = true): SecretCodec => ({
  available: () => available,
  encrypt: (plain) => "ENC:" + Buffer.from([...plain].reverse().join("")).toString("base64"),
  decrypt: (blob) => {
    if (!blob.startsWith("ENC:")) throw new Error("not decryptable");
    return [...Buffer.from(blob.slice(4), "base64").toString()].reverse().join("");
  },
});

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

describe("ApiKeyStore", () => {
  test("stores the key encrypted: the plain text is not in the file, and it survives a reload", async () => {
    const path = join(tmp, "k", "key.json");
    const store = new ApiKeyStore(path, fakeCodec());
    await store.set(`  ${KEY}\n`);
    assert.equal(store.key, KEY, "surrounding whitespace is trimmed");
    assert.equal(store.storage, "encrypted");
    const onDisk = await readFile(path, "utf8");
    assert.ok(!onDisk.includes(KEY));
    const again = new ApiKeyStore(path, fakeCodec());
    await again.load();
    assert.equal(again.key, KEY);
    assert.equal(again.storage, "encrypted");
    assert.deepEqual((await readdir(join(tmp, "k"))).filter((n) => n.endsWith(".tmp")), []);
  });

  test("without OS secure storage the key is kept in a file only the user can read, and it is labelled as such", { skip: process.platform === "win32" }, async () => {
    const path = join(tmp, "key.json");
    const store = new ApiKeyStore(path, fakeCodec(false));
    await store.set(KEY);
    assert.equal(store.storage, "plain");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const again = new ApiKeyStore(path, fakeCodec(false));
    await again.load();
    assert.equal(again.key, KEY);
    assert.equal(again.storage, "plain");
  });

  test("rejects keys that were obviously copied wrong", async () => {
    const store = new ApiKeyStore(join(tmp, "key.json"), fakeCodec());
    await assert.rejects(store.set("sk-ant-kort"), /för kort/);
    await assert.rejects(store.set("sk-ant-api03 abcdefghijklmnopqrstuvwxyz"), /mellanslag/);
    await assert.rejects(store.set("sk-ant-api03-åäöabcdefghijklmnopqrst"), /specialtecken/);
    assert.equal(store.key, null);
    await assert.rejects(readFile(join(tmp, "key.json")), /ENOENT/);
  });

  test("a corrupt or undecryptable file means no key, never a crash", async () => {
    const path = join(tmp, "key.json");
    const store = new ApiKeyStore(path, fakeCodec());
    await writeFile(path, "{ not json");
    await store.load();
    assert.equal(store.key, null);
    await writeFile(path, JSON.stringify({ v: 1, mode: "encrypted", data: "from-another-computer" }));
    await store.load();
    assert.equal(store.key, null);
    assert.equal(store.storage, "none");
  });

  test("set(null) removes the key and the file", async () => {
    const path = join(tmp, "key.json");
    const store = new ApiKeyStore(path, fakeCodec());
    await store.set(KEY);
    await store.set(null);
    assert.equal(store.key, null);
    assert.equal(store.storage, "none");
    await assert.rejects(readFile(path), /ENOENT/);
    await store.set(null); // removing nothing is fine
  });
});

describe("SettingsStore: engine settings", () => {
  test("defaults to the built-in engine and the small model; the key only ever shows up as hasApiKey", async () => {
    const keys = new ApiKeyStore(join(tmp, "key.json"), fakeCodec());
    const s = new SettingsStore(join(tmp, "settings.json"), keys);
    const first = await s.load();
    assert.deepEqual(first.engine, { mode: "managed", whisperModel: "small", hasApiKey: false, keyStorage: "none" });
    await s.setApiKey(KEY);
    assert.deepEqual(s.current.engine, { mode: "managed", whisperModel: "small", hasApiKey: true, keyStorage: "encrypted" });
    assert.ok(!JSON.stringify(s.current).includes(KEY));
    assert.equal(s.engineConfig.apiKey, KEY);
    await s.save({ engine: { whisperModel: "medium" }, preferences: { ...defaultPreferences(), niche: "garage" } });
    assert.ok(!(await readFile(join(tmp, "settings.json"), "utf8")).includes(KEY), "settings.json holds no secret");

    const again = new SettingsStore(join(tmp, "settings.json"), new ApiKeyStore(join(tmp, "key.json"), fakeCodec()));
    const loaded = await again.load();
    assert.equal(loaded.engine.whisperModel, "medium");
    assert.equal(loaded.engine.hasApiKey, true);
    assert.equal(loaded.preferences!.niche, "garage");
  });

  test("rejects unknown modes and models", async () => {
    const s = new SettingsStore(join(tmp, "settings.json"));
    await s.load();
    await assert.rejects(s.save({ engine: { whisperModel: "enormous" as never } }), /modell/);
    await assert.rejects(s.save({ engine: { mode: "cloud" as never } }), /läge/);
    await assert.rejects(s.setApiKey(KEY), /Det går inte/, "no key store available");
  });

  test("settings from before the built-in engine: a custom server address keeps working, the default means the built-in engine", async () => {
    const path = join(tmp, "settings.json");
    await writeFile(path, JSON.stringify({ serverUrl: "http://mybox:9000", preferences: null }));
    assert.equal((await new SettingsStore(path).load()).engine.mode, "external");
    await writeFile(path, JSON.stringify({ serverUrl: "http://localhost:8000", preferences: null }));
    assert.equal((await new SettingsStore(path).load()).engine.mode, "managed");
    await writeFile(path, JSON.stringify({ serverUrl: "http://mybox:9000", preferences: null, engine: { mode: "managed", whisperModel: "large-v3" } }));
    const both = await new SettingsStore(path).load();
    assert.deepEqual([both.engine.mode, both.engine.whisperModel], ["managed", "large-v3"], "an explicit choice wins");
  });
});

class FakeEngine implements Engine {
  calls: string[] = [];
  private i: EngineInfo = offEngineInfo("managed");
  private listeners = new Set<(i: EngineInfo) => void>();
  info() { return structuredClone(this.i); }
  url() { return this.i.phase === "ready" ? this.i.url : null; }
  onChange(cb: (i: EngineInfo) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  async start() { this.calls.push("start"); }
  async stop() { this.calls.push("stop"); }
  async retry(o?: { repair?: boolean }) { this.calls.push(o?.repair ? "repair" : "retry"); }
  set(patch: Partial<EngineInfo>) {
    this.i = { ...this.i, ...patch };
    for (const l of this.listeners) l(this.info());
  }
}

async function setupManaged(host: FakeHost, backend: Backend, opts: { mode?: "managed" | "external"; pollRecoveryMs?: number } = {}) {
  const engine = new FakeEngine();
  const keys = new ApiKeyStore(join(tmp, "key.json"), fakeCodec());
  const settings = new SettingsStore(join(tmp, "settings.json"), keys);
  await settings.load();
  await settings.save({ serverUrl: backend.server.url, preferences: { ...defaultPreferences(), niche: "tutorial" }, engine: { mode: opts.mode ?? "managed" } });
  const controller = new Controller({
    sessions: new SessionStore(join(tmp, "recordings")), settings, host, engine,
    createApi: (url) => new ClipsmithApi({ baseUrl: url, sleep: noSleep, uploadRetries: 0 }),
    countdownSeconds: 0, startTimeoutMs: 200, pollIntervalMs: 1, engineRecoveryMs: opts.pollRecoveryMs ?? 2000,
    now: () => Date.parse("2026-10-31T17:12:00Z"),
  });
  await controller.init();
  return { controller, engine, settings };
}

describe("Controller with the built-in engine", () => {
  test("starts the engine at launch and mirrors its progress, including the server status the top bar shows", async () => {
    const backend = await startBackend();
    try {
      const { controller, engine } = await setupManaged(new FakeHost(), backend);
      assert.deepEqual(engine.calls, ["start"]);
      assert.equal(controller.getState().engine.mode, "managed");
      assert.equal(controller.getState().server.ok, null);

      engine.set({ phase: "installing", step: 2, detail: "Installerar" });
      assert.equal(controller.getState().engine.phase, "installing");
      assert.equal(controller.getState().server.ok, null, "not ready is not 'down'");

      engine.set({ phase: "ready", step: 0, url: backend.server.url, version: "0.1.0" });
      const ready = controller.getState();
      assert.deepEqual(ready.server, { url: backend.server.url, ok: true, version: "0.1.0" });

      engine.set({ phase: "failed", url: null, problem: { code: "unknown", title: "Något", hint: "x" } });
      assert.equal(controller.getState().server.ok, false);
    } finally { await backend.server.close(); }
  });

  test("in 'external' mode the engine is left alone and the server address is checked as before", async () => {
    const backend = await startBackend();
    try {
      const { controller, engine } = await setupManaged(new FakeHost(), backend, { mode: "external" });
      assert.deepEqual(engine.calls, []);
      assert.equal(controller.getState().engine.mode, "external");
      const st = await waitFor(controller, (s) => s.server.ok === true);
      assert.equal(st.server.url, backend.server.url);
    } finally { await backend.server.close(); }
  });

  test("a recording can be made while the engine is still installing, but not sent: the person is told why", async () => {
    const backend = await startBackend();
    try {
      const host = new FakeHost();
      const { controller, engine } = await setupManaged(host, backend);
      engine.set({ phase: "installing", step: 2 });
      await record(controller, [randomBytes(2000)]);
      const meta = controller.getState().session!;
      assert.equal(controller.getState().phase, "ready");

      await controller.uploadSession(meta.id);
      assert.equal(controller.getState().phase, "ready", "nothing was started");
      assert.match(controller.getState().error!, /håller på att startas/);
      assert.equal(backend.uploads.length, 0);

      engine.set({ phase: "failed", problem: { code: "python-missing", title: "Python saknas", hint: "x" } });
      await controller.uploadSession(meta.id);
      assert.match(controller.getState().error!, /fungerar inte just nu \(python saknas\)/);
      assert.equal(backend.uploads.length, 0);

      engine.set({ phase: "ready", url: backend.server.url, problem: null });
      await controller.uploadSession(meta.id);
      assert.equal(controller.getState().phase, "done");
      assert.equal(backend.uploads.length, 1, "it went to the engine's own address, not the one in the settings");
    } finally { await backend.server.close(); }
  });

  test("results are downloaded from the engine's address", async () => {
    const backend = await startBackend();
    try {
      const host = new FakeHost();
      const { controller, engine, settings } = await setupManaged(host, backend);
      await settings.save({ serverUrl: "http://127.0.0.1:1" }); // a decoy that must not be used in managed mode
      engine.set({ phase: "ready", url: backend.server.url });
      await record(controller, [randomBytes(2000)]);
      await controller.uploadSession(controller.getState().session!.id);
      assert.equal(controller.getState().phase, "done");
      host.folder = join(tmp, "out");
      await mkdir(host.folder);
      const dir = await controller.saveResults();
      assert.ok(dir);
      assert.deepEqual((await readdir(dir)).sort(), ["main.mp4", "main.srt", "short_1.mp4"]);
    } finally { await backend.server.close(); }
  });

  test("engine settings: switching mode stops/starts the engine, a new model restarts it, and nothing changes mid-job", async () => {
    const backend = await startBackend();
    try {
      const { controller, engine } = await setupManaged(new FakeHost(), backend);
      engine.calls.length = 0;

      await controller.saveSettings({ engine: { whisperModel: "medium" } });
      assert.deepEqual(engine.calls, ["retry"]);
      await controller.saveSettings({ engine: { whisperModel: "medium" } });
      assert.deepEqual(engine.calls, ["retry"], "saving the same model again does nothing");

      await controller.saveSettings({ engine: { mode: "external" } });
      assert.deepEqual(engine.calls, ["retry", "stop"]);
      assert.equal(controller.getState().engine.mode, "external");
      await controller.saveSettings({ engine: { mode: "managed" } });
      assert.deepEqual(engine.calls, ["retry", "stop", "start"]);

      // mid-job
      engine.set({ phase: "ready", url: backend.server.url });
      backend.jobScript = [{ status: "processing", stage: "transcribing", progress: 0.1 }];
      const host = new FakeHost();
      void host;
      await record(controller, [randomBytes(1500)]);
      const up = controller.uploadSession(controller.getState().session!.id);
      await waitFor(controller, (s) => s.phase === "processing");
      await assert.rejects(controller.saveSettings({ engine: { mode: "external" } }), /Vänta tills bearbetningen är klar/);
      await assert.rejects(controller.setApiKey(KEY), /Vänta tills bearbetningen är klar/);
      await controller.retryEngine(false).then(() => assert.fail("should refuse"), (e: Error) => assert.match(e.message, /Vänta/));
      assert.equal(engine.calls.at(-1), "start", "no engine call was made");
      controller.cancel();
      await up;
    } finally { await backend.server.close(); }
  });

  test("the API key is stored, the engine is restarted to use it, and no window ever sees the key", async () => {
    const backend = await startBackend();
    try {
      const { controller, engine, settings } = await setupManaged(new FakeHost(), backend);
      engine.calls.length = 0;
      const saved = await controller.setApiKey(KEY);
      assert.deepEqual(engine.calls, ["retry"]);
      assert.equal(saved.engine.hasApiKey, true);
      assert.equal(settings.engineConfig.apiKey, KEY);
      assert.ok(!JSON.stringify(controller.getState()).includes(KEY));
      assert.ok(!JSON.stringify(saved).includes(KEY));

      await assert.rejects(controller.setApiKey("kort"), /för kort/);
      assert.equal(engine.calls.length, 1, "a rejected key does not restart anything");

      await controller.setApiKey(null);
      assert.equal(settings.current.engine.hasApiKey, false);
      assert.deepEqual(engine.calls, ["retry", "retry"]);
    } finally { await backend.server.close(); }
  });

  test("'repair' is passed on to the engine", async () => {
    const backend = await startBackend();
    try {
      const { controller, engine } = await setupManaged(new FakeHost(), backend);
      engine.calls.length = 0;
      await controller.retryEngine(true);
      await controller.retryEngine(false);
      assert.deepEqual(engine.calls, ["repair", "retry"]);
    } finally { await backend.server.close(); }
  });

  test("shutdown stops the engine (and still stops a running recording first)", async () => {
    const backend = await startBackend();
    try {
      const host = new FakeHost();
      const { controller, engine } = await setupManaged(host, backend);
      engine.set({ phase: "ready", url: backend.server.url });
      await controller.startRecording(START);
      await controller.onRecorderStarted({ mimeType: "video/webm" });
      const done = controller.shutdown(2000);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(host.calls.includes("stop"));
      assert.ok(!engine.calls.includes("stop"), "the engine waits until the file is closed");
      await controller.onRecorderStopped({ durationMs: 10 });
      await done;
      assert.equal(engine.calls.at(-1), "stop");
    } finally { await backend.server.close(); }
  });

  test("if the engine restarts on a new port during processing, the job is followed there and the interruption is explained", async () => {
    const first = await startBackend();
    const second = await startBackend();
    second.jobScript = [{ status: "failed", stage: null, progress: 0, error: "Processing was interrupted because the engine stopped. Send the recording again." }];
    try {
      const { controller, engine } = await setupManaged(new FakeHost(), first);
      engine.set({ phase: "ready", url: first.server.url });
      first.jobScript = [{ status: "processing", stage: "transcribing", progress: 0.3 }];
      await record(controller, [randomBytes(1500)]);
      const up = controller.uploadSession(controller.getState().session!.id);
      await waitFor(controller, (s) => s.phase === "processing" && s.job?.progress === 0.3);

      await first.server.close();                       // the engine dies ...
      engine.set({ phase: "starting", url: null });     // ... the supervisor notices ...
      setTimeout(() => engine.set({ phase: "ready", url: second.server.url }), 50);   // ... and brings it back elsewhere
      await up;

      const st = controller.getState();
      assert.equal(st.phase, "failed");
      assert.match(st.error!, /avbröts när redigeringsmotorn stannade/);
    } finally { await first.server.close(); await second.server.close(); }
  });

  test("if the engine does not come back, the person gets a network error pointing at the Motor tab", async () => {
    const first = await startBackend();
    try {
      const { controller, engine } = await setupManaged(new FakeHost(), first, { pollRecoveryMs: 100 });
      engine.set({ phase: "ready", url: first.server.url });
      first.jobScript = [{ status: "processing", stage: "transcribing", progress: 0.3 }];
      await record(controller, [randomBytes(1500)]);
      const up = controller.uploadSession(controller.getState().session!.id);
      await waitFor(controller, (s) => s.phase === "processing" && s.job?.progress === 0.3);
      await first.server.close();
      engine.set({ phase: "starting", url: null });
      await up;
      assert.equal(controller.getState().phase, "failed");
      assert.match(controller.getState().error!, /fliken Motor/);
    } finally { await first.server.close(); }
  });
});
