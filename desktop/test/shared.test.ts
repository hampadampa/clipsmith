import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { ApiError, ClipsmithApi, NetworkError, isAbortError, normalizeBaseUrl } from "../src/shared/api.ts";
import type { JobView } from "../src/shared/api.ts";
import { CONTRACT } from "../src/shared/contract.generated.ts";
import { buildCutStrip } from "../src/shared/cutstrip.ts";
import { formatBytes, formatClock } from "../src/shared/format.ts";
import { describeFailure, describeJobError, describeStage } from "../src/shared/jobs.ts";
import { buildMultipart } from "../src/shared/multipart.ts";
import { defaultPreferences, normalizePreferences, validatePreferences } from "../src/shared/preferences.ts";
import { SESSION_ID_RE, extFromMime, makeSessionId } from "../src/shared/session.ts";
import { json, memoryFile, parseMultipart, readBody, startServer } from "./support/server.ts";

const noSleep = async () => {};
const bytes = (n: number, seed = 7): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const sha = (b: Uint8Array | Buffer) => createHash("sha256").update(b).digest("hex");

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

describe("preferences", () => {
  test("defaults are valid and target the screen", () => {
    const d = defaultPreferences();
    assert.deepEqual(validatePreferences(d), []);
    assert.equal(d.source_type, "screen");
  });

  test("limits come from the backend contract", () => {
    const [, maxS] = CONTRACT.limits.num_shorts;
    const p = { ...defaultPreferences(), num_shorts: maxS + 1, target_minutes: 0 };
    assert.equal(validatePreferences(p).length, 2);
    assert.equal(validatePreferences({ ...defaultPreferences(), niche_notes: "x".repeat(CONTRACT.limits.niche_notes_max_chars + 1) }).length, 1);
  });

  test("normalizePreferences keeps valid fields and repairs the rest", () => {
    const p = normalizePreferences({ niche: "garage", pace: "turbo", num_shorts: 2.5, target_minutes: 12, language: "", remove_fillers: "yes", source_type: "camera" });
    assert.equal(p.niche, "garage");
    assert.equal(p.pace, defaultPreferences().pace);
    assert.equal(p.num_shorts, defaultPreferences().num_shorts);
    assert.equal(p.target_minutes, 12);
    assert.equal(p.language, defaultPreferences().language);
    assert.equal(p.remove_fillers, null);
    assert.equal(p.source_type, "screen");
    assert.deepEqual(normalizePreferences(null), defaultPreferences());
    assert.deepEqual(validatePreferences(p), []);
  });
});

describe("multipart", () => {
  test("framing is exact: Content-Length matches, fields and file bytes survive", async () => {
    const data = bytes(300_000);
    const file = memoryFile(data, { chunkSize: 70_000, name: 'vi"deo\r\n.mp4' });
    const mp = buildMultipart({ preferences: JSON.stringify({ niche_notes: "bil-el, schemat åäö ✓" }) }, file);
    const body = await collect(mp.stream());
    assert.equal(body.byteLength, mp.contentLength);

    const parts = parseMultipart(body, mp.contentType);
    assert.deepEqual(parts.map((p) => p.name), ["preferences", "video"]);
    assert.equal(JSON.parse(parts[0]!.data.toString("utf8")).niche_notes, "bil-el, schemat åäö ✓");
    assert.equal(sha(parts[1]!.data), sha(data));
    assert.equal(parts[1]!.filename, "vi%22deo%0D%0A.mp4"); // quotes and newlines cannot break the header
    assert.equal(parts[1]!.contentType, "video/mp4");
  });

  test("reports progress for file bytes only", async () => {
    const file = memoryFile(bytes(100_000), { chunkSize: 30_000 });
    let seen = 0;
    await collect(buildMultipart({}, file).stream((n) => (seen += n)));
    assert.equal(seen, 100_000);
  });

  test("fails loudly when the file changes size while uploading", async () => {
    const short = memoryFile(bytes(1000), { claimSize: 2000 });
    let err: unknown;
    await collect(buildMultipart({}, short).stream(undefined, (e) => (err = e))).catch(() => {});
    assert.match(String(err), /changed while uploading/);

    const long = memoryFile(bytes(2000), { claimSize: 1000, chunkSize: 500 });
    err = undefined;
    await collect(buildMultipart({}, long).stream(undefined, (e) => (err = e))).catch(() => {});
    assert.match(String(err), /grew/);
  });
});

describe("api: base url", () => {
  test("normalizes and rejects", () => {
    assert.equal(normalizeBaseUrl("localhost:8000"), "http://localhost:8000");
    assert.equal(normalizeBaseUrl(" https://api.example.com/ "), "https://api.example.com");
    assert.equal(normalizeBaseUrl("http://10.0.0.5:8000/clipsmith/"), "http://10.0.0.5:8000/clipsmith");
    assert.throws(() => normalizeBaseUrl("ftp://x"), /http/);
    assert.throws(() => normalizeBaseUrl(""), /adress/i);
    assert.throws(() => normalizeBaseUrl("http://"), /giltig/);
  });
});

describe("api: upload", () => {
  test("streams a multi-MB file with Content-Length and honest progress", async () => {
    const data = bytes(6 * 1024 * 1024);
    let received = { len: 0, ctype: "", clen: "", te: "", hash: "", fields: [] as string[] };
    const srv = await startServer(async (req, res) => {
      const body = await readBody(req);
      const parts = parseMultipart(body, String(req.headers["content-type"]));
      received = { len: body.length, ctype: String(req.headers["content-type"]), clen: String(req.headers["content-length"]), te: String(req.headers["transfer-encoding"]), hash: sha(parts.find((p) => p.name === "video")!.data), fields: parts.map((p) => p.name) };
      json(res, 202, { id: "a".repeat(32), status: "queued" });
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url });
      const progress: number[] = [];
      const job = await api.createJob(memoryFile(data), defaultPreferences(), { onProgress: (s) => progress.push(s) });
      assert.equal(job.status, "queued");
      assert.equal(received.hash, sha(data));
      assert.equal(received.clen, String(received.len), "exact Content-Length");
      assert.equal(received.te, "undefined", "not chunked");
      assert.deepEqual(received.fields, ["preferences", "video"]);
      assert.equal(progress.at(-1), data.byteLength);
      assert.ok(progress.every((v, i) => i === 0 || v > progress[i - 1]!), "progress increases");
    } finally {
      await srv.close();
    }
  });

  test("retries after a dropped connection and reopens the file", async () => {
    let calls = 0;
    const srv = await startServer(async (req, res) => {
      if (calls++ === 0) return void req.socket.destroy();
      await readBody(req);
      json(res, 202, { id: "b".repeat(32), status: "queued" });
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url, sleep: noSleep });
      const file = memoryFile(bytes(200_000));
      const job = await api.createJob(file, defaultPreferences());
      assert.equal(job.id, "b".repeat(32));
      assert.equal(calls, 2);
      assert.equal(file.opens, 2);
    } finally {
      await srv.close();
    }
  });

  test("does not retry client errors; maps FastAPI validation details", async () => {
    let calls = 0;
    const srv = await startServer(async (req, res) => {
      calls++;
      await readBody(req);
      json(res, 422, { detail: [{ msg: "Invalid preferences: pace must be one of (...)" }] });
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url, sleep: noSleep });
      await assert.rejects(api.createJob(memoryFile(bytes(1000)), defaultPreferences()), (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 422);
        assert.match(e.detail, /Invalid preferences/);
        assert.match(describeFailure(e), /godtog inte inställningarna/);
        return true;
      });
      assert.equal(calls, 1);
    } finally {
      await srv.close();
    }
  });

  test("gives up after the retry budget with a NetworkError", async () => {
    const srv = await startServer((req) => void req.socket.destroy());
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url, sleep: noSleep, uploadRetries: 1 });
      const file = memoryFile(bytes(1000));
      await assert.rejects(api.createJob(file, defaultPreferences()), NetworkError);
      assert.equal(file.opens, 2);
    } finally {
      await srv.close();
    }
  });

  test("a failing local file is reported as-is and never retried", async () => {
    const srv = await startServer(async (req, res) => {
      await readBody(req).catch(() => {});
      json(res, 202, {});
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url, sleep: noSleep });
      let opens = 0;
      const broken = { fieldName: "video", filename: "x.mp4", contentType: "video/mp4", size: 10, open: () => ((opens++), (async function* () { throw new Error("disk read error"); })()) };
      await assert.rejects(api.createJob(broken, defaultPreferences()), /disk read error/);
      assert.equal(opens, 1);
    } finally {
      await srv.close();
    }
  });

  test("abort stops the upload and closes the file", async () => {
    const srv = await startServer(async (req, res) => {
      await readBody(req).catch(() => {});
      res.end();
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url });
      const ac = new AbortController();
      const file = memoryFile(bytes(2_000_000), { chunkSize: 50_000, onChunk: () => new Promise((r) => setTimeout(r, 2)) });
      await assert.rejects(api.createJob(file, defaultPreferences(), { signal: ac.signal, onProgress: (s) => s > 100_000 && ac.abort() }), (e: unknown) => isAbortError(e));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(file.returned, 1, "file iterator was closed");
    } finally {
      await srv.close();
    }
  });
});

describe("api: polling and files", () => {
  const job = (status: string, extra: Partial<JobView> = {}): JobView => ({ id: "c".repeat(32), status, stage: null, progress: 0, error: null, created_at: 0, preferences: {}, outputs: [], result: null, ...extra }) as JobView;

  test("waitForJob follows the job to done and survives transient 503s", async () => {
    const script: Array<[number, unknown]> = [
      [200, job("queued")],
      [503, { detail: "busy" }],
      [503, { detail: "busy" }],
      [200, job("processing", { stage: "transcribing", progress: 0.2 })],
      [200, job("done", { progress: 1, outputs: ["main.mp4"] })],
    ];
    let i = 0;
    const srv = await startServer((_req, res) => {
      const [status, body] = script[i++]!;
      json(res, status, body);
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url, sleep: noSleep });
      const seen: string[] = [];
      const final = await api.waitForJob("c".repeat(32), { onUpdate: (j) => seen.push(j.status) });
      assert.equal(final.status, "done");
      assert.deepEqual(seen, ["queued", "processing", "done"]);
    } finally {
      await srv.close();
    }
  });

  test("waitForJob gives up on 404 immediately and on endless 5xx eventually", async () => {
    let n = 0;
    const srv = await startServer((_req, res) => {
      n++;
      json(res, n === 1 ? 404 : 500, { detail: "x" });
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url, sleep: noSleep });
      await assert.rejects(api.waitForJob("c".repeat(32)), (e: unknown) => e instanceof ApiError && e.status === 404);
      n = 1;
      await assert.rejects(api.waitForJob("c".repeat(32), { maxConsecutiveErrors: 3 }), (e: unknown) => e instanceof ApiError && e.status === 500);
      assert.equal(n, 1 + 4);
    } finally {
      await srv.close();
    }
  });

  test("health, getJson and fileUrl", async () => {
    const srv = await startServer((req, res) => {
      if (req.url === "/health") return json(res, 200, { ok: true, version: "0.1.0" });
      if (req.url === "/jobs/abc/files/main.edl.json") return json(res, 200, [{ src_start: 0, src_end: 1, out_start: 0 }]);
      json(res, 404, { detail: "File not found" });
    });
    try {
      const api = new ClipsmithApi({ baseUrl: srv.url });
      assert.deepEqual(await api.health(), { ok: true, version: "0.1.0" });
      assert.equal((await api.getJson<unknown[]>("abc", "main.edl.json")).length, 1);
      assert.equal(api.fileUrl("abc", "short 1.mp4"), `${srv.url}/jobs/abc/files/short%201.mp4`);
      await assert.rejects(api.getJson("abc", "nope.json"), (e: unknown) => e instanceof ApiError && e.detail === "File not found");
    } finally {
      await srv.close();
    }
  });

  test("unreachable server gives a NetworkError that explains what to check", async () => {
    const api = new ClipsmithApi({ baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(api.health(), (e: unknown) => e instanceof NetworkError && /fliken Motor/.test(describeFailure(e)));
  });
});

describe("cut strip", () => {
  test("kept ranges become segments, gaps become removed segments", () => {
    const s = buildCutStrip([{ src_start: 10, src_end: 30, out_start: 0 }, { src_start: 60, src_end: 90, out_start: 20 }], 100);
    assert.deepEqual(s.segments.map((x) => [x.from, x.to, x.kept]), [[0, 0.1, false], [0.1, 0.3, true], [0.3, 0.6, false], [0.6, 0.9, true], [0.9, 1, false]]);
    assert.equal(s.keptSeconds, 50);
    assert.equal(s.removedSeconds, 50);
    assert.equal(s.removedShare, 0.5);
  });

  test("handles overlap, out-of-range values, unsorted input and empty edl", () => {
    const s = buildCutStrip([{ src_start: 50, src_end: 120, out_start: 0 }, { src_start: -5, src_end: 20, out_start: 0 }, { src_start: 15, src_end: 25, out_start: 0 }], 100);
    assert.deepEqual(s.segments.map((x) => x.kept), [true, false, true]);
    assert.equal(s.keptSeconds, 25 + 50);
    assert.equal(buildCutStrip([], 100).segments.length, 1);
    assert.equal(buildCutStrip([], 100).removedShare, 1);
    assert.deepEqual(buildCutStrip([{ src_start: 0, src_end: 1, out_start: 0 }], 0).segments, []);
  });
});

describe("wording and formatting", () => {
  test("stages", () => {
    assert.equal(describeStage("rendering_short_3", "processing"), "Renderar short 3");
    assert.equal(describeStage(null, "queued"), "Väntar på sin tur hos servern");
    assert.equal(describeStage("transcribing", "processing"), "Skriver ut vad du säger");
    assert.equal(describeStage("something_new", "processing"), "something_new");
  });

  test("backend errors become actionable Swedish", () => {
    assert.match(describeJobError("The video has no audio track, so there is no speech to edit."), /saknar ljud/);
    assert.match(describeJobError("No speech detected in the video."), /Inget tal/);
    assert.match(describeJobError("Editing removed everything; refusing to render an empty video."), /tagit bort allt/);
    assert.equal(describeJobError("weird"), "weird");
  });

  test("clock and bytes", () => {
    assert.equal(formatClock(75), "1:15");
    assert.equal(formatClock(3725), "1:02:05");
    assert.equal(formatClock(-3), "0:00");
    assert.equal(formatBytes(999), "999 B");
    assert.equal(formatBytes(1_500_000), "1,5 MB");
    assert.equal(formatBytes(4_200_000_000), "4,2 GB");
  });

  test("session ids and extensions", () => {
    const id = makeSessionId(new Date("2026-10-31T17:12:05Z"), "ab12cd");
    assert.equal(id, "20261031-171205-ab12cd");
    assert.ok(SESSION_ID_RE.test(id));
    assert.ok(SESSION_ID_RE.test(makeSessionId()));
    for (const bad of ["../x", "20261031-171205-ab12c", "20261031-171205-AB12CD", "x/20261031-171205-ab12cd"]) assert.ok(!SESSION_ID_RE.test(bad), bad);
    assert.equal(extFromMime("video/webm;codecs=vp9,opus"), "webm");
    assert.equal(extFromMime("video/mp4;codecs=avc1.640028,mp4a.40.2"), "mp4");
    assert.equal(extFromMime("audio/ogg"), null);
  });
});
