#!/usr/bin/env node
/**
 * Draws the Prisms brand wallpapers into docs/brand/wallpapers/:
 *   wallpaper-desktop-{doorways,floors,corridor}.svg + 3840×2160 PNG
 *   wallpaper-phone-{doorways,doorway,corridor-paper}.svg + 1170×2532 PNG (3× a 390×844 screen)
 *
 * Ink, paper and blue only, and every wallpaper has exactly one filled door:
 * the brand's "now". The door is the same shape as the mark's
 * (render-brand.mjs `doorAt`, Mark.tsx), here placed anywhere on a canvas;
 * change the geometry in all three together. The wordmark is Space Grotesk
 * from @fontsource, embedded in the SVGs so they render the same anywhere.
 * Rasterised by Playwright's Chromium, like render-brand.mjs.
 *
 *   pnpm --filter @prisms/web brand:wallpapers
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test'; // CommonJS: take the default export

const { chromium } = playwright;

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const out = join(repo, 'docs/brand/wallpapers');

const INK = '#0e1726';
const PAPER = '#f4f5f7';
const DOOR = '#2f6bff'; // Blue 500: the door on light grounds
const DOOR_ON_INK = '#4d82ff'; // the door on ink
const WHITE = '#ffffff';

const r1 = (n) => Math.round(n * 10) / 10;

/** A door at `s` × full size (200-unit mark), its floor at (cx, floor). */
function door(cx, floor, s) {
  const corners = [
    [cx, floor - 152 * s],
    [cx + 79.9 * s, floor - 94 * s],
    [cx + 49.4 * s, floor],
    [cx - 49.4 * s, floor],
    [cx - 79.9 * s, floor - 94 * s],
  ];
  return corners.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');
}

const poly = (points, stroke, w, fill = 'none') =>
  `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/>`;
const hline = (y, width, stroke, w) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${stroke}" stroke-width="${w}"/>`;

/** The mark's door scales: the full form (four doors) and the compact one (two). */
const FULL = [1, 0.74, 0.48, 0.22];
const COMPACT = [1, 0.5];

/**
 * A half-drop lattice of tiles `tw` × `th`: row A at (ax, ay) inside each tile,
 * row B at (0, by), straddling the tiles' side edges. Returns every floor
 * point whose door can reach the canvas, row A first, tile by tile.
 */
function halfDrop(width, height, tw, th, { ax, ay, by }, reach) {
  const rows = Math.ceil((height + reach) / th);
  const cols = Math.ceil(width / tw);
  const a = [];
  const b = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c <= cols; c++) {
      if (c < cols) a.push({ x: ax + tw * c, y: ay + th * r, tile: r * cols + c });
      b.push({ x: tw * c, y: by + th * r });
    }
  }
  const seen = (p) => p.y - reach < height;
  return { a: a.filter(seen), b: b.filter(seen) };
}

// ── the wallpapers ──────────────────────────────────────────────────────────
const FONT_FILE = join(here, '../node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2');
const fontFace = `@font-face{font-family:'Space Grotesk';font-weight:400;src:url(data:font/woff2;base64,${readFileSync(FONT_FILE).toString('base64')}) format('woff2')}`;

/** "Prisms", +2 % tracking, centred on (cx, cy); the trailing tracking is split off. */
function wordmark(cx, cy, size, fill) {
  const track = size * 0.02;
  return `<text x="${r1(cx + track / 2)}" y="${r1(cy)}" text-anchor="middle" dominant-baseline="central" font-family="'Space Grotesk', sans-serif" font-size="${size}" letter-spacing="${r1(track * 100) / 100}" fill="${fill}">Prisms</text>`;
}

const svg = (width, height, ground, body, { text = false, label }) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">` +
  (text ? `<style>${fontFace}</style>` : '') +
  `<rect width="${width}" height="${height}" fill="${ground}"/>${body}</svg>\n`;

/** Desktop, pattern: outlined full marks in a half-drop grid; one door is lit. */
function desktopDoorways() {
  const [W, H, K, LINE] = [1920, 1080, 0.4, '#233049'];
  const NOW = 20; // row A, column 8, row 1: the mark at (1360, 380)
  const { a, b } = halfDrop(W, H, 160, 280, { ax: 80, ay: 100, by: 240 }, 152 * K);
  const mark = ({ x, y }, now) =>
    FULL.map((s, i) => {
      const last = i === FULL.length - 1;
      if (now && last) return poly(door(x, y, s * K), DOOR_ON_INK, 1.6, DOOR_ON_INK);
      return poly(door(x, y, s * K), now ? '#4a5a80' : LINE, 1.6);
    }).join('');
  const body = [...a.map((p) => mark(p, p.tile === NOW)), ...b.map((p) => mark(p, false))].join('');
  return svg(W, H, INK, body, {
    label: 'Ink wallpaper tiled with outlined Threshold marks in a half-drop grid; one mark has its door filled blue',
  });
}

/** Desktop, pattern: floor lines carrying doors, some nested; one inner door is filled. */
function desktopFloors() {
  const [W, H, T, LINE, FLOOR] = [1920, 1080, 240, '#cbd2dd', '#e1e5ec'];
  const NOW = { x: 1260, y: 350 }; // the nest on floor 1 of the tile at column 5, row 1
  let body = '';
  for (let y = 110; y < H; y += 120) body += hline(y, W, FLOOR, 1.5);
  for (let r = 0; r * T < H; r++) {
    for (let c = 0; c * T < W; c++) {
      const [x0, y0] = [c * T, r * T];
      for (const [nx, ny, sx, sy] of [
        [60, 110, 175, 110],
        [180, 230, 55, 230],
      ]) {
        const [x, y] = [x0 + nx, y0 + ny];
        const now = x === NOW.x && y === NOW.y;
        body += poly(door(x, y, 0.5), now ? '#8a94a6' : LINE, 1.6);
        body += now ? poly(door(x, y, 0.25), DOOR, 1.6, DOOR) : poly(door(x, y, 0.25), LINE, 1.6);
        body += poly(door(x0 + sx, y0 + sy, 0.3), LINE, 1.6);
      }
    }
  }
  return svg(W, H, PAPER, body, {
    label: 'Paper wallpaper of thin floor lines, each carrying outlined doors, some nested; one inner door is filled blue',
  });
}

/**
 * A corridor: the six plan layers as doors on one floor, outermost first,
 * stepping toward the filled door. `lines` are the five frames' colours.
 */
const corridor = (cx, floor, k, lines, fill, w) =>
  [1, 0.82, 0.64, 0.47, 0.3, 0.14]
    .map((s, i) => (i < lines.length ? poly(door(cx, floor, s * k), lines[i], w) : poly(door(cx, floor, s * k), fill, w, fill)))
    .join('');

/** Desktop, logo: the corridor brightening toward the blue door, the wordmark beneath. */
function desktopCorridor() {
  const [W, H] = [1920, 1080];
  const body =
    hline(800, W, '#26314a', 2) +
    corridor(960, 800, 4, ['#2a3650', '#3a4763', '#55658a', '#7a89aa', '#b3bdd0'], DOOR_ON_INK, 2) +
    wordmark(960, 902, 32, '#c3cbdb');
  return svg(W, H, INK, body, {
    text: true,
    label: 'Six doors nested on one floor line, brightening from dark outer frames to a filled blue door, with the Prisms wordmark beneath',
  });
}

/** Phone, pattern: the compact (two-door) mark in a half-drop grid; the lit one sits mid-screen. */
function phoneDoorways() {
  const [W, H, K, LINE] = [390, 844, 0.26, '#233049'];
  const NOW = 12; // row A, column 2, row 2: the mark at (195, 374)
  const { a, b } = halfDrop(W, H, 78, 156, { ax: 39, ay: 62, by: 140 }, 152 * K);
  const mark = ({ x, y }, now) =>
    poly(door(x, y, K), now ? '#4a5a80' : LINE, 1.4) +
    (now ? poly(door(x, y, COMPACT[1] * K), DOOR_ON_INK, 1.4, DOOR_ON_INK) : poly(door(x, y, COMPACT[1] * K), LINE, 1.4));
  const body = [...a.map((p) => mark(p, p.tile === NOW)), ...b.map((p) => mark(p, false))].join('');
  return svg(W, H, INK, body, {
    label: 'Ink phone wallpaper tiled with small two-door marks; one inner door is filled blue',
  });
}

/** Phone, logo: the full mark on a floor inside three far larger, faint doors. */
function phoneDoorway() {
  const [W, H, FLOOR] = [390, 844, 700];
  const ghosts = [
    [2.6, '#18223a'],
    [1.9, '#1e2942'],
    [1.3, '#27334d'],
  ]
    .map(([s, line]) => poly(door(195, FLOOR, s), line, 1.5))
    .join('');
  const mark = FULL.map((s, i) =>
    i === FULL.length - 1 ? poly(door(195, FLOOR, s * 0.7), DOOR_ON_INK, 2.4, DOOR_ON_INK) : poly(door(195, FLOOR, s * 0.7), WHITE, 2.4),
  ).join('');
  const body = hline(FLOOR, W, '#1f2a40', 1.5) + ghosts + mark + wordmark(195, 742, 22, '#c3cbdb');
  return svg(W, H, INK, body, {
    text: true,
    label: 'The Threshold mark standing on a floor line inside three much larger, faint doors, with the Prisms wordmark below',
  });
}

/** Phone, logo on paper: the corridor darkening toward ink and the blue door. */
function phoneCorridorPaper() {
  const [W, H] = [390, 844];
  const body =
    hline(560, W, '#d5dae3', 1.5) +
    corridor(195, 560, 1.7, ['#d5dae3', '#b9c1cf', '#8a94a6', '#5b6678', '#2a3446'], DOOR, 1.6) +
    wordmark(195, 612, 22, INK);
  return svg(W, H, PAPER, body, {
    text: true,
    label: 'Six doors on a paper ground, darkening from a pale outer frame to an ink inner door and a filled blue door, with the Prisms wordmark below',
  });
}

const DESKTOP = [3840, 2160]; // 4K; the OS scales it down for smaller screens
const PHONE = [1170, 2532]; // 3× a 390×844 screen

const WALLPAPERS = [
  ['wallpaper-desktop-doorways', desktopDoorways(), DESKTOP],
  ['wallpaper-desktop-floors', desktopFloors(), DESKTOP],
  ['wallpaper-desktop-corridor', desktopCorridor(), DESKTOP],
  ['wallpaper-phone-doorways', phoneDoorways(), PHONE],
  ['wallpaper-phone-doorway', phoneDoorway(), PHONE],
  ['wallpaper-phone-corridor-paper', phoneCorridorPaper(), PHONE],
];

const show = (p) => relative(repo, p).replaceAll('\\', '/');
const log = (line) => stdout.write(`${line}\n`);

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, body, [width, height]] of WALLPAPERS) {
    const svgPath = join(out, `${name}.svg`);
    writeFileSync(svgPath, body);
    log(`wrote ${show(svgPath)}`);

    const pngPath = join(out, `${name}.png`);
    await page.setViewportSize({ width, height });
    const sized = body.replace('<svg ', `<svg width="${width}" height="${height}" `);
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block}</style>${sized}`);
    await page.evaluate('document.fonts.ready');
    await page.screenshot({ path: pngPath });
    log(`wrote ${show(pngPath)} (${width}×${height})`);
  }
} finally {
  await browser.close();
}
