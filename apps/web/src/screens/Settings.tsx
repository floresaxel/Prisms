/**
 * Settings (§6.0 user_settings): the configurable day-reset hour + timezone
 * that drive every "today/daily" computation (§7.2). Writes settings.update;
 * a fresh account has no row yet, so the first save inserts one (id = user_id,
 * which the server upserts on).
 */
import { useEffect, useState } from 'react';

import { useQuery } from '@powersync/react';
import { useCommands, useFactContext, type CommandContext } from '@prisms/ui';

export function Settings({ ctx }: { ctx: CommandContext }) {
  const fact = useFactContext();
  const commands = useCommands(ctx);
  const existing = useQuery<{ id: string }>('SELECT id FROM user_settings LIMIT 1').data ?? [];
  const hasRow = existing.length > 0;

  const [hour, setHour] = useState(String(fact.dayResetHour));
  const [tz, setTz] = useState(fact.timezone);
  const [saved, setSaved] = useState(false);

  // keep inputs in sync if settings arrive after mount
  useEffect(() => {
    setHour(String(fact.dayResetHour));
    setTz(fact.timezone);
  }, [fact.dayResetHour, fact.timezone]);

  async function save() {
    const day_reset_hour = Math.min(23, Math.max(0, Number(hour) || 0));
    const timezone = tz.trim() || 'America/New_York';
    if (hasRow) await commands.updateSettings({ day_reset_hour, timezone });
    else await commands.insertSettings({ day_reset_hour, timezone });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section>
      <h1>Settings</h1>
      <p className="px-muted">The day-reset hour and timezone define when your day flips (§7.2).</p>

      <label className="px-field" style={{ maxWidth: 320 }}>
        Day-reset hour (0–23)
        <input className="px-input" type="number" min={0} max={23} data-testid="settings-hour" value={hour} onChange={(e) => setHour(e.target.value)} />
      </label>
      <label className="px-field" style={{ maxWidth: 320 }}>
        Timezone (IANA)
        <input className="px-input" data-testid="settings-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
      </label>
      <button className="px-btn px-btn--primary" data-testid="settings-save" onClick={() => void save()}>Save</button>
      {saved && <span className="px-muted" data-testid="settings-saved" style={{ marginLeft: 10 }}>Saved ✓</span>}
    </section>
  );
}
