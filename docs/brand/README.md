# Prisms brand

The visual sheet (marks, construction, app icon, lockups, colour, type, usage,
in context) is the design canvas **Prisms Brand**:
https://claude.ai/artifact/YcSB19X5CHPJuSKLsVK4Zs. This file is the short
version that lives with the code.

## The mark: Threshold

Pentagonal doors nested inside one another, all standing on one floor line.
Every door is the same shape scaled about the middle of the floor; the
innermost door is the only filled shape, and it always means **now**.

| Form | Doors | Where | Size |
|---|---|---|---|
| **Full** | 4 (scales 1, 0.74, 0.48; door 0.22) | Landing page, hero, large brand moments | 32 px and up |
| **Simple** | 3 (scales 1, 0.60; door 0.30) | The app: icons, sidebar, sign-in | 20 px and up |
| **Compact** | 2 (scale 1; door 0.50) | Favicon, the "now" tag, the server chip | under 20 px |

In code: `<ThresholdMark />` (`packages/ui/src/components/Mark.tsx`) draws the
simple mark by default; `variant="full"` draws four doors, and both drop to the
compact form under 20 px (or with `compact`).

### Construction

- A door at scale `s` has corners `(100, 170 − 152s)`, `(100 ± 79.9s, 170 − 94s)`
  and `(100 ± 49.4s, 170)` in a 200-unit box; the mark is shown through
  `viewBox="6 0 188 188"`.
- **The door stands flush on the floor.** It is drawn with the frames' line
  weight, so its lower edge meets the bottom of the floor line. Where it must be
  thinner (the compact form), it drops by half the difference.
- **Heavier as it gets smaller.** Line = `280 / size` units, clamped to 6–24
  (about 1.5 px on screen). Simple × 1.1; compact frame × 1.6, its door × 0.8.
  Fixed lines for the files below: app tile 11, full master 7, simple master 10,
  favicon 22 / 11.

### Tones

| Ground | Frames | Door |
|---|---|---|
| Light (paper, white) | Ink `#0E1726` | Blue 500 `#2F6BFF` |
| Ink | White | `#4D82FF` |
| Brand blue | White | Ink |

## Colour

| Name | Hex | Token | Role |
|---|---|---|---|
| Ink | `#0E1726` | `--px-ink` | Type, the mark's frames, the icon tile |
| Paper | `#F4F5F7` | `--px-bg` | The ground |
| Door · Blue 500 | `#2F6BFF` | `--px-door` | "Now" only: the door, the running timer, the current block |
| Accent · Blue 600 | `#2459E6` | `--px-accent` | Controls and links (4.5:1 on white; Blue 500 is not) |
| Blue deep | `#1A45B8` | `--px-blue-deep` | Text on blue tint, pressed |
| Blue tint | `#EEF3FF` | `--px-blue-bg` | Selected rows, tags |
| Floor | `#D5DAE3` | `--px-floor` | Hairlines, ghost doors |

Flat colour only: no gradients, no glows, no purple or pink. Amber is caution
only and keeps its triangle.

## Type

- **Space Grotesk** (400/500): the wordmark (Regular, +2 % tracking) and page titles.
- **Inter** (400–700): the interface and body copy.
- **JetBrains Mono** (400/500): running clocks, the timer pill, commands.

## Usage

- Clear space: a quarter of the mark's width on every side.
- Don't fill a frame, lift the door off the floor, add gradients, recolour the
  door outside the tones above, rotate or skew the mark, or use the full mark
  below 32 px.

## Files

All drawn by `apps/web/scripts/render-brand.mjs` from the same geometry as
`Mark.tsx` (change the two together), then committed:

```powershell
pnpm --filter @prisms/web brand:icons
```

| File | What |
|---|---|
| `docs/brand/mark-full.svg` | Four-door master, ink + Blue 500 |
| `docs/brand/mark-simple.svg` | Three-door master |
| `docs/brand/mark-compact.svg` | Two-door master (favicon geometry) |
| `docs/brand/app-icon.svg` | App icon: ink rounded tile, simple mark reversed |
| `docs/brand/app-icon-maskable.svg` | Full-bleed variant, mark inside the 80 % safe circle |
| `apps/web/public/favicon.svg`, `apps/landing/favicon.svg` | Compact mark; the frame turns white in dark mode |
| `apps/web/public/icon-mark-{192,512,maskable-512}.png` | PWA, home-screen and desktop-launcher icons |

The launcher (`scripts/prisms-stack.ps1`) caches its `.ico` as `prisms-mark.ico`
and the desktop shortcut points at it. After a new mark, give the cache a new
name and re-run `-InstallShortcut`.
