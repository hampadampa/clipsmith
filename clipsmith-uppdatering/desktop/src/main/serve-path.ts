/**
 * Which file on disk a clipsmith://app/... address may map to. Kept apart from windows.ts (which imports Electron)
 * so that the rules can be tested, including with Windows path rules on a Linux machine.
 */
import * as nodePath from "node:path";

/** The part of node:path that is used. `path.win32` and `path.posix` both fit. */
export interface PathApi {
  join(...parts: string[]): string;
  normalize(path: string): string;
  sep: string;
}

/** Only these file types are ever served to the UI. */
export const SERVED = /\.(html|js|css)$/;

export type Resolved = { ok: true; file: string } | { ok: false; reason: string };

/** `root` must already be normalized (the folder holding renderer/ and shared/). Nothing outside it is ever served. */
export function resolveServed(root: string, pathname: string, p: PathApi = nodePath): Resolved {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, reason: "ogiltig adress" };
  }
  const file = p.normalize(p.join(root, decoded));
  if (!file.startsWith(root + p.sep)) return { ok: false, reason: "utanför gränssnittsmappen" };
  if (!SERVED.test(file)) return { ok: false, reason: "filtypen serveras inte" };
  return { ok: true, file };
}
