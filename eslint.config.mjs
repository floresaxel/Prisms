// ESLint flat config for the Prisms monorepo.
//
// Enforces ARCHITECTURE.md §5 (package dependency rules, via eslint-plugin-boundaries)
// and §16 (core purity: no wall clock, no randomness, no IO, no platform APIs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// §16: core is forbidden from importing Date.now, Math.random, timers, fetch, or storage.
// Clock and Rng are injected parameters; IO lives in the apps, never in core.
const CORE_BANNED_GLOBALS = [
  // network
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  // timers
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  // storage
  'localStorage',
  'sessionStorage',
  'indexedDB',
  // platform objects
  'window',
  'document',
  'navigator',
  'process',
  'require',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dev-dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/src-tauri/target/**',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- ARCHITECTURE.md §5 dependency rules -------------------------------
  // core imports nothing from other packages. db imports core (types only).
  // ui, server, and all apps import core. Apps never import server.
  {
    name: 'prisms/boundaries',
    files: [
      'packages/*/src/**/*.{ts,tsx}',
      'packages/*/test/**/*.{ts,tsx}',
      'apps/*/src/**/*.{ts,tsx}',
      'apps/*/test/**/*.{ts,tsx}',
    ],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': repoRoot,
      'boundaries/dependency-nodes': ['import', 'export', 'dynamic-import'],
      'boundaries/elements': [
        { type: 'core', pattern: 'packages/core' },
        { type: 'db', pattern: 'packages/db' },
        { type: 'ui', pattern: 'packages/ui' },
        { type: 'server', pattern: 'apps/server' },
        { type: 'web', pattern: 'apps/web' },
        { type: 'mobile', pattern: 'apps/mobile' },
        { type: 'desktop', pattern: 'apps/desktop' },
      ],
      'import/resolver': {
        typescript: {
          project: [
            path.join(repoRoot, 'packages/*/tsconfig.json'),
            path.join(repoRoot, 'apps/*/tsconfig.json'),
          ],
          noWarnOnMultipleProjects: true,
        },
        node: {
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'],
        },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            '${from.type} is not allowed to depend on ${dependency.type} (ARCHITECTURE.md §5 dependency rules)',
          rules: [
            { from: { type: 'core' }, allow: { to: { type: ['core'] } } },
            { from: { type: 'db' }, allow: { to: { type: ['db', 'core'] } } },
            { from: { type: 'ui' }, allow: { to: { type: ['ui', 'core'] } } },
            {
              from: { type: 'server' },
              allow: { to: { type: ['server', 'core', 'db'] } },
            },
            {
              from: { type: 'web' },
              allow: { to: { type: ['web', 'core', 'ui'] } },
            },
            {
              from: { type: 'mobile' },
              allow: { to: { type: ['mobile', 'core', 'ui'] } },
            },
            {
              from: { type: 'desktop' },
              allow: { to: { type: ['desktop', 'core', 'ui'] } },
            },
          ],
        },
      ],
    },
  },

  // --- ARCHITECTURE.md §16 core purity bans -------------------------------
  // Applies to shipped core source only; core/test may use node APIs to drive
  // the test harness, but the code under test never can.
  {
    name: 'prisms/core-purity',
    files: ['packages/core/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message:
            'core is pure: read time from the injected Clock, never the wall clock (§16).',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'core is pure: use the injected Rng, never Math.random (§16).',
        },
        {
          object: 'globalThis',
          property: 'fetch',
          message: 'core never performs IO (§16).',
        },
      ],
      'no-restricted-globals': [
        'error',
        ...CORE_BANNED_GLOBALS.map((name) => ({
          name,
          message: `core is platform-free: "${name}" is banned in packages/core/src (§16).`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message:
            'core is pure: zero-argument new Date() reads the wall clock; use the injected Clock (§16).',
        },
        {
          selector: 'ImportDeclaration[source.value=/^node:/]',
          message:
            'core imports no platform modules (node:*); it must run identically everywhere (§16).',
        },
      ],
    },
  },
);
