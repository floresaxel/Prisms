/**
 * Automations hub (web redesign W1 / D3): hosts the existing Rules / Blockers
 * views under hash tabs (`#rules|#blockers`). W1 keeps the old screens verbatim
 * under plain tabs; the flow-pill re-skin + live impact line land in W7. Old
 * `/rules` and `/blockers` routes redirect in here on boot.
 */
import type { CommandContext } from '@prisms/ui';

import { TabBar, useHashTab, type TabSpec } from '../components/HashTabs';
import { Blockers } from './Blockers';
import { Rules } from './Rules';

const TABS: readonly TabSpec[] = [
  { key: 'rules', label: 'Rules', icon: 'zap' },
  { key: 'blockers', label: 'Blockers', icon: 'lock' },
];

export function Automations({ ctx }: { ctx: CommandContext }) {
  const [tab, select] = useHashTab(TABS, 'rules');
  return (
    <section>
      <TabBar tabs={TABS} active={tab} onSelect={select} />
      {tab === 'rules' && <Rules ctx={ctx} />}
      {tab === 'blockers' && <Blockers ctx={ctx} />}
    </section>
  );
}
