import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ApiError, NetworkError, isAbortError } from "../shared/api.ts";

/** Streams a URL to disk via a temp file, so a half-finished download never looks like a finished one. */
export async function downloadFile(
  url: string,
  dest: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; onProgress?: (bytes: number, total: number | null) => void } = {},
): Promise<number> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(url, { signal: opts.signal });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new NetworkError("Kan inte nå servern", e);
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, `HTTP ${res.status}`);

  const total = Number(res.headers.get("content-length")) || null;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      opts.onProgress?.(bytes, total);
      cb(null, chunk);
    },
  });
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), counter, createWriteStream(tmp), { signal: opts.signal });
    await rename(tmp, dest);
    return bytes;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
