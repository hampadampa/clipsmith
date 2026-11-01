/** A recording session = one folder on disk: session.json + recording.<ext>. */

export const SESSION_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export type SessionState =
  | "starting" // folder created, capture not confirmed yet
  | "recording" // chunks are being written
  | "recovered" // the app died while recording; whatever reached the disk is kept
  | "stopped" // finished cleanly, not uploaded yet
  | "uploaded"; // a backend job exists (see jobId)

export interface SessionMeta {
  id: string;
  createdAt: number; // epoch ms
  state: SessionState;
  sourceName: string;
  mimeType: string | null;
  ext: string | null;
  durationMs: number | null; // null when unknown (recovered sessions)
  bytes: number;
  jobId: string | null;
  note: string | null; // e.g. "recording ended early: ..."
}

export function makeSessionId(now: Date = new Date(), randomHex?: string): string {
  const iso = now.toISOString(); // 2026-10-31T17:12:00.000Z
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  let rand = randomHex;
  if (!rand) {
    const b = new Uint8Array(3);
    crypto.getRandomValues(b);
    rand = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  return `${stamp}-${rand}`;
}

/** Extensions the backend accepts: .mp4 .mov .m4v .webm .mkv */
export function extFromMime(mime: string): string | null {
  const m = mime.toLowerCase();
  if (m.startsWith("video/mp4")) return "mp4";
  if (m.startsWith("video/webm")) return "webm";
  if (m.startsWith("video/x-matroska")) return "mkv";
  return null;
}

export function contentTypeForExt(ext: string): string {
  return ext === "mp4" || ext === "m4v" ? "video/mp4" : ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/x-matroska";
}
