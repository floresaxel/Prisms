/**
 * The "Shape" card on Plan › Vision: a chart of everything under the selected
 * vision (layout and counting rules in ../vision-shape), drawn as an icicle by
 * default or as a sunburst (./VisionSunburst). The view toggle is remembered per
 * device; the measure, zoom, pin, summary and detail line are shared by both.
 *
 * Read-only by design. It answers "where is the work under this vision?", and
 * every edit stays on the screen that owns that level: a block's detail line
 * links to the Roadmap screen rather than growing its own controls.
 *
 * Interaction: click a block to zoom into it (it becomes the full-width top
 * row), click the top row or press Esc to go back up, and click a task to pin
 * its details. The width toggle changes what a block's size stands for; the bar
 * along each block's bottom edge is always "% done".
 */
import { useCallback, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';

import type { TreeIndex } from '@prisms/core';
import { Ic } from '@prisms/ui';

import { formatMinutes } from '../format';
import {
  buildShape,
  cellStat,
  donePercent,
  donePercentLabel,
  findInShape,
  layoutShape,
  leadingBranch,
  roadmapOf,
  readShapeView,
  rowLabels,
  SHAPE_METRICS,
  SHAPE_VIEWS,
  shapeValue,
  shortMinutes,
  trailOf,
  typeLabel,
  writeShapeView,
  type ShapeMetric,
  type ShapeNode,
  type ShapeView,
} from '../vision-shape';

import { VisionSunburst } from './VisionSunburst';

/** Row pitch: a 44px block plus a 4px gap, matched by `.px-shape-cell` in theme.css. */
const ROW = 48;
/** Below this many pixels a block drops its text and is just colour. */
const TIGHT_PX = 64;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function VisionShape({
  tree,
  visionId,
  color,
  onNavigate,
}: {
  tree: TreeIndex;
  visionId: string;
  /** The vision's solid colour (hex). Every block is a tint of it. */
  color: string;
  onNavigate: (href: string) => void;
}) {
  const shape = useMemo(() => buildShape(tree, visionId), [tree, visionId]);
  const [metric, setMetric] = useState<ShapeMetric>('open');
  const [view, setViewState] = useState<ShapeView>(readShapeView);
  const setView = (v: ShapeView) => {
    setViewState(v);
    writeShapeView(v);
  };
  const sizeWord = view === 'icicle' ? 'width' : 'size';
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  // Labels only fit blocks wide enough to hold them, so the chart needs its
  // own width in pixels. 0 = not measured yet: draw every label. A callback ref
  // rather than an effect, because the chart mounts late (after the empty state)
  // when a vision's first task arrives.
  const [chartW, setChartW] = useState(0);
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setChartW(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!shape) return null;

  // A focused, hovered or pinned node can vanish under us (deleted, or synced
  // away). Each falls back rather than pointing at nothing.
  const focus = (focusId && findInShape(shape, focusId)) || shape;
  const hovered = hoverId ? findInShape(focus, hoverId) : null;
  const pinned = pinnedId ? findInShape(focus, pinnedId) : null;
  const shown = hovered ?? pinned ?? focus;

  const zoomTo = (item: ShapeNode) => {
    setFocusId(item === shape ? null : item.node.id);
    setPinnedId(null);
    setHoverId(null);
  };

  const onCell = (item: ShapeNode) => {
    if (item === focus) {
      if (focus.parent) zoomTo(focus.parent);
    } else if (item.children.length > 0) {
      zoomTo(item);
    } else {
      setPinnedId(pinnedId === item.node.id ? null : item.node.id);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && focus.parent) {
      e.stopPropagation();
      zoomTo(focus.parent);
    }
  };

  const head = (
    <div className="px-shape-head">
      <b>Shape</b>
      <div className="px-vd-units px-shape-views" role="radiogroup" aria-label="View">
        {SHAPE_VIEWS.map((v) => (
          <button
            key={v.value}
            type="button"
            role="radio"
            aria-checked={view === v.value}
            className={`px-vd-unit${view === v.value ? ' px-vd-unit--on' : ''}`}
            data-testid={`shape-view-${v.value}`}
            onClick={() => setView(v.value)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="px-head-actions">
        <span className="px-shape-by">{view === 'icicle' ? 'Width by' : 'Size by'}</span>
        <div className="px-vd-units" role="radiogroup" aria-label={view === 'icicle' ? 'Width by' : 'Size by'}>
          {SHAPE_METRICS.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={metric === m.value}
              className={`px-vd-unit${metric === m.value ? ' px-vd-unit--on' : ''}`}
              data-testid={`shape-metric-${m.value}`}
              onClick={() => setMetric(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  if (shape.tasks === 0) {
    return (
      <div className="px-mgr-card" data-testid="vis-shape">
        <div className="px-shape-head">
          <b>Shape</b>
        </div>
        <p className="px-muted" data-testid="shape-empty" style={{ margin: 0, fontSize: 12.5 }}>
          Nothing to chart yet. The shape appears once this vision&apos;s projects have tasks.
        </p>
      </div>
    );
  }

  const cells = layoutShape(focus, metric);
  const rows = rowLabels(cells);
  const total = shapeValue(focus, metric);
  const style = { '--px-shape-c': color } as CSSProperties;

  return (
    <div className="px-mgr-card px-shape" data-testid="vis-shape" style={style} onKeyDown={onKeyDown}>
      {head}

      <p className="px-shape-insight" data-testid="shape-insight">
        <Insight focus={focus} metric={metric} sizeWord={sizeWord} />
      </p>

      {/* Only while zoomed: at the top the trail would just repeat the top row. */}
      {focus.parent && <Trail focus={focus} up={focus.parent} onZoom={zoomTo} />}

      {view === 'sunburst' ? (
        <VisionSunburst
          focus={focus}
          metric={metric}
          hovered={hovered}
          pinned={pinned}
          onSlice={onCell}
          onHover={setHoverId}
        />
      ) : (
      <div className="px-shape-body">
        <div className="px-shape-gutter" aria-hidden="true" style={{ height: rows.length * ROW - 4 }}>
          {rows.map((label, i) => (
            <span key={i} style={{ top: i * ROW }}>
              {label}
            </span>
          ))}
        </div>
        <div
          ref={measure}
          className="px-shape-chart"
          role="group"
          aria-label={`Shape of ${focus.node.title}`}
          style={{ height: rows.length * ROW - 4 }}
        >
          {cells.map(({ item, x, w, row }) => {
            const n = item.node;
            // The focus is drawn even when it is worth nothing under this metric,
            // so a fully-done branch still says what it is.
            const off = w <= 0 && item !== focus;
            const tight = chartW > 0 && w * chartW < TIGHT_PX;
            const stat = cellStat(item, metric);
            const done = n.node_type === 'task' && n.completed_at !== null;
            return (
              <button
                key={n.id}
                type="button"
                className={
                  `px-shape-cell px-shape-cell--${n.node_type}` +
                  (done ? ' px-shape-cell--done' : '') +
                  (tight ? ' px-shape-cell--tight' : '') +
                  (off ? ' px-shape-cell--off' : '') +
                  (pinned === item ? ' px-shape-cell--pinned' : '')
                }
                data-testid={`shape-cell-${n.id}`}
                data-row={row}
                tabIndex={off ? -1 : undefined}
                aria-hidden={off || undefined}
                aria-label={`${typeLabel(n.node_type)} ${n.title}: ${stat}`}
                title={n.title}
                style={{ left: `${x * 100}%`, width: `max(0px, calc(${w * 100}% - 2px))`, top: row * ROW }}
                onClick={() => onCell(item)}
                onMouseEnter={() => setHoverId(n.id)}
                onMouseLeave={() => setHoverId(null)}
                onFocus={() => setHoverId(n.id)}
                onBlur={() => setHoverId(null)}
              >
                <span className="px-shape-t">{n.title}</span>
                <span className="px-shape-s">{stat}</span>
                <span className="px-shape-bar" style={{ width: `${donePercent(item)}%` }} />
              </button>
            );
          })}
        </div>
      </div>
      )}

      <div className="px-shape-legend">
        <span>
          <i className="px-shape-key" /> {view === 'icicle' ? 'Width' : 'Angle'} ={' '}
          {SHAPE_METRICS.find((m) => m.value === metric)!.label.toLowerCase()}
          {total > 0 && metric === 'time' && ` (${shortMinutes(total)})`}
        </span>
        <span>
          <i className="px-shape-key px-shape-key--bar" /> {view === 'icicle' ? 'Bottom edge' : 'Outer edge'} = share done
        </span>
        <span>
          <i className="px-shape-key px-shape-key--done" /> Done task
        </span>
        <span>
          {view === 'icicle'
            ? 'Click a block to zoom in · Esc goes back up'
            : 'Click a slice to zoom in · the centre or Esc goes back up'}
        </span>
      </div>

      <Detail item={shown} onNavigate={onNavigate} />
    </div>
  );
}

/** Where the zoom is, from the vision down; every step but the last zooms back to it. */
function Trail({ focus, up, onZoom }: { focus: ShapeNode; up: ShapeNode; onZoom: (item: ShapeNode) => void }) {
  return (
    <div className="px-shape-trail" data-testid="shape-trail">
      {trailOf(focus).map((n, i) => (
        <span key={n.node.id} className="px-shape-step">
          {i > 0 && <span className="px-shape-sep">›</span>}
          <button
            type="button"
            aria-current={n === focus ? 'location' : undefined}
            disabled={n === focus}
            onClick={() => onZoom(n)}
          >
            {n.node.title}
          </button>
        </span>
      ))}
      <button type="button" className="px-btn px-btn--sm px-shape-up" data-testid="shape-up" onClick={() => onZoom(up)}>
        <Ic name="up" /> Up a level
      </button>
    </div>
  );
}

/** One sentence on where the weight sits inside the focused block. */
function Insight({ focus, metric, sizeWord }: { focus: ShapeNode; metric: ShapeMetric; sizeWord: string }) {
  const lead = leadingBranch(focus, metric);
  const missing =
    metric === 'time' && focus.openUnestimated > 0
      ? ` ${plural(focus.openUnestimated, 'open task')} ${focus.openUnestimated === 1 ? 'has' : 'have'} no estimate, so ${focus.openUnestimated === 1 ? 'it is' : 'they are'} not shown at this ${sizeWord}.`
      : '';

  if (shapeValue(focus, metric) <= 0) {
    if (metric === 'time' && focus.openTasks > 0) return <>None of the open tasks here has an estimate yet, so there is no time to show.</>;
    return <>Everything here is done.</>;
  }
  if (!lead) return <>{missing.trim()}</>;

  const v = shapeValue(lead.item, metric);
  const t = shapeValue(focus, metric);
  const share = lead.share >= 1 ? 'All' : `${Math.round(lead.share * 100)}%`;
  const noun = { open: 'the open tasks sit', time: 'the time left sits', all: 'the tasks sit' }[metric];
  const amount = metric === 'time' ? `${shortMinutes(v)} of ${shortMinutes(t)}` : `${v} of ${t}`;
  return (
    <>
      {share} of {noun} in one {typeLabel(lead.item.node.node_type).toLowerCase()}: <b>{lead.item.node.title}</b> ({amount}).
      {missing}
    </>
  );
}

/** The strip under the chart: whatever is hovered, else pinned, else in focus. */
function Detail({ item, onNavigate }: { item: ShapeNode; onNavigate: (href: string) => void }) {
  const n = item.node;
  let nums: string;
  if (n.node_type === 'task') {
    const est = n.estimate_minutes === null ? 'no estimate' : `${formatMinutes(n.estimate_minutes)} estimated`;
    nums = `${n.completed_at !== null ? 'Done' : 'Open'} · ${est}`;
  } else {
    const parts = [
      plural(item.tasks, 'task'),
      `${item.tasks - item.openTasks} done`,
      `${formatMinutes(item.openMinutes)} estimated left` +
        (item.openUnestimated > 0 ? ` (+${item.openUnestimated} unestimated)` : ''),
      `${donePercentLabel(item)}% complete`,
    ];
    nums = parts.join(' · ');
  }
  const roadmap = roadmapOf(item);
  return (
    <div className="px-shape-detail" data-testid="shape-detail">
      <span className="px-shape-kind">{typeLabel(n.node_type)}</span>
      <span className="px-shape-name">{n.title}</span>
      <span className="px-shape-nums">{nums}</span>
      {roadmap && (
        <button
          type="button"
          className="px-btn px-btn--sm px-shape-open"
          data-testid="shape-open-roadmap"
          onClick={() => onNavigate(`/roadmap#${roadmap.node.id}`)}
        >
          <Ic name="route" /> {roadmap === item ? 'Open roadmap' : 'Open its roadmap'}
        </button>
      )}
    </div>
  );
}
