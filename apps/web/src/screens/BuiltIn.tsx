/**
 * Automations → Built-in (Annex L / D8). Automations the app performs itself:
 * they are not `automation_rules` (that grammar is trigger→spawn_task with rule
 * versioning), so they carry no rule row and never appear in rule CRUD, replay,
 * or drift audits. Each is a settings flag with a card here.
 *
 * Today there is exactly one: the journal day log. Writing the flag goes through
 * `settings.update`, whose optimistic effect flips the merged settings row before
 * the round-trip — so the footer appears/disappears immediately, offline too.
 */
import { Ic, useCommands, useUserSettings, type CommandContext } from '@prisms/ui';

export function BuiltIn({ ctx }: { ctx: CommandContext }) {
  const settings = useUserSettings();
  const commands = useCommands(ctx);
  const on = settings.journalDayLog;

  return (
    <div className="px-builtin">
      <div className="px-card px-builtin-card" data-testid="builtin-daylog">
        <div className="px-card-h">
          <Ic name="book" /> Journal day log
        </div>
        <div className="px-builtin-body">
          <p className="px-muted">
            Adds a read-only <b>Day log</b> under each journal day listing that day&rsquo;s scheduled blocks and
            completed tasks. It is generated from your existing tasks and agenda every time the page renders —
            nothing is stored, so it always matches what the rest of the app says, and it can&rsquo;t be edited.
            Turning it off hides it everywhere, including exports; turning it back on brings it straight back.
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`px-switch${on ? ' px-switch--on' : ''}`}
            data-testid="builtin-daylog-toggle"
            onClick={() => void commands.updateSettings({ journal_day_log: !on })}
          >
            <span className="px-switch-knob" />
            <span className="px-switch-lbl">{on ? 'On' : 'Off'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
