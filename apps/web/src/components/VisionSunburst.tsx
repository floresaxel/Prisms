/**
 * The sunburst view of the Vision "Shape" card (the icicle is the default; the
 * card owns the state, the summary, the trail and the detail line, and this
 * only draws the chart).
 *
 * The focus sits in the centre with its % done; each level below it is one ring,
 * and a slice's angle is its share of the chosen measure (the icicle's layout,
 * bent round: see layoutSunburst). A band on each slice's outer edge is how much
 * of it is done. Labels only fit the wider slices, so the focus's children are
 * also listed beside the chart, in ring order, with their share and % done.
 */
import { useId, type KeyboardEvent } from 'react';

import {
  cellStat,
  donePercent,
  donePercentLabel,
  fitLabel,
  labelArcPath,
  layoutSunburst,
  ringRadii,
  sectorPath,
  SHAPE_METRICS,
  shapeValue,
  typeLabel,
  type ShapeMetric,
  type ShapeNode,
} from '../vision-shape';

/** viewBox geometry, in SVG user units (the chart scales to its box). */
const SIZE = 440;
const C = SIZE / 2;
const RINGS = { inner: 70, outer: 212, gap: 3, maxBand: 72 };
/** Rough width of one label character at the 11px label size. */
const CHAR = 6.1;
/** The done band along a slice's outer edge. */
const EDGE = 4;

const PLURAL_TYPE: Record<string, string> = {
  roadmap: 'Roadmaps',
  project: 'Projects',
  milestone: 'Milestones',
  task: 'Tasks',
};

export function VisionSunburst({
  focus,
  metric,
  hovered,
  pinned,
  onSlice,
  onHover,
}: {
  focus: ShapeNode;
  metric: ShapeMetric;
  hovered: ShapeNode | null;
  pinned: ShapeNode | null;
  /** Same rules as an icicle block: the focus goes up, a branch zooms, a task pins. */
  onSlice: (item: ShapeNode) => void;
  onHover: (id: string | null) => void;
}) {
  // Label paths are referenced by id, so keep it to characters any fragment accepts.
  const uid = 'sun' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const arcs = layoutSunburst(focus, metric).filter((a) => a.ring > 0);
  const rings = arcs.reduce((m, a) => Math.max(m, a.ring), 0);
  const radii = ringRadii(rings, RINGS);
  const total = shapeValue(focus, metric);
  const measure = SHAPE_METRICS.find((m) => m.value === metric)!.label.toLowerCase();

  // The child of the focus that the hovered slice sits under, so its row lights up too.
  let hotRow: ShapeNode | null = hovered;
  while (hotRow && hotRow.parent !== focus) hotRow = hotRow.parent;

  const key = (item: ShapeNode) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSlice(item);
    }
  };

  const kids = focus.children;
  const kidTypes = [...new Set(kids.map((k) => k.node.node_type))];

  return (
    <div className="px-sun">
      <div className="px-sun-chart">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label={`Sunburst of ${focus.node.title}`}>
          {arcs.map(({ item, a0, a1, ring }) => {
            const band = radii[ring - 1];
            if (!band) return null;
            const d = sectorPath(C, C, a0, a1, band.r0, band.r1);
            if (!d) return null; // worth nothing under this measure
            const n = item.node;
            const done = n.node_type === 'task' && n.completed_at !== null;
            const pct = donePercent(item) / 100;
            const edge = pct > 0 ? sectorPath(C, C, a0, a0 + (a1 - a0) * pct, band.r1 - EDGE, band.r1) : '';
            // Label along the middle of the band, when the band and the slice can hold one.
            const rm = (band.r0 + band.r1) / 2 - 1.5;
            const title = (done ? '✓ ' : '') + n.title;
            const label = band.r1 - band.r0 < 20 ? '' : fitLabel(title, Math.floor(((a1 - a0) * rm - 14) / CHAR));
            const pad = 7 / rm;
            const pathId = `${uid}-lbl-${n.id}`;
            const stat = cellStat(item, metric);
            return (
              <g
                key={n.id}
                className={
                  `px-sun-node px-sun-node--${n.node_type}` +
                  (done ? ' px-sun-node--done' : '') +
                  (hovered === item ? ' px-sun-node--hot' : '') +
                  (pinned === item ? ' px-sun-node--pinned' : '')
                }
              >
                <path
                  className="px-sun-seg"
                  d={d}
                  role="button"
                  tabIndex={0}
                  aria-label={`${typeLabel(n.node_type)} ${n.title}: ${stat}`}
                  data-testid={`shape-arc-${n.id}`}
                  data-ring={ring}
                  onClick={() => onSlice(item)}
                  onKeyDown={key(item)}
                  onMouseEnter={() => onHover(n.id)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(n.id)}
                  onBlur={() => onHover(null)}
                >
                  <title>{`${n.title} · ${stat}`}</title>
                </path>
                {edge && <path className="px-sun-edge" d={edge} />}
                {label && (
                  <>
                    <path id={pathId} className="px-sun-lblpath" d={labelArcPath(C, C, a0 + pad, a1 - pad, rm)} />
                    <text className="px-sun-lbl" textAnchor="middle" dominantBaseline="central" aria-hidden="true">
                      <textPath href={`#${pathId}`} startOffset="50%">
                        {label}
                      </textPath>
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>

        <button
          type="button"
          className={`px-sun-center${focus.parent ? ' px-sun-center--up' : ''}`}
          data-testid="shape-center"
          aria-label={`${typeLabel(focus.node.node_type)} ${focus.node.title}: ${donePercentLabel(focus)}% done${focus.parent ? `. Back to ${focus.parent.node.title}` : ''}`}
          disabled={!focus.parent}
          onClick={() => onSlice(focus)}
        >
          <span className="px-sun-center-k">{typeLabel(focus.node.node_type)}</span>
          <span className="px-sun-center-p">{donePercentLabel(focus)}%</span>
          <span className="px-sun-center-d">done</span>
          {focus.parent && <span className="px-sun-center-u">↑ {focus.parent.node.title}</span>}
        </button>
      </div>

      <div className="px-sun-side">
        <div className="px-sun-side-h">
          {kidTypes.map((t) => PLURAL_TYPE[t] ?? t).join(' · ')} · share of {measure}
        </div>
        <div className="px-sun-rows">
          {kids.map((c) => {
            const v = shapeValue(c, metric);
            const share = total > 0 ? (v / total) * 100 : 0;
            const n = c.node;
            const isTask = n.node_type === 'task';
            const done = isTask && n.completed_at !== null;
            return (
              <button
                key={n.id}
                type="button"
                className={
                  'px-sun-row' + (share <= 0 ? ' px-sun-row--zero' : '') + (hotRow === c ? ' px-sun-row--hot' : '')
                }
                data-testid={`shape-row-${n.id}`}
                onClick={() => onSlice(c)}
                onMouseEnter={() => onHover(n.id)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(n.id)}
                onBlur={() => onHover(null)}
              >
                <span className="px-sun-row-top">
                  <span className="px-sun-row-t">{(done ? '✓ ' : '') + n.title}</span>
                  <span className="px-sun-row-v">{cellStat(c, metric).replace(/^\d+% done · /, '')}</span>
                </span>
                <span className="px-sun-row-bot">
                  <span className="px-sun-track">
                    <i style={{ width: `${share}%` }} />
                  </span>
                  <span className="px-sun-row-pc">{isTask ? `${Math.round(share)}%` : `${donePercentLabel(c)}% done`}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
