/**
 * T0 (MOBILE_TODAY_PLAN D7): `projectTone` is now shared, so web and mobile
 * must derive the *same* tone for the same project id. These lock the mapping
 * — changing the hash would silently recolour every board, itinerary and day
 * map at once.
 */
import { describe, expect, it } from 'vitest';

import { projectTone } from '../src/format';

const TONES = ['teal', 'blue', 'amber', 'green'];

describe('projectTone', () => {
  it('is deterministic for a given id', () => {
    const id = '018f2c7a-1f3b-7a21-9c4e-3b6d5f0a1e22';
    expect(projectTone(id)).toBe(projectTone(id));
  });

  it('falls back to blue for no project', () => {
    expect(projectTone(null)).toBe('blue');
    expect(projectTone('')).toBe('blue');
  });

  it('only ever returns a known tone', () => {
    for (let i = 0; i < 200; i++) expect(TONES).toContain(projectTone(`project-${i}`));
  });

  it('spreads ids across all four tones', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => projectTone(`project-${i}`)));
    expect([...seen].sort()).toEqual([...TONES].sort());
  });

  it('pins the exact hash so web and mobile cannot drift apart', () => {
    expect(['a', 'b', 'c', 'd'].map((id) => projectTone(id))).toEqual(['blue', 'amber', 'green', 'teal']);
  });
});
