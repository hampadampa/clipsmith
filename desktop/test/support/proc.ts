import { readFileSync } from "node:fs";

/**
 * Is the process running? A zombie (killed, but not yet reaped by its parent) counts as dead: on Linux it
 * still answers `kill(pid, 0)`, and in containers whose PID 1 never reaps orphans it can stay that way forever.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no /proc (macOS, Windows): the signal check above is all there is
  }
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 25): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}
