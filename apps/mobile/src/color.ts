/**
 * Colour maths for the RN styles (pure — unit-tested, no react-native import).
 *
 * Exists because gradients have to fade a theme colour to *its own* zero-alpha
 * form: fading to the literal `'transparent'` fades through black on Android,
 * which shows as a grey smear over the light background (T0/D8).
 */

/** `#rgb` / `#rrggbb` / `rgba(...)` → the same colour at `alpha` (0..1). */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  const rgb = toRgb(color);
  if (rgb === null) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

function toRgb(color: string): [number, number, number] | null {
  const hex = color.trim();
  if (hex.startsWith('#')) {
    const body = hex.slice(1);
    const full =
      body.length === 3 || body.length === 4
        ? body
            .slice(0, 3)
            .split('')
            .map((c) => c + c)
            .join('')
        : body.length === 6 || body.length === 8
          ? body.slice(0, 6)
          : null;
    if (full === null || !/^[0-9a-fA-F]{6}$/.test(full)) return null;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(hex);
  if (m === null) return null;
  return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
}
