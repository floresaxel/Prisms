/**
 * J5 — Hermes compatibility guard (D6). `Intl.Segmenter` is unsupported on Hermes
 * (React Native's engine), so NO code that ships to mobile — @prisms/core,
 * @prisms/ui, or the mobile app — may reference it. `truncatePlain` is code-point
 * based (not grapheme-segmented) for exactly this reason. This is the CI-greppable
 * guard the plan calls for; it also runs in node vitest (no RN runtime needed).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Every source tree that is bundled into the Hermes RN app.
const HERMES_DIRS = ['packages/core/src', 'packages/ui/src', 'apps/mobile/src'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('Hermes compatibility (J5/D6)', () => {
  it('references no Intl.Segmenter anywhere in the mobile-shipped code', () => {
    const files = HERMES_DIRS.flatMap((rel) => sourceFiles(path.join(repoRoot, rel)));
    expect(files.length).toBeGreaterThan(50); // sanity: the scan actually found the trees
    const offenders = files.filter((f) => /Intl\.Segmenter/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});
