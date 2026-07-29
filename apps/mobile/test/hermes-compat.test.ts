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

/**
 * React Native's codegen babel plugin reserves the export name `Commands` for
 * `codegenNativeCommands` results and throws on any other module that exports
 * it. Because @prisms/ui is in the mobile graph, a single `export { type
 * Commands }` there made the *entire* app un-bundlable in both dev and prod —
 * and nothing in `turbo lint typecheck test` could see it, because it is a
 * Metro/babel rule, not a TypeScript one. Hence this grep.
 */
// `export type Commands …` / `export const Commands …`
const RESERVED_DECL = /export\s+(?:type\s+|const\s+|let\s+|var\s+|class\s+|function\s+|interface\s+|enum\s+)?Commands\b/;
// `export { …, type Commands, … }` — `\b` will not match inside `createCommands`,
// and `Commands as Other` renames the export away, so neither is a hit.
const RESERVED_SPECIFIER = /export\s+(?:type\s+)?\{[^}]*\bCommands\s*(?:,|\}|$)/m;

describe('Hermes compatibility (J5/D6)', () => {
  it('references no Intl.Segmenter anywhere in the mobile-shipped code', () => {
    const files = HERMES_DIRS.flatMap((rel) => sourceFiles(path.join(repoRoot, rel)));
    expect(files.length).toBeGreaterThan(50); // sanity: the scan actually found the trees
    const offenders = files.filter((f) => /Intl\.Segmenter/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });

  it('exports nothing named `Commands` (RN codegen reserves it — breaks the bundle)', () => {
    const files = HERMES_DIRS.flatMap((rel) => sourceFiles(path.join(repoRoot, rel)));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return RESERVED_DECL.test(src) || RESERVED_SPECIFIER.test(src);
      })
      .map((f) => path.relative(repoRoot, f));
    expect(offenders).toEqual([]);
  });
});
