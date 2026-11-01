/**
 * Appends recorder chunks to a file, strictly in call order.
 *
 * The recording never lives in memory: every chunk goes to disk as it arrives, so an hour of
 * screen capture costs a few MB of RAM and survives an app crash (see SessionStore.recoverOrphans).
 */
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export class RecordingSink {
  readonly path: string;
  bytes = 0;
  private handle: FileHandle;
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private closed = false;

  private constructor(path: string, handle: FileHandle) {
    this.path = path;
    this.handle = handle;
  }

  static async open(path: string): Promise<RecordingSink> {
    return new RecordingSink(path, await open(path, "a"));
  }

  /** Resolves when this chunk is on disk. After the first failure every later call rejects with the same error. */
  append(chunk: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The recording file is already closed."));
    const run = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      try {
        await this.handle.appendFile(chunk); // loops until the whole chunk is written
        this.bytes += chunk.byteLength;
      } catch (e) {
        this.failure = e;
        throw e;
      }
    });
    this.queue = run.catch(() => {}); // keep the chain alive; callers see the error through `run`
    return run;
  }

  /** Waits for queued writes, flushes and closes. Returns the number of bytes written. */
  async close(): Promise<number> {
    if (!this.closed) {
      this.closed = true;
      await this.queue;
      try {
        if (!this.failure) await this.handle.sync();
      } finally {
        await this.handle.close();
      }
    }
    return this.bytes;
  }
}
