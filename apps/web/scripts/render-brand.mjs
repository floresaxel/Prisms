#!/usr/bin/env node
/**
 * Draws every Prisms brand file from the Threshold mark's geometry:
 *   docs/brand/*.svg                  vector masters (marks + app icon)
 *   docs/brand/app-icon-1024.png      source of the desktop (Tauri) icon set
 *   docs/brand/lockups/*.{svg,png}    mark + wordmark, horizontal and stacked, three tones
 *   apps/web/public/favicon.svg       the compact form, ink or white by scheme
 *   apps/landing/favicon.svg          the same file
 *   apps/web/public/icon-mark-*.png   PWA, home-screen and launcher icons
 *   apps/mobile/assets/brand/*.png    Expo icon, adaptive icon, splash, sign-in lockup
 *
 * The geometry repeats packages/ui/src/components/Mark.tsx (`doorAt`, `FORMS`,
 * `LOCKUP`): change the two together. Everything is rasterised by Playwright's
 * Chromium (the e2e browser), so no image library is needed; the wordmark is
 * Space Grotesk from @fontsource, embedded in the lockup SVGs so they render
 * the same anywhere.
 *
 *   pnpm --filter @prisms/web brand:icons
 *   pnpm --filter @prisms/desktop tauri icon ../../docs/brand/app-icon-1024.png
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test'; // CommonJS: take the default export

const { chromium } = playwright;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const dirs = {
  brand: join(repo, 'docs/brand'),
  lockups: join(repo, 'docs/brand/lockups'),
  web: join(repo, 'apps/web/public'),
  landing: join(repo, 'apps/landing'),
  mobile: join(repo, 'apps/mobile/assets/brand'),
};

const INK = '#0e1726';
const DOOR = '#2f6bff'; // Blue 500: the door on light grounds
const DOOR_ON_INK = '#4d82ff'; // the door on ink (tone "reversed")
const WHITE = '#ffffff';

/** The logo tones: the door's colour follows the ground. */
const TONES = {
  ink: { line: INK, door: DOOR, word: INK },
  reversed: { line: WHITE, door: DOOR_ON_INK, word: WHITE },
  'on-blue': { line: WHITE, door: INK, word: WHITE },
};

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

/** Wordmark size and gap as fractions of the mark's box (Mark.tsx `LOCKUP`). */
const LOCKUP = {
  horizontal: { word: 0.8, gap: 0.36, form: 'simple' }, // the everyday logo
  stacked: { word: 0.37, gap: 0.15, form: 'full' }, // covers, splash moments
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

/** The mark's box at (x, y), `size` units square. */
const markAt = (x, y, size, body) =>
  `<svg x="${r1(x)}" y="${r1(y)}" width="${r1(size)}" height="${r1(size)}" viewBox="${VIEWBOX}">${body}</svg>`;

/** The mark centred on a square artboard of `box` units, `scale` × its width. */
const placed = (box, scale, body) => markAt((box - box * scale) / 2, (box - box * scale) / 2, box * scale, body);

const r1 = (n) => Math.round(n * 10) / 10;

/** Line weights (200-unit space) for each use; the in-app sizes use markStroke(). */
const MASTER = { full: 7, simple: 10 };
const COMPACT = { w: 22, wDoor: 11 }; // the favicon: 16 px tabs
// How much of an icon the mark's box fills. The doors reach 0.45 of the box out
// from its centre (the door's bottom corners, line included), so:
//   tile 0.84: the pentagon spans ~76 % of the tile's width;
//   full-bleed icons cropped to a circle keep their centre: maskable PWA icons
//   a radius of 0.40 (box 0.72 reaches 0.37), Android's adaptive layer 0.306
//   (box 0.59 reaches 0.307: already at the edge, so it stays put).
const TILE = { w: 11, scale: 0.84, maskScale: 0.72, adaptiveScale: 0.59, radius: 112 }; // on a 512 tile

const reversed = (form, w = TILE.w) => doors(form, { line: WHITE, door: DOOR_ON_INK, w });

const appIcon = svg(
  '0 0 512 512',
  `<rect width="512" height="512" rx="${TILE.radius}" fill="${INK}"/>` + placed(512, TILE.scale, reversed('simple')),
);
// Maskable: full bleed; the launcher crops it to its own shape, keeping the
// centre 80 % circle, which the mark sits inside.
const appIconMaskable = svg(
  '0 0 512 512',
  `<rect width="512" height="512" fill="${INK}"/>` + placed(512, TILE.maskScale, reversed('simple')),
);
const favicon = svg(
  VIEWBOX,
  `<style>.l{stroke:${INK}}@media (prefers-color-scheme:dark){.l{stroke:#fff}}</style>` +
    doors('compact', { line: INK, door: DOOR, ...COMPACT, frameClass: 'l' }),
);

// Mobile (Expo). iOS wants an opaque square and rounds it itself; Android's
// adaptive icon is a transparent foreground over the ink background colour,
// cropped to a shape that keeps the centre 66 % (the mark stays inside it);
// the monochrome layer is what Android 13+ tints for themed icons.
const mobileIcon = svg('0 0 1024 1024', `<rect width="1024" height="1024" fill="${INK}"/>` + placed(1024, TILE.scale, reversed('simple')));
const mobileForeground = svg('0 0 1024 1024', placed(1024, TILE.adaptiveScale, reversed('simple')));
const mobileMonochrome = svg('0 0 1024 1024', placed(1024, TILE.adaptiveScale, doors('simple', { line: WHITE, door: WHITE, w: TILE.w })));
const mobileSplash = svg('0 0 1024 1024', placed(1024, 0.36, reversed('simple')));

const show = (p) => relative(repo, p).replaceAll('\\', '/');
const log = (line) => stdout.write(`${line}\n`);
const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  log(`wrote ${show(path)}`);
};

for (const [path, body] of Object.entries({
  [join(dirs.brand, 'mark-full.svg')]: svg(VIEWBOX, doors('full', { line: INK, door: DOOR, w: MASTER.full })),
  [join(dirs.brand, 'mark-simple.svg')]: svg(VIEWBOX, doors('simple', { line: INK, door: DOOR, w: MASTER.simple })),
  [join(dirs.brand, 'mark-compact.svg')]: svg(VIEWBOX, doors('compact', { line: INK, door: DOOR, ...COMPACT })),
  [join(dirs.brand, 'app-icon.svg')]: appIcon,
  [join(dirs.brand, 'app-icon-maskable.svg')]: appIconMaskable,
  [join(dirs.web, 'favicon.svg')]: favicon,
  [join(dirs.landing, 'favicon.svg')]: favicon,
})) {
  write(path, body);
}

// ── lockups ─────────────────────────────────────────────────────────────────
// Drawn with the mark's box = 100 units. The word is real <text> in the
// embedded font, centred on the mark the way the app's flex row centres it
// (dominant-baseline central = the middle of the font's ascent + descent).
const FONT_FILE = join(here, '../node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2');
const fontFace = `@font-face{font-family:'Space Grotesk';font-weight:400;src:url(data:font/woff2;base64,${readFileSync(FONT_FILE).toString('base64')}) format('woff2')}`;

/** `advance100`: the word's advance at 100 px with +2 % tracking, measured once. */
function lockupSvg(layout, tone, advance100) {
  const { word, gap, form } = LOCKUP[layout];
  const { line, door, word: ink } = TONES[tone];
  const S = 100;
  const size = S * word;
  const space = S * gap;
  const track = size * 0.02;
  const wordWidth = (advance100 * size) / 100 - track; // no tracking after the last letter
  const mark = doors(form, { line, door, w: MASTER[form] });
  const text = (x, y, anchor) =>
    `<text x="${r1(x)}" y="${r1(y)}" text-anchor="${anchor}" dominant-baseline="central" font-family="'Space Grotesk', sans-serif" font-size="${r1(size)}" letter-spacing="${r1(track * 100) / 100}" fill="${ink}">Prisms</text>`;
  let width;
  let height;
  let body;
  if (layout === 'horizontal') {
    width = S + space + wordWidth;
    height = S;
    body = markAt(0, 0, S, mark) + text(S + space, S / 2, 'start');
  } else {
    width = Math.max(S, wordWidth);
    height = S + space + size;
    // a middle anchor counts the trailing tracking: shift right by half of it
    body = markAt((width - S) / 2, 0, S, mark) + text(width / 2 + track / 2, S + space + size / 2, 'middle');
  }
  width = Math.ceil(width);
  height = Math.ceil(height);
  return { width, height, body: svg(`0 0 ${width} ${height}`, `<style>${fontFace}</style>${body}`) };
}

const pngs = [
  [join(dirs.web, 'icon-mark-192.png'), appIcon, 192, 192],
  [join(dirs.web, 'icon-mark-512.png'), appIcon, 512, 512],
  [join(dirs.web, 'icon-mark-maskable-512.png'), appIconMaskable, 512, 512],
  [join(dirs.brand, 'app-icon-1024.png'), appIcon, 1024, 1024],
  [join(dirs.mobile, 'icon.png'), mobileIcon, 1024, 1024],
  [join(dirs.mobile, 'adaptive-foreground.png'), mobileForeground, 1024, 1024],
  [join(dirs.mobile, 'adaptive-monochrome.png'), mobileMonochrome, 1024, 1024],
  [join(dirs.mobile, 'splash-icon.png'), mobileSplash, 1024, 1024],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await page.setContent(
    `<!doctype html><style>${fontFace}</style><svg width="800" height="200"><text id="w" x="0" y="100" font-family="'Space Grotesk'" font-size="100" letter-spacing="2">Prisms</text></svg>`,
  );
  // (evaluated in the page: passed as strings, since this file is linted as Node)
  await page.evaluate(`document.fonts.load('100px "Space Grotesk"')`);
  const advance100 = await page.evaluate(`document.getElementById('w').getComputedTextLength()`);

  for (const layout of Object.keys(LOCKUP)) {
    for (const tone of Object.keys(TONES)) {
      const name = `lockup-${layout}-${tone}`;
      const { width, height, body } = lockupSvg(layout, tone, advance100);
      write(join(dirs.lockups, `${name}.svg`), body);
      const scale = layout === 'horizontal' ? 1.6 : 4; // 160 px and 400-ish px tall
      pngs.push([join(dirs.lockups, `${name}.png`), body, Math.ceil(width * scale), Math.ceil(height * scale)]);
    }
  }
  // the mobile sign-in's logo: the horizontal ink lockup with a 32 dp mark,
  // at the densities React Native picks from
  const signIn = lockupSvg('horizontal', 'ink', advance100);
  const w1 = Math.round((signIn.width * 32) / 100);
  for (const [suffix, k] of [['', 1], ['@2x', 2], ['@3x', 3]]) {
    pngs.push([join(dirs.mobile, `lockup${suffix}.png`), signIn.body, w1 * k, 32 * k]);
  }

  for (const [path, body, width, height] of pngs) {
    mkdirSync(dirname(path), { recursive: true });
    await page.setViewportSize({ width, height });
    const sized = body.replace('<svg ', `<svg width="${width}" height="${height}" `);
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
    await page.evaluate('document.fonts.ready');
    await page.screenshot({ path, omitBackground: true });
    log(`wrote ${show(path)} (${width}×${height})`);
  }
} finally {
  await browser.close();
}
