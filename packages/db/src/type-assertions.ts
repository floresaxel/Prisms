/**
 * Compile-time proof that Drizzle row types equal core entity types
 * (BUILD_PLAN.md S3 DoD: "drizzle types == core types").
 *
 * `Equal` is the strict conditional-type equality trick: it fails on any
 * missing/extra key, nullability difference, or widened member. If this file
 * typechecks, the schema and §6.0-derived core types agree exactly.
 */
import type {
  AutomationRule,
  BlockerRule,
  CommandLogEntry,
  ComputedAggregate,
  DecisionBoard,
  DecisionCriterion,
  DecisionScore,
  DiagramGroup,
  DiagramLayout,
  Edge,
  ExternalFact,
  Habit,
  HabitCompletion,
  JournalEntry,
  Node,
  ScheduleBlock,
  ScheduleSuggestionBatch,
  Sprint,
  SprintMembership,
  SyncReviewItem,
  Tag,
  TagAnswer,
  TagPlacement,
  TimeEntry,
  UserSettings,
} from '@prisms/core';

import type { schedule_suggestion_batches, sync_review_items, tables } from './schema';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

type Row<K extends keyof typeof tables> = (typeof tables)[K]['$inferSelect'];

export type AssertNodes = Assert<Equal<Row<'nodes'>, Node>>;
export type AssertEdges = Assert<Equal<Row<'edges'>, Edge>>;
export type AssertScheduleBlocks = Assert<Equal<Row<'schedule_blocks'>, ScheduleBlock>>;
export type AssertTimeEntries = Assert<Equal<Row<'time_entries'>, TimeEntry>>;
export type AssertHabits = Assert<Equal<Row<'habits'>, Habit>>;
export type AssertHabitCompletions = Assert<Equal<Row<'habit_completions'>, HabitCompletion>>;
export type AssertTags = Assert<Equal<Row<'tags'>, Tag>>;
export type AssertTagPlacements = Assert<Equal<Row<'tag_placements'>, TagPlacement>>;
export type AssertTagAnswers = Assert<Equal<Row<'tag_answers'>, TagAnswer>>;
export type AssertDecisionBoards = Assert<Equal<Row<'decision_boards'>, DecisionBoard>>;
export type AssertDecisionCriteria = Assert<Equal<Row<'decision_criteria'>, DecisionCriterion>>;
export type AssertDecisionScores = Assert<Equal<Row<'decision_scores'>, DecisionScore>>;
export type AssertSprints = Assert<Equal<Row<'sprints'>, Sprint>>;
export type AssertSprintMemberships = Assert<Equal<Row<'sprint_memberships'>, SprintMembership>>;
export type AssertAutomationRules = Assert<Equal<Row<'automation_rules'>, AutomationRule>>;
export type AssertBlockerRules = Assert<Equal<Row<'blocker_rules'>, BlockerRule>>;
export type AssertExternalFacts = Assert<Equal<Row<'external_facts'>, ExternalFact>>;
export type AssertComputedAggregates = Assert<Equal<Row<'computed_aggregates'>, ComputedAggregate>>;
export type AssertDiagramLayouts = Assert<Equal<Row<'diagram_layouts'>, DiagramLayout>>;
export type AssertDiagramGroups = Assert<Equal<Row<'diagram_groups'>, DiagramGroup>>;
export type AssertCommandLog = Assert<Equal<Row<'command_log'>, CommandLogEntry>>;
export type AssertUserSettings = Assert<Equal<Row<'user_settings'>, UserSettings>>;
export type AssertJournalEntries = Assert<Equal<Row<'journal_entries'>, JournalEntry>>;

// New 1.3 synced tables (not yet in the `tables` registry — M4 wires sync).
export type AssertSuggestionBatches = Assert<Equal<typeof schedule_suggestion_batches.$inferSelect, ScheduleSuggestionBatch>>;
export type AssertReviewItems = Assert<Equal<typeof sync_review_items.$inferSelect, SyncReviewItem>>;
