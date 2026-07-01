/**
 * M11 (Fix A, §7.14) structural DoD: the provider-shared tables are subscribed
 * ONLY in `PrismsDataProvider`, never inside a screen hook. This is the static
 * half of the DoD (Session-Protocol rule 2 — "no provider-shared table is
 * subscribed inside a screen"); the runtime build-count-invariance half lives in
 * apps/web/test/data-provider.test.ts.
 *
 * Grounding it on the source text keeps it immune to a future hook re-adding a
 * `useRows('… FROM nodes …')` shortcut that would reintroduce the read-path flash.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** The 9 provider-shared base tables (v1.4 Table→Owner Matrix). */
const SHARED = [
  'nodes',
  'edges',
  'time_entries',
  'schedule_blocks',
  'sprints',
  'sprint_memberships',
  'blocker_rules',
  'external_facts',
  'user_settings',
] as const;

/** Tables that legitimately stay screen-local (subscribed via `useRows` in hooks.ts). */
const SCREEN_LOCAL = [
  'decision_boards',
  'diagram_layouts',
  'automation_rules',
  'habits',
  'habit_completions',
  'tags',
  'computed_aggregates',
  'sync_review_items',
] as const;

const hooksSrc = readFileSync(new URL('../src/hooks.ts', import.meta.url), 'utf8');
const providerSrc = readFileSync(new URL('../src/powersync/data-provider.tsx', import.meta.url), 'utf8');

describe('§7.14 persistent read layer — shared subscriptions live only in the provider', () => {
  it('hooks.ts subscribes NONE of the 9 shared tables (no useRows over them)', () => {
    for (const t of SHARED) {
      // useRows('SELECT … FROM <t> …') — the calls are single-line, so [^)]* is bounded.
      const re = new RegExp(`useRows\\([^)]*\\bfrom\\s+${t}\\b`, 'i');
      expect(re.test(hooksSrc), `hooks.ts still subscribes shared table "${t}" via useRows`).toBe(false);
    }
  });

  it('hooks.ts calls useQuery only inside the screen-local useRows primitive (not directly)', () => {
    // The only useQuery calls left in hooks.ts are the TWO inside `useRows` (the
    // screen-local replica read + its overlay read); every shared table moved to
    // the provider. No screen hook opens its own base subscription.
    const matches = hooksSrc.match(/useQuery</g) ?? [];
    expect(matches.length, 'hooks.ts should call useQuery only twice (replica + overlay, both in useRows)').toBe(2);
  });

  it('the provider subscribes exactly the 9 shared base tables (one each) + one overlay read', () => {
    for (const t of SHARED) {
      const re = new RegExp(`useQuery<[^>]*>\\([^)]*\\bfrom\\s+${t}\\b`, 'i');
      expect(re.test(providerSrc), `provider is missing the shared subscription for "${t}"`).toBe(true);
    }
    expect(/useQuery<[^>]*>\([^)]*from\s+overlay_effects\b/i.test(providerSrc), 'provider must read overlay_effects once').toBe(true);
    // exactly 10 useQuery calls in the provider: 9 base + 1 overlay.
    const providerQueries = providerSrc.match(/useQuery</g) ?? [];
    expect(providerQueries.length).toBe(10);
  });

  it('screen-local tables still read through useRows in hooks.ts (not accidentally hoisted)', () => {
    for (const t of SCREEN_LOCAL) {
      const re = new RegExp(`useRows\\([^)]*\\bfrom\\s+${t}\\b`, 'i');
      expect(re.test(hooksSrc), `screen-local table "${t}" should still be read via useRows in hooks.ts`).toBe(true);
    }
  });
});
