/**
 * Cross-client display formatters that both web and mobile must agree on.
 *
 * `projectTone` lives here (and not in an app) because the colour a project's
 * dot gets is part of the shared reading of a plan: the same project must tint
 * the same on the web board, in the mobile itinerary, and in the day map
 * (MOBILE_TODAY_PLAN D7). Pure — no React, no platform colours; each client
 * maps the tone name onto its own palette (CSS `--px-*` on web, `theme.*` on
 * mobile).
 */

/** Stable per-project accent (the mock tints each project) derived from its id. */
const DOT_TONES = ['teal', 'blue', 'amber', 'green'] as const;
export type DotTone = (typeof DOT_TONES)[number];

export function projectTone(projectId: string | null): DotTone {
  if (!projectId) return 'blue';
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return DOT_TONES[h % DOT_TONES.length]!;
}

/**
 * The heading shown for a day's note. A stored `title` wins; otherwise the
 * default names the day, which is what the panel showed before titles existed.
 *
 * The default is DERIVED, never stored: an untitled note keeps `title = ''`, so
 * it cannot freeze a stale literal, and the date remains the note's identity no
 * matter what it is renamed to.
 */
export function journalTitleOf(title: string | null | undefined, date: string): string {
  const t = (title ?? '').trim();
  return t.length > 0 ? t : `Note · ${date}`;
}

/**
 * Is this note empty — i.e. should no row exist for it? Markdown whitespace and
 * a lone bullet/heading marker left behind by an editor still count as empty, so
 * clearing a note in a WYSIWYG really does remove it.
 */
/** Zero-width joiners/spaces + BOM a WYSIWYG leaves behind when you clear it.
 *  Built from an escaped string so no invisible character sits in this source. */
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\uFEFF]', 'g');
/** A line holding nothing but a list bullet, quote caret or heading hash. */
const MARKER_ONLY_LINE = /^[ \t>#*+-]+$/gm;

export function isJournalContentEmpty(content: string | null | undefined): boolean {
  return (content ?? '').replace(ZERO_WIDTH, '').replace(MARKER_ONLY_LINE, '').trim().length === 0;
}

/**
 * A vision's colour. Chosen by the user when the vision is created and stored in
 * the node's `attributes.color` (a type-specific extra — no schema change, and
 * `node.create` already carries `attributes`). Everything under a vision reads
 * its colour from here, so all of a vision's roadmaps group under one tint.
 *
 * Twenty swatches for at most MAX_VISIONS visions, so every vision can hold a
 * colour no other vision is using. Unlike `DotTone` (a semantic tone each client
 * maps to its own palette) these carry the hex itself: the swatch the user
 * picked is CONTENT, and it has to look the same on every client. Softer
 * surfaces are derived per-client (the web mixes towards the page background).
 *
 * Order matters — it is the picker's order, and the first FREE entry is what a
 * new vision defaults to.
 */
export const VISION_PALETTE = [
  { id: 'red', label: 'Red', hex: '#dc2626' },
  { id: 'rose', label: 'Rose', hex: '#e11d48' },
  { id: 'pink', label: 'Pink', hex: '#db2777' },
  { id: 'fuchsia', label: 'Fuchsia', hex: '#c026d3' },
  { id: 'purple', label: 'Purple', hex: '#9333ea' },
  { id: 'violet', label: 'Violet', hex: '#7c3aed' },
  { id: 'indigo', label: 'Indigo', hex: '#4f46e5' },
  { id: 'blue', label: 'Blue', hex: '#2563eb' },
  { id: 'sky', label: 'Sky', hex: '#0284c7' },
  { id: 'cyan', label: 'Cyan', hex: '#0891b2' },
  { id: 'teal', label: 'Teal', hex: '#0d9488' },
  { id: 'emerald', label: 'Emerald', hex: '#059669' },
  { id: 'green', label: 'Green', hex: '#16a34a' },
  { id: 'lime', label: 'Lime', hex: '#65a30d' },
  { id: 'yellow', label: 'Yellow', hex: '#ca8a04' },
  { id: 'amber', label: 'Amber', hex: '#d97706' },
  { id: 'orange', label: 'Orange', hex: '#ea580c' },
  { id: 'brown', label: 'Brown', hex: '#92400e' },
  { id: 'slate', label: 'Slate', hex: '#475569' },
  { id: 'stone', label: 'Stone', hex: '#78716c' },
] as const;

export type VisionColor = (typeof VISION_PALETTE)[number]['id'];

export const VISION_COLORS = VISION_PALETTE.map((c) => c.id) as readonly VisionColor[];

const isVisionColor = (v: unknown): v is VisionColor =>
  typeof v === 'string' && (VISION_COLORS as readonly string[]).includes(v);

/** The hex for a colour id (unknown ids fall back to the first swatch). */
export function visionHex(color: VisionColor): string {
  return (VISION_PALETTE.find((c) => c.id === color) ?? VISION_PALETTE[0]).hex;
}

/**
 * The colour to paint a vision (and everything grouped under it). Falls back to
 * a stable id-derived colour, so visions created before colours existed — and
 * any node whose vision is missing — still tint consistently rather than blank.
 */
export function visionColorOf(
  vision: { id: string; attributes?: Record<string, unknown> } | null | undefined,
): VisionColor {
  if (!vision) return 'blue';
  const chosen = vision.attributes?.['color'];
  if (isVisionColor(chosen)) return chosen;
  let h = 0;
  for (let i = 0; i < vision.id.length; i++) h = (h * 31 + vision.id.charCodeAt(i)) >>> 0;
  return VISION_COLORS[h % VISION_COLORS.length]!;
}

/**
 * The first palette entry no existing vision is wearing — what a new vision
 * defaults to, so colours stay unique without the user hunting for a free one.
 * Falls back to the first swatch if every colour is somehow taken.
 */
export function firstFreeVisionColor(taken: Iterable<VisionColor>): VisionColor {
  const used = new Set<VisionColor>(taken);
  return VISION_COLORS.find((c) => !used.has(c)) ?? VISION_COLORS[0]!;
}

// --- a vision's expected timeline -------------------------------------------
// Deliberately DATELESS (§ visions are direction, not deadlines): an order of
// magnitude — "about 6 months", "about 3 years" — not a calendar commitment.
// Stored beside the colour in `attributes.horizon`.

export const HORIZON_UNITS = ['months', 'years', 'decades'] as const;
export type HorizonUnit = (typeof HORIZON_UNITS)[number];

/** Quick-pick amounts per unit; any integer in [HORIZON_MIN, HORIZON_MAX] is legal. */
export const HORIZON_PRESETS: Record<HorizonUnit, readonly number[]> = {
  months: [3, 6, 9],
  years: [1, 3, 5, 8],
  decades: [1, 2, 3, 4],
};

export const HORIZON_MIN = 1;
export const HORIZON_MAX = 10;

export interface VisionHorizon {
  unit: HorizonUnit;
  amount: number;
}

const isHorizonUnit = (v: unknown): v is HorizonUnit =>
  typeof v === 'string' && (HORIZON_UNITS as readonly string[]).includes(v);

/** True when `amount` is a whole number inside the allowed range. */
export function isHorizonAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount >= HORIZON_MIN && amount <= HORIZON_MAX;
}

/** Read a stored horizon back; null when absent or malformed (never throws). */
export function readVisionHorizon(attributes: Record<string, unknown> | undefined): VisionHorizon | null {
  const raw = attributes?.['horizon'];
  if (typeof raw !== 'object' || raw === null) return null;
  const { unit, amount } = raw as { unit?: unknown; amount?: unknown };
  if (!isHorizonUnit(unit) || typeof amount !== 'number' || !isHorizonAmount(amount)) return null;
  return { unit, amount };
}

/** "6 months" · "1 year" · "2 decades" — singularized, no dates anywhere. */
export function formatHorizon(horizon: VisionHorizon | null): string {
  if (!horizon) return '';
  const noun = horizon.amount === 1 ? horizon.unit.slice(0, -1) : horizon.unit;
  return `${horizon.amount} ${noun}`;
}
