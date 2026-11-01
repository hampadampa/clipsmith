const pad = (n: number): string => String(n).padStart(2, "0");

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Swedish decimal comma, deterministic (does not depend on ICU data). */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const text = i === 0 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  return `${text.replace(".", ",")} ${units[i]}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)} %`;
}
