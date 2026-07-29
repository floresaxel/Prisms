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
