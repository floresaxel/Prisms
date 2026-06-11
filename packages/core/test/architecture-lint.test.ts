/**
 * Regression tests for the S1 lint gates (BUILD_PLAN.md S1 DoD):
 *
 * 1. §16 purity — a deliberate `Date.now` (and friends) inside packages/core/src
 *    MUST fail lint.
 * 2. §5 boundaries — forbidden cross-package imports MUST fail lint, allowed
 *    ones must pass.
 *
 * The tests run the real ESLint engine with the repo's eslint.config.mjs
 * against virtual files, so the configuration itself is what is under test.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: repoRoot });
});

async function lintErrors(code: string, repoRelativeFilePath: string) {
  const results = await eslint.lintText(code, {
    filePath: path.join(repoRoot, repoRelativeFilePath),
  });
  const result = results[0];
  if (!result) throw new Error('ESLint returned no result');
  return result.messages.filter((m) => m.severity === 2);
}

function ruleIds(messages: { ruleId: string | null }[]): (string | null)[] {
  return messages.map((m) => m.ruleId);
}

describe('core purity bans (§16) inside packages/core/src', () => {
  it('rejects Date.now', async () => {
    const errors = await lintErrors(
      'export const t = Date.now();\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-properties');
  });

  it('rejects Math.random', async () => {
    const errors = await lintErrors(
      'export const r = Math.random();\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-properties');
  });

  it('rejects zero-argument new Date()', async () => {
    const errors = await lintErrors(
      'export const d = new Date();\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-syntax');
  });

  it('rejects fetch', async () => {
    const errors = await lintErrors(
      'export const p = fetch("https://example.com");\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-globals');
  });

  it('rejects timers', async () => {
    const errors = await lintErrors(
      'setTimeout(() => undefined, 1000);\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-globals');
  });

  it('rejects storage', async () => {
    const errors = await lintErrors(
      'export const v = localStorage.getItem("k");\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-globals');
  });

  it('rejects node: platform imports', async () => {
    const errors = await lintErrors(
      'import { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('no-restricted-syntax');
  });

  it('accepts pure code', async () => {
    const errors = await lintErrors(
      'export const add = (a: number, b: number): number => a + b;\n',
      'packages/core/src/__purity_probe__.ts',
    );
    expect(errors).toEqual([]);
  });

  it('does not apply the purity bans outside core/src', async () => {
    const errors = await lintErrors(
      'export const t = Date.now();\n',
      'apps/server/src/__purity_probe__.ts',
    );
    expect(ruleIds(errors)).not.toContain('no-restricted-properties');
  });
});

describe('package boundaries (§5)', () => {
  it('core may not import db', async () => {
    const errors = await lintErrors(
      'import "../../db/src/index";\n',
      'packages/core/src/__boundary_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('boundaries/dependencies');
  });

  it('core may not import ui', async () => {
    const errors = await lintErrors(
      'import "../../ui/src/index";\n',
      'packages/core/src/__boundary_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('boundaries/dependencies');
  });

  it('apps may not import server', async () => {
    const errors = await lintErrors(
      'import "../../server/src/index";\n',
      'apps/web/src/__boundary_probe__.ts',
    );
    expect(ruleIds(errors)).toContain('boundaries/dependencies');
  });

  it('db may import core', async () => {
    const errors = await lintErrors(
      'import "../../core/src/index";\n',
      'packages/db/src/__boundary_probe__.ts',
    );
    expect(ruleIds(errors)).not.toContain('boundaries/dependencies');
  });

  it('server may import db', async () => {
    const errors = await lintErrors(
      'import "../../../packages/db/src/index";\n',
      'apps/server/src/__boundary_probe__.ts',
    );
    expect(ruleIds(errors)).not.toContain('boundaries/dependencies');
  });

  it('ui may import core', async () => {
    const errors = await lintErrors(
      'import "../../core/src/index";\n',
      'packages/ui/src/__boundary_probe__.ts',
    );
    expect(ruleIds(errors)).not.toContain('boundaries/dependencies');
  });
});
