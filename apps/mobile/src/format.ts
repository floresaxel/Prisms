/** Display formatters (UI-only — core stays locale/format free). */

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatMinutes(min: number): string {
  const sign = min < 0 ? '−' : '';
  const abs = Math.round(Math.abs(min));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h > 0 ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}
