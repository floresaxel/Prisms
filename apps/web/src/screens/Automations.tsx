/**
 * Automations hub (web redesign W1 / D3): hosts the existing Rules / Blockers
 * views under hash tabs (`#rules|#blockers`). W1 keeps the old screens verbatim
 * under plain tabs; the flow-pill re-skin + live impact line land in W7. Old
 * `/rules` and `/blockers` routes redirect in here on boot.
 */
import type { CommandContext } from '@prisms/ui';

import { TabBar, useHashTab, type TabSpec } from '../components/HashTabs';
import { Blockers } from './Blockers';
import { BuiltIn } from './BuiltIn';
import { Rules } from './Rules';

const TABS: readonly TabSpec[] = [
  { key: 'rules', label: 'Rules', icon: 'zap' },
  { key: 'blockers', label: 'Blockers', icon: 'lock' },
  // Annex L: automations the app performs itself. They are settings flags, not
  // automation_rules rows — the toggle lives here because this is where a user
  // looks for "what does Prisms do on its own?".
  { key: 'built-in', label: 'Built-in', icon: 'repeat' },
];

export function Automations({ ctx }: { ctx: CommandContext }) {
  const [tab, select] = useHashTab(TABS, 'rules');
  return (
    <section>
      <div className="px-page-head">
        <h1>Automations</h1>
        <span className="px-page-sub">rules spawn tasks; blockers gate them</span>
      </div>
      <TabBar tabs={TABS} active={tab} onSelect={select} />
      {tab === 'rules' && <Rules ctx={ctx} />}
      {tab === 'blockers' && <Blockers ctx={ctx} />}
      {tab === 'built-in' && <BuiltIn ctx={ctx} />}
    </section>
  );
}
