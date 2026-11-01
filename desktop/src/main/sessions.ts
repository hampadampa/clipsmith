/** One folder per recording: <root>/<id>/session.json + recording.<ext>. */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SESSION_ID_RE, makeSessionId } from "../shared/session.ts";
import type { SessionMeta } from "../shared/session.ts";

export class SessionStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(id: string): string {
    if (!SESSION_ID_RE.test(id)) throw new Error("Invalid session id");
    return join(this.root, id);
  }

  filePath(meta: SessionMeta): string | null {
    return meta.ext ? join(this.dir(meta.id), `recording.${meta.ext}`) : null;
  }

  async create(input: { sourceName: string; now?: Date }): Promise<SessionMeta> {
    await mkdir(this.root, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = makeSessionId(input.now ?? new Date());
      try {
        await mkdir(this.dir(id)); // not recursive: EEXIST means the id is taken
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      const meta: SessionMeta = {
        id,
        createdAt: (input.now ?? new Date()).getTime(),
        state: "starting",
        sourceName: input.sourceName,
        mimeType: null,
        ext: null,
        durationMs: null,
        bytes: 0,
        jobId: null,
        note: null,
      };
      await this.write(meta);
      return meta;
    }
    throw new Error("Could not allocate a session id");
  }

  async get(id: string): Promise<SessionMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), "session.json"), "utf8")) as SessionMeta;
    } catch {
      return null;
    }
  }

  async update(id: string, patch: Partial<SessionMeta>): Promise<SessionMeta> {
    const current = await this.get(id);
    if (!current) throw new Error(`Unknown session ${id}`);
    const next = { ...current, ...patch, id: current.id };
    await this.write(next);
    return next;
  }

  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const metas = await Promise.all(names.filter((n) => SESSION_ID_RE.test(n)).map((n) => this.get(n)));
    return metas.filter((m): m is SessionMeta => m !== null).sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  /**
   * Sessions still marked starting/recording at launch were interrupted (crash, power loss, kill).
   * Keep what reached the disk; drop the ones that never wrote a byte.
   */
  async recoverOrphans(): Promise<SessionMeta[]> {
    const recovered: SessionMeta[] = [];
    for (const meta of await this.list()) {
      if (meta.state !== "starting" && meta.state !== "recording") continue;
      const file = this.filePath(meta);
      const size = file ? await stat(file).then((s) => s.size).catch(() => 0) : 0;
      if (size > 0) {
        recovered.push(
          await this.update(meta.id, {
            state: "recovered",
            bytes: size,
            note: "Appen avslutades under inspelningen. Det som hann sparas finns kvar.",
          }),
        );
      } else {
        await this.remove(meta.id);
      }
    }
    return recovered;
  }

  private async write(meta: SessionMeta): Promise<void> {
    const path = join(this.dir(meta.id), "session.json");
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(meta, null, 2));
    await rename(tmp, path); // atomic: a crash never leaves a half-written session.json
  }
}
