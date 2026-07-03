-- PowerSync replicates via logical replication and requires this publication
-- on the source database (PSYNC_S1141 otherwise).
--
-- S6-F4 (R10): scope the publication to exactly the tables the sync streams
-- reference (packages/db/sync-streams.yaml), instead of FOR ALL TABLES. The
-- published set must be a SUPERSET of every table the sync rules query — it is
-- (all 23 below) — so narrowing is safe. This keeps the busiest INTERNAL tables
-- out of the WAL replication slot: better-auth users/sessions/accounts,
-- push_subscriptions (push keys), command_log + command_field_versions (per-field
-- write churn), and pg-boss's queue tables. None are synced to any client, so
-- shipping their WAL to the PowerSync service was pure replication-lag + slot cost.
--
-- Upgrading an EXISTING deployment (the FOR ALL TABLES era): this init script only
-- runs on a FRESH database. See docs/SELF_HOSTING.md "Upgrade notes" for the
-- ALTER PUBLICATION path + PowerSync reprocess step.
CREATE PUBLICATION powersync FOR TABLE
  nodes,
  edges,
  schedule_blocks,
  schedule_suggestion_batches,
  sprints,
  sprint_memberships,
  sync_review_items,
  user_settings,
  time_entries,
  habits,
  habit_completions,
  tags,
  tag_placements,
  tag_answers,
  decision_boards,
  decision_criteria,
  decision_scores,
  automation_rules,
  blocker_rules,
  external_facts,
  computed_aggregates,
  diagram_groups,
  diagram_layouts;
