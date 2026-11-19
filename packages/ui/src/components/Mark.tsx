/**
 * The Threshold mark (brand, logo 23): pentagonal doors nested inside one
 * another, all standing on the same floor line. The innermost door is the only
 * filled shape, and it always means "now".
 *
 * Every door is the same shape (`doorAt`) scaled about the middle of the floor,
 * authored once in a 200-unit box. The mark comes in three forms:
 *   - `simple` (the default): three doors. The app's own mark: app icons, the
 *     sidebar, sign-in. Fewer lines, so each one can be heavier.
 *   - `full`: four doors. The landing page and other large brand moments.
 *   - compact: two doors (the outer frame and the filled door). Both forms
 *     drop to it under 20 px, where more lines smear together; the favicon.
 *
 * Rules from the brand sheet (docs/brand/README.md) are applied here, so
 * callers cannot get them wrong:
 *   - the stroke gets HEAVIER as the mark gets smaller, holding roughly 1.5 px
 *     of line on screen at any size;
 *   - the filled door stands flush on the floor: its lower edge meets the
 *     bottom of the floor line, with no sliver of frame showing beneath it;
 *   - the door's colour follows the ground: blue on light, lighter blue on ink,
 *     ink on brand blue.
 *
 * apps/web/scripts/render-brand.mjs repeats this geometry to draw the app icons
 * and the SVG masters in docs/brand: change the two together.
 */
import type { CSSProperties } from 'react';

/**
 * A door of the mark's shape at `s` × full size, standing on the floor
 * (y = 170). `drop` lowers it, which is how a door drawn with a thinner line
 * than its frame still reaches the bottom of the floor line.
 */
function doorAt(s: number, drop = 0): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  const corners: readonly (readonly [number, number])[] = [
    [100, 170 - 152 * s],
    [100 + 79.9 * s, 170 - 94 * s],
    [100 + 49.4 * s, 170],
    [100 - 49.4 * s, 170],
    [100 - 79.9 * s, 170 - 94 * s],
  ];
  return corners.map(([x, y]) => `${f(x)},${f(y + drop)}`).join(' ');
}

export type MarkVariant = 'simple' | 'full';

interface MarkForm {
  /** Outline doors, outer → inner, as scales of the outermost. */
  frames: readonly number[];
  /** Scale of the filled door. */
  door: number;
  /** Line weight of the frames, then of the door, × `markStroke(size)`. */
  weight: number;
  doorWeight: number;
}

const FORMS: Record<MarkVariant | 'compact', MarkForm> = {
  full: { frames: [1, 0.74, 0.48], door: 0.22, weight: 1, doorWeight: 1 },
  simple: { frames: [1, 0.6], door: 0.3, weight: 1.1, doorWeight: 1.1 },
  compact: { frames: [1], door: 0.5, weight: 1.6, doorWeight: 0.8 },
};

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
  /** `simple` (three doors) is the app's mark; `full` (four) is for the landing page. */
  variant?: MarkVariant;
  /** Force the two-door form; by default it is used below 20 px. */
  compact?: boolean;
  /** Accessible name. Omitted, the mark is decorative (hidden from AT). */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function ThresholdMark({
  size = 24,
  tone = 'ink',
  variant = 'simple',
  compact,
  title,
  className,
  style,
}: ThresholdMarkProps) {
  const { line, door } = TONES[tone];
  const form = FORMS[(compact ?? size < 20) ? 'compact' : variant];
  const w = markStroke(size) * form.weight;
  const wDoor = markStroke(size) * form.doorWeight;
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
      {form.frames.map((s) => (
        <polygon key={s} points={doorAt(s)} fill="none" stroke={line} strokeWidth={w} strokeLinejoin="round" />
      ))}
      {/* flush on the floor: the door's stroked lower edge meets the frame's */}
      <polygon
        points={doorAt(form.door, (w - wDoor) / 2)}
        fill={door}
        stroke={door}
        strokeWidth={wDoor}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The lockup: the mark with the wordmark, in proportion to the mark's box
 * (docs/brand, "Lockups"). Horizontal is the everyday logo (the sidebar keeps
 * the same numbers in theme.css: 22 px mark, 18 px word, 8 px gap); stacked is
 * for covers and splash moments, usually with the full mark.
 */
export const LOCKUP = {
  horizontal: { word: 0.8, gap: 0.36 },
  stacked: { word: 0.37, gap: 0.15 },
} as const;

export type LockupLayout = keyof typeof LOCKUP;

export interface ThresholdLockupProps {
  /** The mark's box in px; the wordmark and the gap follow from it. */
  size?: number;
  layout?: LockupLayout;
  /** The ground it sits on. `white` is a glyph tone, not a logo one. */
  tone?: Exclude<MarkTone, 'white'>;
  variant?: MarkVariant;
  className?: string;
  style?: CSSProperties;
}

/** Mark + wordmark. The word is real text, so it is what assistive tech reads. */
export function ThresholdLockup({
  size = 30,
  layout = 'horizontal',
  tone = 'ink',
  variant = 'simple',
  className,
  style,
}: ThresholdLockupProps) {
  const { word, gap } = LOCKUP[layout];
  const cls = `px-lockup px-lockup--${layout} px-lockup--${tone}${className ? ` ${className}` : ''}`;
  return (
    <span className={cls} style={{ gap: round1(size * gap), ...style }}>
      <ThresholdMark size={size} tone={tone} variant={variant} />
      <span className="px-lockup-word" style={{ fontSize: round1(size * word) }}>
        Prisms
      </span>
    </span>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

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
