/**
 * The "cut strip": the whole original recording as a bar, with what was kept and what was cut.
 * Input is main.edl.json from the backend (source ranges that survive into main.mp4).
 */

export interface EdlEntry {
  src_start: number;
  src_end: number;
  out_start: number;
}

export interface StripSegment {
  from: number; // fraction of the source, 0..1
  to: number;
  kept: boolean;
}

export interface CutStrip {
  segments: StripSegment[];
  keptSeconds: number;
  removedSeconds: number;
  removedShare: number; // 0..1
}

export function buildCutStrip(edl: readonly EdlEntry[], sourceDuration: number): CutStrip {
  if (!(sourceDuration > 0)) return { segments: [], keptSeconds: 0, removedSeconds: 0, removedShare: 0 };
  const D = sourceDuration;
  const ranges = edl
    .map((e) => [Math.min(Math.max(e.src_start, 0), D), Math.min(Math.max(e.src_end, 0), D)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);

  const kept: [number, number][] = [];
  for (const [a, b] of ranges) {
    const last = kept[kept.length - 1];
    if (last && a <= last[1] + 1e-6) last[1] = Math.max(last[1], b);
    else kept.push([a, b]);
  }

  const segments: StripSegment[] = [];
  let cursor = 0;
  for (const [a, b] of kept) {
    if (a > cursor + 1e-6) segments.push({ from: cursor / D, to: a / D, kept: false });
    segments.push({ from: a / D, to: b / D, kept: true });
    cursor = b;
  }
  if (cursor < D - 1e-6) segments.push({ from: cursor / D, to: 1, kept: false });

  const keptSeconds = kept.reduce((s, [a, b]) => s + (b - a), 0);
  const removedSeconds = Math.max(0, D - keptSeconds);
  return { segments, keptSeconds, removedSeconds, removedShare: removedSeconds / D };
}
