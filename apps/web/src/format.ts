/** Small display formatters (a UI concern — core stays free of locale/format). */

/** Elapsed milliseconds → `h:mm:ss` (or `m:ss` under an hour). */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A signed minute count → human duration, e.g. `1h 30m`, `45m`, `−20m` (over). */
export function formatMinutes(min: number): string {
  const sign = min < 0 ? '−' : '';
  const abs = Math.round(Math.abs(min));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h > 0) return `${sign}${h}h ${m}m`;
  return `${sign}${m}m`;
}
