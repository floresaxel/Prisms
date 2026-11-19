#!/usr/bin/env node
/**
 * Draws the Prisms brand files from the Threshold mark's geometry:
 *   docs/brand/*.svg                 vector masters (marks + app icon)
 *   apps/web/public/favicon.svg      the compact form, ink or white by scheme
 *   apps/landing/favicon.svg         the same file
 *   apps/web/public/icon-mark-*.png  PWA, home-screen and launcher icons
 *
 * The geometry repeats packages/ui/src/components/Mark.tsx (`doorAt`, `FORMS`):
 * change the two together. The PNGs are rasterised by Playwright's Chromium
 * (the e2e browser), so no image library is needed.
 *
 *   pnpm --filter @prisms/web brand:icons
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test'; // CommonJS: take the default export

const { chromium } = playwright;

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs = {
  brand: join(repo, 'docs/brand'),
  web: join(repo, 'apps/web/public'),
  landing: join(repo, 'apps/landing'),
};

const INK = '#0e1726';
const DOOR = '#2f6bff'; // Blue 500: the door on light grounds
const DOOR_ON_INK = '#4d82ff'; // the door on ink (tone "reversed")

/** Square box around every form, centred on the doors (x 100, y 94). */
const VIEWBOX = '6 0 188 188';

/** A door at `s` × full size standing on the floor (y = 170); `drop` lowers it. */
function doorAt(s, drop = 0) {
  const f = (n) => Math.round(n * 10) / 10;
  const corners = [
    [100, 170 - 152 * s],
    [100 + 79.9 * s, 170 - 94 * s],
    [100 + 49.4 * s, 170],
    [100 - 49.4 * s, 170],
    [100 - 79.9 * s, 170 - 94 * s],
  ];
  return corners.map(([x, y]) => `${f(x)},${f(y + drop)}`).join(' ');
}

const FORMS = {
  full: { frames: [1, 0.74, 0.48], door: 0.22 },
  simple: { frames: [1, 0.6], door: 0.3 },
  compact: { frames: [1], door: 0.5 },
};

/**
 * The mark's polygons. `w` is the frames' line, `wDoor` the filled door's; a
 * thinner door is dropped by the difference so it still stands flush on the
 * floor (its lower edge meets the bottom of the floor line).
 */
function doors(form, { line, door, w, wDoor = w, frameClass = '' }) {
  const { frames, door: s } = FORMS[form];
  const cls = frameClass ? ` class="${frameClass}"` : '';
  const outlines = frames.map(
    (f) => `<polygon${cls} points="${doorAt(f)}" fill="none" stroke="${line}" stroke-width="${w}" stroke-linejoin="round"/>`,
  );
  const filled = `<polygon points="${doorAt(s, (w - wDoor) / 2)}" fill="${door}" stroke="${door}" stroke-width="${wDoor}" stroke-linejoin="round"/>`;
  return outlines.join('') + filled;
}

const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

/** The mark centred on a square artboard of `box` units, `scale` × its width. */
function placed(box, scale, body) {
  const size = box * scale;
  const at = (box - size) / 2;
  return `<svg x="${at}" y="${at}" width="${size}" height="${size}" viewBox="${VIEWBOX}">${body}</svg>`;
}

/** Line weights (200-unit space) for each use; the in-app sizes use markStroke(). */
const MASTER = { full: 7, simple: 10 };
const COMPACT = { w: 22, wDoor: 11 }; // the favicon: 16 px tabs
const TILE = { w: 11, scale: 0.6, maskScale: 0.5, radius: 112 }; // on a 512 tile

const appIcon = svg(
  '0 0 512 512',
  `<rect width="512" height="512" rx="${TILE.radius}" fill="${INK}"/>` +
    placed(512, TILE.scale, doors('simple', { line: '#ffffff', door: DOOR_ON_INK, w: TILE.w })),
);
// Maskable: full bleed; the launcher crops it to its own shape, keeping the
// centre 80 % circle, which the mark sits well inside.
const appIconMaskable = svg(
  '0 0 512 512',
  `<rect width="512" height="512" fill="${INK}"/>` +
    placed(512, TILE.maskScale, doors('simple', { line: '#ffffff', door: DOOR_ON_INK, w: TILE.w })),
);
const favicon = svg(
  VIEWBOX,
  `<style>.l{stroke:${INK}}@media (prefers-color-scheme:dark){.l{stroke:#fff}}</style>` +
    doors('compact', { line: INK, door: DOOR, ...COMPACT, frameClass: 'l' }),
);

const files = {
  [join(dirs.brand, 'mark-full.svg')]: svg(VIEWBOX, doors('full', { line: INK, door: DOOR, w: MASTER.full })),
  [join(dirs.brand, 'mark-simple.svg')]: svg(VIEWBOX, doors('simple', { line: INK, door: DOOR, w: MASTER.simple })),
  [join(dirs.brand, 'mark-compact.svg')]: svg(VIEWBOX, doors('compact', { line: INK, door: DOOR, ...COMPACT })),
  [join(dirs.brand, 'app-icon.svg')]: appIcon,
  [join(dirs.brand, 'app-icon-maskable.svg')]: appIconMaskable,
  [join(dirs.web, 'favicon.svg')]: favicon,
  [join(dirs.landing, 'favicon.svg')]: favicon,
};

const pngs = [
  [join(dirs.web, 'icon-mark-192.png'), appIcon, 192],
  [join(dirs.web, 'icon-mark-512.png'), appIcon, 512],
  [join(dirs.web, 'icon-mark-maskable-512.png'), appIconMaskable, 512],
];

const show = (p) => relative(repo, p).replaceAll('\\', '/');
const log = (line) => stdout.write(`${line}\n`);

for (const [path, body] of Object.entries(files)) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  log(`wrote ${show(path)}`);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [path, body, size] of pngs) {
    await page.setViewportSize({ width: size, height: size });
    const sized = body.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
    await page.screenshot({ path, omitBackground: true });
    log(`wrote ${show(path)} (${size}px)`);
  }
} finally {
  await browser.close();
}
