/**
 * Projects hub (web redesign W1 / D3): one screen hosting the existing Board /
 * Timeline / Graph / Decisions views under hash tabs (`#board|#timeline|#graph|
 * #decisions`). W1 keeps the old screens verbatim under plain tabs — the per-tab
 * re-skin + shared scope picker land in W5. Old routes redirect in here on boot.
 */
import type { CommandContext } from '@prisms/ui';

import { TabBar, useHashTab, type TabSpec } from '../components/HashTabs';
import { DecisionBoard } from './DecisionBoard';
import { Flowchart } from './Flowchart';
import { Gantt } from './Gantt';
import { Kanban } from './Kanban';

const TABS: readonly TabSpec[] = [
  { key: 'board', label: 'Board', icon: 'cols' },
  { key: 'timeline', label: 'Timeline', icon: 'gantt' },
  { key: 'graph', label: 'Graph', icon: 'net' },
  { key: 'decisions', label: 'Decisions', icon: 'scale' },
];

export function Projects({ ctx }: { ctx: CommandContext }) {
  const [tab, select] = useHashTab(TABS, 'board');
  return (
    <section>
      <TabBar tabs={TABS} active={tab} onSelect={select} />
      {tab === 'board' && <Kanban ctx={ctx} />}
      {tab === 'timeline' && <Gantt />}
      {tab === 'graph' && <Flowchart ctx={ctx} />}
      {tab === 'decisions' && <DecisionBoard ctx={ctx} />}
    </section>
  );
}
