/**
 * Projects hub (web redesign W1/W5) — one screen hosting Roadmap / Board /
 * Timeline / Graph / Decisions under hash tabs
 * (`#roadmap|#board|#timeline|#graph|#decisions`). W5 adds a SHARED scope picker
 * (a project, or "All projects"): it filters the Board (Kanban), and scopes the
 * Timeline (Gantt) + Graph (Flowchart) to that project; Roadmap and Decisions are
 * scope-independent (Roadmap has its own roadmap picker), so the picker hides on
 * both. Old flat routes redirect into these hashes on boot (App.tsx).
 */
import { useMemo, useState } from 'react';

import { Ic, useNodeTree, type CommandContext } from '@prisms/ui';

import { TabBar, useHashTab, type TabSpec } from '../components/HashTabs';
import { DecisionBoard } from './DecisionBoard';
import { Flowchart } from './Flowchart';
import { Gantt } from './Gantt';
import { Kanban } from './Kanban';
import { Roadmap } from './Roadmap';

const TABS: readonly TabSpec[] = [
  { key: 'roadmap', label: 'Roadmap', icon: 'route' },
  { key: 'board', label: 'Board', icon: 'cols' },
  { key: 'timeline', label: 'Timeline', icon: 'gantt' },
  { key: 'graph', label: 'Graph', icon: 'net' },
  { key: 'decisions', label: 'Decisions', icon: 'scale' },
];

/** Tabs that bring their own scoping and so hide the shared project picker. */
const UNSCOPED = new Set(['roadmap', 'decisions']);

export function Projects({ ctx }: { ctx: CommandContext }) {
  const [tab, select] = useHashTab(TABS, 'board');
  const tree = useNodeTree();
  const projects = useMemo(
    () => [...tree.byId.values()].filter((n) => n.node_type === 'project').sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)),
    [tree],
  );
  const [scope, setScope] = useState<string>(''); // '' = All projects (persists across tabs)

  return (
    <section>
      <div className="px-page-head">
        <h1>Projects</h1>
        {!UNSCOPED.has(tab) && (
          <label className="px-scope">
            <Ic name="layers" />
            <select data-testid="projects-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <TabBar tabs={TABS} active={tab} onSelect={select} />

      {tab === 'roadmap' && <Roadmap ctx={ctx} />}
      {tab === 'board' && <Kanban ctx={ctx} projectId={scope || null} />}
      {tab === 'timeline' && <Gantt projectId={scope || null} />}
      {tab === 'graph' && <Flowchart ctx={ctx} rootId={scope || null} />}
      {tab === 'decisions' && <DecisionBoard ctx={ctx} />}
    </section>
  );
}
