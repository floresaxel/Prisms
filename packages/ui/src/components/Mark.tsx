/**
 * The Threshold mark (brand, logo 23): pentagonal doors nested inside one
 * another, all standing on the same floor line. The innermost door is the only
 * filled shape, and it always means "now".
 *
 * Geometry is authored once in a 200-unit box; every size scales from it.
 * Three rules from the brand sheet are applied here, so callers cannot get them
 * wrong:
 *   - the stroke gets HEAVIER as the mark gets smaller, holding roughly 1.5 px
 *     of line on screen at any size;
 *   - under 20 px the four doors smear together, so the mark drops to two (the
 *     outer frame and the filled door) — the favicon form;
 *   - the door's colour follows the ground: blue on light, lighter blue on ink,
 *     ink on brand blue.
 */
import type { CSSProperties } from 'react';

/** The four doors of the mark, outer → inner, sharing the base line y = 170. */
const DOORS = [
  '100,18 179.9,76 149.4,170 50.6,170 20.1,76',
  '100,57.5 159.1,100.4 136.6,170 63.4,170 40.9,100.4',
  '100,97 138.4,124.9 123.7,170 76.3,170 61.6,124.9',
  '100,136.6 117.6,149.3 110.9,170 89.1,170 82.4,149.3',
] as const;

/** The filled door of the two-door (compact) form. */
const COMPACT_DOOR = '100,94 140,123 124.7,170 75.3,170 60,123';

/**
 * Six doors, one per layer of the plan (vision → schedule block), on the same
 * floor. Used where depth in the hierarchy is being shown, not the logo.
 */
export const LAYER_DOORS = [
  '100,18 179.9,76 149.4,170 50.6,170 20.1,76',
  '100,45.4 165.5,92.9 140.5,170 59.5,170 34.5,92.9',
  '100,72.7 151.1,109.8 131.6,170 68.4,170 48.9,109.8',
  '100,98.6 137.6,125.8 123.2,170 76.8,170 62.4,125.8',
  '100,124.4 124,141.8 114.8,170 85.2,170 76,141.8',
  '100,148.7 111.2,156.8 106.9,170 93.1,170 88.8,156.8',
] as const;

/** Square box around every form, centred on the doors (x 100, y 94). */
const VIEWBOX = '6 0 188 188';

/**
 * `ink` on light grounds, `reversed` on ink, `on-blue` for the logo on brand
 * blue. `white` is not the logo: it is the glyph inside a control that is
 * itself the "now" colour (the running-timer pill), where the whole control is
 * already the filled door.
 */
export type MarkTone = 'ink' | 'reversed' | 'on-blue' | 'white';

const TONES: Record<MarkTone, { line: string; door: string }> = {
  ink: { line: 'var(--px-ink, #0e1726)', door: 'var(--px-door, #2f6bff)' },
  reversed: { line: '#ffffff', door: '#4d82ff' },
  'on-blue': { line: '#ffffff', door: 'var(--px-ink, #0e1726)' },
  white: { line: '#ffffff', door: '#ffffff' },
};

/** Stroke in 200-unit space that lands near 1.5 px on screen at `size`. */
export function markStroke(size: number): number {
  return Math.min(24, Math.max(6, 280 / size));
}

export interface ThresholdMarkProps {
  /** Rendered width and height in px. */
  size?: number;
  tone?: MarkTone;
  /** Force the two-door form; by default it is used below 20 px. */
  compact?: boolean;
  /** Accessible name. Omitted, the mark is decorative (hidden from AT). */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function ThresholdMark({ size = 24, tone = 'ink', compact, title, className, style }: ThresholdMarkProps) {
  const { line, door } = TONES[tone];
  const twoDoors = compact ?? size < 20;
  const w = markStroke(size) * (twoDoors ? 1.6 : 1);
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };
  return (
    <svg
      width={size}
      height={size}
      viewBox={VIEWBOX}
      className={className}
      style={style}
      focusable="false"
      {...a11y}
    >
      {twoDoors ? (
        <>
          <polygon points={DOORS[0]} fill="none" stroke={line} strokeWidth={w} strokeLinejoin="round" />
          <polygon points={COMPACT_DOOR} fill={door} stroke={door} strokeWidth={w / 2} strokeLinejoin="round" />
        </>
      ) : (
        DOORS.map((pts, i) => {
          const last = i === DOORS.length - 1;
          return (
            <polygon
              key={i}
              points={pts}
              fill={last ? door : 'none'}
              stroke={last ? door : line}
              strokeWidth={w}
              strokeLinejoin="round"
            />
          );
        })
      )}
    </svg>
  );
}

export interface DepthDoorProps {
  /** 0 = vision … 5 = schedule block. Clamped into range. */
  depth: number;
  /** Fill the door: this row is the one happening now. */
  now?: boolean;
  size?: number;
}

/**
 * Door scale per depth for the small glyph. Gentler than the six-door picture
 * (LAYER_DOORS): at icon size the true proportions shrink the deepest door to a
 * speck, and the deepest door is usually the one that is filled.
 */
const GLYPH_SCALE = [1, 0.84, 0.7, 0.58, 0.48, 0.4] as const;

/** A door of the mark's shape at `s` × full size, standing on the floor. */
function doorAt(s: number): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  const corners: readonly (readonly [number, number])[] = [
    [100, 170 - 152 * s],
    [100 + 79.9 * s, 170 - 94 * s],
    [100 + 49.4 * s, 170],
    [100 - 49.4 * s, 170],
    [100 - 79.9 * s, 170 - 94 * s],
  ];
  return corners.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
}

/**
 * One layer's door, drawn at its depth inside a faint outline of the outermost
 * door — a small glyph that says how far down the plan a row sits.
 */
export function DepthDoor({ depth, now = false, size = 22 }: DepthDoorProps) {
  const i = Math.max(0, Math.min(GLYPH_SCALE.length - 1, Math.round(depth)));
  const w = markStroke(size);
  return (
    <svg width={size} height={size} viewBox={VIEWBOX} aria-hidden="true" focusable="false" className="px-depth-door">
      {i > 0 && (
        // the outermost door as a ghost frame: what makes the depth readable.
        // A step darker than --px-floor, which disappears against white at icon size.
        <polygon points={doorAt(1)} fill="none" stroke="#b9c1cf" strokeWidth={w * 0.8} strokeLinejoin="round" />
      )}
      <polygon
        points={doorAt(GLYPH_SCALE[i] ?? 1)}
        fill={now ? 'var(--px-door, #2f6bff)' : 'none'}
        stroke={now ? 'var(--px-door, #2f6bff)' : 'var(--px-ink, #0e1726)'}
        strokeWidth={w}
        strokeLinejoin="round"
      />
    </svg>
  );
}
