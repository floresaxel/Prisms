/**
 * The views card on Plan › Roadmap: one roadmap's projects four ways, all laid
 * out for you inside the card (no canvas to pan, zoom or drag).
 *
 *   Order     (default) what has to happen before what: projects in steps, by
 *             the dependencies between them; unlinked ones can happen any time.
 *   Mind map  the roadmap in the middle, projects balanced on both sides, each
 *             with its milestones and tasks as twigs. Folding is the only moving.
 *   Outline   the same tree as an indented table.
 *   List      projects partitioned into: can move now, blocked, finished.
 *
 * Read-only: the numbers and links come from roadmap-model; edits happen on the
 * screens that own each level (the detail strip links to Projects). The chosen
 * view is remembered per device. The card runs to the bottom of the window.
 */
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Ic } from '@prisms/ui';

import {
  chainOf,
  itemDone,
  layoutMindMap,
  MAP,
  readRoadmapView,
  ROADMAP_VIEWS,
  twigsOf,
  writeRoadmapView,
  type MindMapLayout,
  type RoadmapModel,
  type RoadmapProject,
  type RoadmapView,
} from '../roadmap-model';
import { shortMinutes, type ShapeNode } from '../vision-shape';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtDue = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : null;

/** Track an element's width, from a callback ref (it may mount late). */
function useWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [w, setW] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A small progress ring with the % in it. */
export function Ring({ pct, size = 30 }: { pct: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg className="px-rm-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="px-rm-ring-bg" cx={size / 2} cy={size / 2} r={r} />
      {pct > 0 && (
        <circle className="px-rm-ring-fg" cx={size / 2} cy={size / 2} r={r} strokeDasharray={`${(c * pct) / 100} ${c}`} />
      )}
      <text x="50%" y="50%">
        {pct}
      </text>
    </svg>
  );
}

export function RoadmapViews({
  model,
  color,
  toolbar,
  onNavigate,
}: {
  model: RoadmapModel;
  /** The owning vision's hex: every tint is mixed from it. */
  color: string;
  /** Controls at the bar's right edge (adding a project). */
  toolbar?: ReactNode;
  onNavigate: (href: string) => void;
}) {
  const [view, setViewState] = useState<RoadmapView>(readRoadmapView);
  const setView = (v: RoadmapView) => {
    setViewState(v);
    writeRoadmapView(v);
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? (model.byId.get(selectedId) ?? null) : null;
  const pick = (id: string) => setSelectedId((s) => (s === id ? null : id));

  // Fill the window: the card runs from where it starts to the bottom.
  const [fill, setFill] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = cardRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + (el.closest('.px-content')?.scrollTop ?? 0);
      setFill(Math.max(420, window.innerHeight - top - 24));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  // what the body can use: the card less its bar (~56) and strip (~46) and padding
  const bodyFill = Math.max(240, fill - 56 - 46 - 32);

  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const style = { '--px-rm-c': color, minHeight: fill || undefined } as CSSProperties;
  const empty = model.projects.length === 0;

  return (
    <div className="px-mgr-card px-rmv" data-testid="rm-views" data-view={view} ref={cardRef} style={style}>
      <div className="px-rmv-bar">
        <div className="px-vd-units" role="radiogroup" aria-label="Roadmap view">
          {ROADMAP_VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={view === v.value}
              className={`px-vd-unit${view === v.value ? ' px-vd-unit--on' : ''}`}
              data-testid={`rm-view-${v.value}`}
              onClick={() => setView(v.value)}
            >
              <Ic name={v.icon} /> {v.label}
            </button>
          ))}
        </div>
        <div className="px-head-actions">
          {view === 'map' && !empty && (
            <>
              <button
                type="button"
                className="px-btn px-btn--sm px-btn--ghost"
                data-testid="rm-fold-all"
                onClick={() => setFolded(new Set(model.projects.map((p) => p.node.id)))}
              >
                Fold all
              </button>
              <button
                type="button"
                className="px-btn px-btn--sm px-btn--ghost"
                data-testid="rm-unfold-all"
                onClick={() => {
                  setFolded(new Set());
                  setShowAll(new Set(model.projects.map((p) => p.node.id)));
                }}
              >
                Unfold all
              </button>
            </>
          )}
          {toolbar}
        </div>
      </div>

      <div className="px-rmv-body">
        {empty ? (
          <p className="px-muted" data-testid="rm-no-projects" style={{ margin: 'auto', fontSize: 13, textAlign: 'center' }}>
            This roadmap has no projects yet. Add one, and it appears here.
          </p>
        ) : view === 'order' ? (
          <OrderView model={model} selectedId={selectedId} onPick={pick} minHeight={bodyFill} />
        ) : view === 'map' ? (
          <MindMap
            model={model}
            selectedId={selectedId}
            onPick={pick}
            minHeight={bodyFill - 30}
            folded={folded}
            showAll={showAll}
            onFold={(id) => setFolded((s) => toggle(s, id))}
            onShowAll={(id) => setShowAll((s) => toggle(s, id))}
          />
        ) : view === 'outline' ? (
          <OutlineView model={model} selectedId={selectedId} onPick={pick} />
        ) : (
          <ListView model={model} selectedId={selectedId} onPick={pick} />
        )}
      </div>

      <Strip model={model} selected={selected} onNavigate={onNavigate} />
    </div>
  );
}

/** The strip under the views: the picked project, else the roadmap. */
function Strip({
  model,
  selected,
  onNavigate,
}: {
  model: RoadmapModel;
  selected: RoadmapProject | null;
  onNavigate: (href: string) => void;
}) {
  if (!selected) {
    return (
      <div className="px-rmv-strip" data-testid="rm-strip">
        <span className="px-rmv-kind">Roadmap</span>
        <span className="px-rmv-name">{model.roadmap.title}</span>
        <span className="px-rmv-nums">
          {model.projects.length > 0 ? 'Pick a project to see it here.' : 'Projects you add appear in every view.'}
        </span>
      </div>
    );
  }
  const s = selected.shape;
  const due = fmtDue(selected.node.due_date);
  const parts = [
    `${s.tasks - s.openTasks} of ${plural(s.tasks, 'task')} done`,
    `${shortMinutes(s.openMinutes)} left`,
    ...(due ? [`due ${due}`] : []),
    ...(selected.blockedBy.length ? [`blocked by ${titles(model, selected.blockedBy)}`] : []),
  ];
  return (
    <div className="px-rmv-strip" data-testid="rm-strip">
      <span className="px-rmv-kind">Project</span>
      <span className="px-rmv-name">{selected.node.title}</span>
      <span className="px-rmv-nums">{parts.join(' · ')}</span>
      <button type="button" className="px-btn px-btn--sm px-rmv-open" data-testid="rm-open-projects" onClick={() => onNavigate('/projects')}>
        <Ic name="layers" /> Open in Projects
      </button>
    </div>
  );
}

const titles = (model: RoadmapModel, ids: readonly string[]) =>
  ids.map((id) => model.byId.get(id)?.node.title ?? '').join(', ');

/** The line under a project's name, saying where it stands. */
function standing(model: RoadmapModel, p: RoadmapProject): { text: string; tone: 'blocked' | 'ready' | 'done' | 'plain' } {
  if (p.state === 'done') return { text: '✓ finished', tone: 'done' };
  if (p.state === 'blocked') return { text: `blocked by ${titles(model, p.blockedBy)}`, tone: 'blocked' };
  if (p.waitsOn.length > 0 && p.state === 'todo') return { text: 'ready to start', tone: 'ready' };
  if (p.shape.tasks === 0) return { text: 'no tasks yet', tone: 'plain' };
  return { text: `${p.shape.openTasks} open · ${shortMinutes(p.shape.openMinutes)} left`, tone: 'plain' };
}

// --- Order --------------------------------------------------------------------

interface Arrow {
  key: string;
  d: string;
  blocking: boolean;
  hot: boolean;
}

function OrderView({
  model,
  selectedId,
  onPick,
  minHeight,
}: {
  model: RoadmapModel;
  selectedId: string | null;
  onPick: (id: string) => void;
  minHeight: number;
}) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const lit = hoverId ? chainOf(model, hoverId) : null;
  const stepsRef = useRef<HTMLDivElement | null>(null);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Arrows go from each prerequisite's right edge to what it unblocks, measured
  // from the laid-out cards (and again whenever the steps re-flow).
  useLayoutEffect(() => {
    const box = stepsRef.current;
    if (!box) return;
    const draw = () => {
      const b = box.getBoundingClientRect();
      const at = (id: string) => box.querySelector<HTMLElement>(`[data-p="${id}"]`)?.getBoundingClientRect();
      const out: Arrow[] = [];
      for (const p of model.projects) {
        for (const q of p.waitsOn) {
          const from = at(q);
          const to = at(p.node.id);
          if (!from || !to) continue;
          const x1 = from.right - b.left + box.scrollLeft;
          const y1 = from.top + from.height / 2 - b.top;
          const x2 = to.left - b.left + box.scrollLeft - 6;
          const y2 = to.top + to.height / 2 - b.top;
          const mid = (x1 + x2) / 2;
          out.push({
            key: `${q}>${p.node.id}`,
            d: `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
            blocking: p.blockedBy.includes(q),
            hot: lit !== null && lit.has(q) && lit.has(p.node.id),
          });
        }
      }
      setArrows(out);
      setSize({ w: box.scrollWidth, h: b.height });
    };
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    return () => ro.disconnect();
    // `lit` is derived from hoverId, which is in the deps
  }, [model, hoverId]);

  const card = (p: RoadmapProject) => {
    const st = standing(model, p);
    return (
      <button
        key={p.node.id}
        type="button"
        className={
          `px-rm-card px-rm-card--${st.tone}` +
          (selectedId === p.node.id ? ' px-rm-card--sel' : '') +
          (lit && !lit.has(p.node.id) ? ' px-rm-card--dim' : '')
        }
        data-p={p.node.id}
        data-testid={`rm-order-${p.node.id}`}
        data-state={p.state}
        data-step={p.step ?? 'any'}
        onClick={() => onPick(p.node.id)}
        onMouseEnter={() => setHoverId(p.node.id)}
        onMouseLeave={() => setHoverId(null)}
        onFocus={() => setHoverId(p.node.id)}
        onBlur={() => setHoverId(null)}
      >
        <Ring pct={p.pct} />
        <span className="px-rm-card-main">
          <b>{p.node.title}</b>
          <small>{st.text}</small>
        </span>
      </button>
    );
  };

  const stepName = (i: number, n: number) => (i === 0 ? 'First' : i === n - 1 ? 'Last' : 'Then');
  return (
    <div className="px-rm-order">
      {model.steps.length > 0 ? (
        <div className="px-rm-steps" ref={stepsRef} style={{ minHeight: Math.max(200, minHeight - (model.free.length ? 120 : 0)) }}>
          <svg className="px-rm-arrows" width={size.w} height={size.h} aria-hidden="true">
            <defs>
              <marker id="rm-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 8 4 0 8z" className="px-rm-arrowhead" />
              </marker>
              <marker id="rm-arrow-b" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0 0 8 4 0 8z" className="px-rm-arrowhead px-rm-arrowhead--b" />
              </marker>
            </defs>
            {arrows.map((a) => (
              <path
                key={a.key}
                d={a.d}
                className={(a.blocking ? 'px-rm-arrow px-rm-arrow--b' : 'px-rm-arrow') + (a.hot ? ' px-rm-arrow--hot' : '')}
                markerEnd={`url(#${a.blocking ? 'rm-arrow-b' : 'rm-arrow'})`}
              />
            ))}
          </svg>
          {model.steps.map((ps, i) => (
            <div key={i} className="px-rm-step" data-testid={`rm-step-${i + 1}`}>
              <h4>
                <b>Step {i + 1}</b> {stepName(i, model.steps.length)}
              </h4>
              <div className="px-rm-stack">{ps.map(card)}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="px-muted px-rm-nolinks" data-testid="rm-order-none">
          None of these projects waits on another yet, so they can happen in any order. Link tasks across projects in
          Projects › Graph and the order shows here.
        </p>
      )}
      {model.free.length > 0 && (
        <div className="px-rm-free" data-testid="rm-order-free">
          <h4>{model.steps.length > 0 ? 'Any time · nothing waits on these' : 'Projects'}</h4>
          <div className="px-rm-free-row">{model.free.map(card)}</div>
        </div>
      )}
    </div>
  );
}

// --- Mind map -----------------------------------------------------------------

function MindMap({
  model,
  selectedId,
  onPick,
  minHeight,
  folded,
  showAll,
  onFold,
  onShowAll,
}: {
  model: RoadmapModel;
  selectedId: string | null;
  onPick: (id: string) => void;
  minHeight: number;
  folded: ReadonlySet<string>;
  showAll: ReadonlySet<string>;
  onFold: (id: string) => void;
  onShowAll: (id: string) => void;
}) {
  const [ref, measured] = useWidth();
  const width = measured || 1100; // before measuring (and in jsdom), lay out wide
  const [hoverId, setHoverId] = useState<string | null>(null);
  const twigs = (p: RoadmapProject) => twigsOf(p, { folded: folded.has(p.node.id), showAll: showAll.has(p.node.id) });
  const layout: MindMapLayout = layoutMindMap(model.projects, twigs, width, minHeight);
  const lit = hoverId ? chainOf(model, hoverId) : null;
  const T = MAP;
  const column = layout.mode === 'column';

  // connectors: root → project (trunk) and project → twig
  const links: { key: string; d: string; twig: boolean; hot: boolean }[] = [];
  const placeOf = new Map(layout.projects.map((p) => [p.id, p]));
  const { x: cx, y: cy } = layout.root;
  for (const pl of layout.projects) {
    const hot = hoverId === pl.id;
    if (column) {
      links.push({ key: `t${pl.id}`, d: `M14 54 L14 ${pl.y - 12} Q14 ${pl.y} ${pl.x} ${pl.y}`, twig: false, hot });
    } else {
      const dir = pl.side === 'right' ? 1 : -1;
      const sx = cx + dir * (T.ROOT_W / 2);
      const ex = pl.side === 'right' ? pl.x : pl.x + T.PROJ_W;
      links.push({ key: `t${pl.id}`, d: `M${sx} ${cy} C${sx + dir * 40} ${cy}, ${ex - dir * 40} ${pl.y}, ${ex} ${pl.y}`, twig: false, hot });
    }
  }
  for (const tw of layout.twigs) {
    const pl = placeOf.get(tw.projectId)!;
    const hot = hoverId === tw.projectId;
    if (column) {
      links.push({ key: `w${tw.projectId}${tw.y}`, d: `M46 ${pl.y + 25} L46 ${tw.y - 8} Q46 ${tw.y} ${tw.x} ${tw.y}`, twig: true, hot });
    } else {
      const dir = tw.side === 'right' ? 1 : -1;
      const fx = tw.side === 'right' ? pl.x + T.PROJ_W + 22 : pl.x - 22;
      links.push({
        key: `w${tw.projectId}${tw.y}`,
        d: `M${fx} ${pl.y} C${fx + dir * 22} ${pl.y}, ${tw.x - dir * 22} ${tw.y}, ${tw.x} ${tw.y}`,
        twig: true,
        hot,
      });
    }
  }
  const twigMax = column
    ? undefined
    : Math.max(90, (layout.mode === 'balanced' ? (width - T.ROOT_W) / 2 : width - T.ROOT_W) - T.REACH - T.PROJ_W - T.TWIG_REACH - 12);

  return (
    <div ref={ref} className="px-rm-mapwrap">
      <div
        className={`px-rm-map px-rm-map--${layout.mode}${lit ? ' px-rm-map--focus' : ''}`}
        data-testid="rm-map"
        data-mode={layout.mode}
        style={{ height: layout.height }}
        onMouseLeave={() => setHoverId(null)}
      >
        <svg className="px-rm-links" width={layout.width} height={layout.height} aria-hidden="true">
          {links.map((l) => (
            <path key={l.key} d={l.d} className={`px-rm-link${l.twig ? ' px-rm-link--twig' : ''}${l.hot ? ' px-rm-link--hot' : ''}`} />
          ))}
        </svg>

        <div
          className="px-rm-root"
          data-testid="rm-map-root"
          style={column ? { left: 0, top: 0 } : { left: cx - T.ROOT_W / 2, top: cy, width: T.ROOT_W }}
        >
          <b>{model.roadmap.title}</b>
          <span>
            {plural(model.projects.length, 'project')} · {model.openTasks} open
          </span>
        </div>

        {layout.projects.map((pl) => {
          const p = model.byId.get(pl.id)!;
          const st = standing(model, p);
          const isLit = !lit || lit.has(pl.id);
          const items = p.shape.children.length;
          return (
            <div key={pl.id}>
              <button
                type="button"
                className={
                  `px-rm-card px-rm-node px-rm-card--${st.tone}` +
                  (pl.side === 'left' && !column ? ' px-rm-node--left' : '') +
                  (selectedId === pl.id ? ' px-rm-card--sel' : '') +
                  (isLit ? '' : ' px-rm-card--dim')
                }
                data-testid={`rm-map-${pl.id}`}
                data-side={pl.side}
                style={column ? { left: pl.x, right: 0, top: pl.y } : { left: pl.x, top: pl.y, width: T.PROJ_W }}
                onClick={() => onPick(pl.id)}
                onMouseEnter={() => setHoverId(pl.id)}
                onFocus={() => setHoverId(pl.id)}
                onBlur={() => setHoverId(null)}
              >
                <Ring pct={p.pct} />
                <span className="px-rm-card-main">
                  <b>{p.node.title}</b>
                  <small>{st.text}</small>
                </span>
              </button>
              {!column && items > 0 && (
                <button
                  type="button"
                  className={`px-rm-fold${isLit ? '' : ' px-rm-card--dim'}`}
                  data-testid={`rm-fold-${pl.id}`}
                  aria-expanded={!folded.has(pl.id)}
                  aria-label={`${folded.has(pl.id) ? 'Show' : 'Hide'} what is in ${p.node.title}`}
                  title={`${folded.has(pl.id) ? 'Show' : 'Hide'} its milestones and tasks`}
                  style={{ left: pl.side === 'right' ? pl.x + T.PROJ_W + 4 : pl.x - 22, top: pl.y }}
                  onClick={() => onFold(pl.id)}
                >
                  {folded.has(pl.id) ? items : '–'}
                </button>
              )}
            </div>
          );
        })}

        {layout.twigs.map((tw) => {
          const isLit = !lit || lit.has(tw.projectId);
          const pos: CSSProperties =
            tw.side === 'right' || column ? { left: tw.x, top: tw.y } : { right: layout.width - tw.x, top: tw.y };
          if (tw.item === null) {
            return (
              <button
                key={`${tw.projectId}-more`}
                type="button"
                className={`px-rm-twig px-rm-twig--more${isLit ? '' : ' px-rm-card--dim'}`}
                data-testid={`rm-more-${tw.projectId}`}
                style={{ ...pos, maxWidth: twigMax }}
                onClick={() => onShowAll(tw.projectId)}
              >
                +{tw.more} more
              </button>
            );
          }
          return <Twig key={tw.item.node.id} item={tw.item} style={{ ...pos, maxWidth: twigMax }} dim={!isLit} />;
        })}
      </div>
    </div>
  );
}

function Twig({ item, style, dim }: { item: ShapeNode; style: CSSProperties; dim: boolean }) {
  const n = item.node;
  const ms = n.node_type === 'milestone';
  const done = itemDone(item);
  return (
    <span
      className={`px-rm-twig${ms ? ' px-rm-twig--ms' : ''}${done ? ' px-rm-twig--done' : ''}${dim ? ' px-rm-card--dim' : ''}`}
      data-testid={`rm-twig-${n.id}`}
      style={style}
      title={n.title}
    >
      <i className="px-rm-twig-dot" />
      <span className="px-rm-twig-t">{n.title}</span>
      {ms && (
        <em>
          {item.tasks - item.openTasks}/{item.tasks}
        </em>
      )}
    </span>
  );
}

// --- Outline ------------------------------------------------------------------

function OutlineView({ model, selectedId, onPick }: { model: RoadmapModel; selectedId: string | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const flip = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const rows: ReactNode[] = [];
  const itemRow = (item: ShapeNode, depth: number) => {
    const n = item.node;
    const ms = n.node_type === 'milestone';
    const done = itemDone(item);
    rows.push(
      <tr key={n.id} className={`px-rm-ol-item${done ? ' px-rm-ol-item--done' : ''}`} data-testid={`rm-outline-${n.id}`}>
        <td style={{ paddingLeft: 12 + depth * 18 }}>
          <span className="px-rm-ol-name">
            {ms ? '◆ ' : ''}
            <span style={ms ? { fontWeight: 560 } : undefined}>{n.title}</span>
          </span>
        </td>
        <td>{ms && <Bar pct={item.tasks ? ((item.tasks - item.openTasks) / item.tasks) * 100 : 0} label={`${item.tasks - item.openTasks}/${item.tasks}`} />}</td>
        <td className="px-rm-num">{item.openTasks || '–'}</td>
        <td className="px-rm-num">{item.openMinutes ? shortMinutes(item.openMinutes) : '–'}</td>
        <td>{fmtDue(n.due_date) ?? ''}</td>
        <td />
      </tr>,
    );
    for (const c of item.children) itemRow(c, depth + 1);
  };
  for (const p of model.projects) {
    const isOpen = open.has(p.node.id);
    rows.push(
      <tr
        key={p.node.id}
        className={`px-rm-ol-project${selectedId === p.node.id ? ' px-rm-ol--sel' : ''}`}
        data-testid={`rm-outline-${p.node.id}`}
        onClick={() => onPick(p.node.id)}
      >
        <td>
          <span className="px-rm-ol-name">
            <button
              type="button"
              className={`px-rm-tw${isOpen ? ' px-rm-tw--open' : ''}`}
              data-testid={`rm-outline-toggle-${p.node.id}`}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Hide' : 'Show'} what is in ${p.node.title}`}
              disabled={p.shape.children.length === 0}
              onClick={(e) => {
                e.stopPropagation();
                flip(p.node.id);
              }}
            >
              <Ic name="chevr" />
            </button>
            <Ring pct={p.pct} size={22} />
            <b>{p.node.title}</b>
          </span>
        </td>
        <td>
          <Bar pct={p.pct} label={`${p.pct}%`} />
        </td>
        <td className="px-rm-num">{p.shape.openTasks}</td>
        <td className="px-rm-num">{shortMinutes(p.shape.openMinutes)}</td>
        <td>{fmtDue(p.node.due_date) ?? ''}</td>
        <td>{p.blockedBy.length > 0 && <span className="px-rm-tag px-rm-tag--b">⏳ {titles(model, p.blockedBy)}</span>}</td>
      </tr>,
    );
    if (isOpen) for (const c of p.shape.children) itemRow(c, 1);
  }
  return (
    <div className="px-rm-ol-wrap">
      <table className="px-rm-ol" data-testid="rm-outline">
        <thead>
          <tr>
            <th>Project</th>
            <th>Progress</th>
            <th className="px-rm-num">Open</th>
            <th className="px-rm-num">Left</th>
            <th>Due</th>
            <th>Blocked by</th>
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function Bar({ pct, label }: { pct: number; label: string }) {
  return (
    <span className="px-rm-bar">
      <span className="px-rm-bar-track">
        <i style={{ width: `${pct}%` }} />
      </span>
      <em>{label}</em>
    </span>
  );
}

// --- List ---------------------------------------------------------------------

function ListView({ model, selectedId, onPick }: { model: RoadmapModel; selectedId: string | null; onPick: (id: string) => void }) {
  const groups = [
    {
      key: 'open',
      label: 'Can move now',
      note: 'Not waiting on any other project',
      items: model.projects.filter((p) => p.state === 'progress' || p.state === 'todo'),
    },
    { key: 'blocked', label: 'Blocked', note: 'Waiting for another project to finish', items: model.projects.filter((p) => p.state === 'blocked') },
    { key: 'done', label: 'Finished', note: '', items: model.projects.filter((p) => p.state === 'done') },
  ];
  return (
    <div className="px-rm-list">
      <div className="px-rm-list-head" aria-hidden="true">
        <span />
        <span>Project</span>
        <span>Progress</span>
        <span className="px-rm-num">Tasks</span>
        <span className="px-rm-num">Left</span>
        <span className="px-rm-num">Due</span>
        <span>Why it is here</span>
      </div>
      {groups.map((g) => (
        <section key={g.key} className={`px-rm-sec px-rm-sec--${g.key}`} data-testid={`rm-list-${g.key}`}>
          <h4>
            <i />
            {g.label} <em>{g.items.length}</em>
            {g.note && <small>{g.note}</small>}
          </h4>
          {g.items.length === 0 ? (
            <div className="px-rm-list-empty">Nothing here.</div>
          ) : (
            g.items.map((p) => {
              const due = fmtDue(p.node.due_date);
              let why: ReactNode = null;
              if (p.state === 'blocked') why = <span className="px-rm-tag px-rm-tag--b">⏳ blocked by {titles(model, p.blockedBy)}</span>;
              else if (p.state === 'done') why = <span className="px-rm-tag">✓ all tasks done</span>;
              else if (p.unblocks.length > 0) why = <span className="px-rm-tag">unblocks {titles(model, p.unblocks)}</span>;
              return (
                <button
                  key={p.node.id}
                  type="button"
                  className={`px-rm-row${selectedId === p.node.id ? ' px-rm-row--sel' : ''}`}
                  data-testid={`rm-row-${p.node.id}`}
                  onClick={() => onPick(p.node.id)}
                >
                  <Ring pct={p.pct} size={24} />
                  <b>{p.node.title}</b>
                  <span className="px-rm-bar-track">
                    <i style={{ width: `${p.pct}%` }} />
                  </span>
                  <span className="px-rm-num">
                    {p.shape.tasks - p.shape.openTasks}/{p.shape.tasks}
                  </span>
                  <span className="px-rm-num">{p.state === 'done' ? '–' : shortMinutes(p.shape.openMinutes)}</span>
                  <span className="px-rm-num">{due ?? ''}</span>
                  <span className="px-rm-why">{why}</span>
                </button>
              );
            })
          )}
        </section>
      ))}
    </div>
  );
}
