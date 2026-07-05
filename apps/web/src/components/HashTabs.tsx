/**
 * Hash-driven tabs for the section hubs (Projects, Automations — W1/D3). The
 * active tab lives in `location.hash` (`#board`, `#rules`, …) so a tab is
 * linkable and survives reload; selecting one syncs the hash without pushing a
 * history entry. Old paths redirect into these hashes on boot (App.tsx).
 */
import { useEffect, useState } from 'react';

import { Ic, type IconName } from '@prisms/ui';

export interface TabSpec {
  key: string;
  label: string;
  icon: IconName;
}

function resolveHashTab(validKeys: string, fallback: string): string {
  const h = window.location.hash.replace(/^#/, '');
  return validKeys.split(',').includes(h) ? h : fallback;
}

/** [activeTabKey, select] — active derived from the URL hash, select syncs it. */
export function useHashTab(tabs: readonly TabSpec[], fallback: string): [string, (key: string) => void] {
  const validKeys = tabs.map((t) => t.key).join(',');
  const [tab, setTab] = useState(() => resolveHashTab(validKeys, fallback));
  useEffect(() => {
    const onHash = () => setTab(resolveHashTab(validKeys, fallback));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [validKeys, fallback]);
  function select(key: string) {
    if (window.location.hash !== `#${key}`) {
      window.history.replaceState({}, '', window.location.pathname + `#${key}`);
    }
    setTab(key);
  }
  return [tab, select];
}

export function TabBar({ tabs, active, onSelect }: { tabs: readonly TabSpec[]; active: string; onSelect: (key: string) => void }) {
  return (
    <div className="px-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={t.key === active}
          data-testid={`tab-${t.key}`}
          className={`px-tab${t.key === active ? ' px-tab--on' : ''}`}
          onClick={() => onSelect(t.key)}
        >
          <Ic name={t.icon} />
          {t.label}
        </button>
      ))}
    </div>
  );
}
