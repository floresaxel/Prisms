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
 * A vision's colour. Chosen by the user when the vision is created and stored in
 * the node's `attributes.color` (a type-specific extra — no schema change, and
 * `node.create` already carries `attributes`). Everything under a vision reads
 * its colour from here, so all of a vision's roadmaps group under one tint.
 *
 * The five names each have a full `--px-<name>` / `-bg` / `-brd` triplet in the
 * web theme, and MAX_VISIONS is 4, so a user can always give each vision its own.
 */
export const VISION_COLORS = ['teal', 'blue', 'amber', 'green', 'red'] as const;
export type VisionColor = (typeof VISION_COLORS)[number];

const isVisionColor = (v: unknown): v is VisionColor =>
  typeof v === 'string' && (VISION_COLORS as readonly string[]).includes(v);

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
