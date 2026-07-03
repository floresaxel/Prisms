-- S6-F4 (R10): scope the PowerSync publication to exactly the tables the sync
-- streams reference (packages/db/sync-streams.yaml). The published set must be
-- a SUPERSET of every table the sync rules query — it is (all 23 below) — so
-- narrowing is safe. This keeps the busiest INTERNAL tables out of the WAL
-- replication slot: better-auth users/sessions/accounts, push_subscriptions
-- (push keys), command_log + command_field_versions (per-field write churn),
-- and pg-boss's queue tables. None are synced to any client.
--
-- Lives in a migration (not the initdb script) because `CREATE PUBLICATION ...
-- FOR TABLE` requires the tables to exist, and initdb runs on an empty
-- database before any migration — a table list there aborts postgres' first
-- boot. infra/postgres/init/02-powersync-publication.sql therefore creates the
-- publication EMPTY (so PowerSync's PSYNC_S1141 boot check passes) and this
-- migration scopes it once the tables exist. Handles every era:
--   · fresh database (empty publication from initdb)  → SET TABLE
--   · FOR ALL TABLES era (pre-R10 deployments)        → drop + recreate scoped
--     (postgres rejects SET TABLE on FOR ALL TABLES publications)
--   · no publication at all (plain test databases)    → CREATE scoped
-- After upgrading a LIVE deployment, restart PowerSync so it reprocesses
-- (docs/SELF_HOSTING.md "Upgrade notes").
DO $$
DECLARE
  synced_tables constant text :=
    'nodes, edges, schedule_blocks, schedule_suggestion_batches, '
    || 'sprints, sprint_memberships, sync_review_items, user_settings, '
    || 'time_entries, habits, habit_completions, '
    || 'tags, tag_placements, tag_answers, '
    || 'decision_boards, decision_criteria, decision_scores, '
    || 'automation_rules, blocker_rules, external_facts, computed_aggregates, '
    || 'diagram_groups, diagram_layouts';
  pub_exists boolean := false;
  pub_all_tables boolean := false;
BEGIN
  SELECT true, puballtables INTO pub_exists, pub_all_tables
    FROM pg_publication WHERE pubname = 'powersync';

  IF pub_exists AND pub_all_tables THEN
    DROP PUBLICATION powersync;
    pub_exists := false;
  END IF;

  IF pub_exists THEN
    EXECUTE 'ALTER PUBLICATION powersync SET TABLE ' || synced_tables;
  ELSE
    EXECUTE 'CREATE PUBLICATION powersync FOR TABLE ' || synced_tables;
  END IF;
END $$;
