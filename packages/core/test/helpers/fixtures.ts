/** Shared row builders for graph and status tests. */
import type {
  AutomationRule,
  AutomationTrigger,
  BlockerRule,
  Edge,
  ExternalFact,
  Habit,
  HabitCompletion,
  Node,
  NodeType,
  ScheduleBlock,
  Sprint,
  SprintMembership,
  TimeEntry,
} from '../../src/domain/entities';
import type { JsonValue, Uuid } from '../../src/domain/primitives';

export const TEST_USER: Uuid = '00000000-0000-7000-8000-0000000000aa';
const T0 = '2026-06-01T00:00:00.000Z';

/** Deterministic uuid with a readable numeric tail (tail order = id order). */
export function idOf(n: number): Uuid {
  return `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export function makeNode(
  overrides: Partial<Node> & { id: Uuid; node_type: NodeType },
): Node {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    parent_id: null,
    title: overrides.node_type,
    description: '',
    sort_order: 'a0',
    start_date: null,
    due_date: null,
    estimate_minutes: null,
    completed_at: null,
    completion_disposition: null,
    habit_id: null,
    attributes: {},
    ...overrides,
  };
}

export function makeEdge(
  overrides: Partial<Edge> & {
    id: Uuid;
    predecessor_id: Uuid;
    successor_id: Uuid;
  },
): Edge {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    edge_type: 'FS',
    lag_minutes: 0,
    ...overrides,
  };
}

export function makeEntry(
  overrides: Partial<TimeEntry> & { id: Uuid; task_id: Uuid; started_at: string },
): TimeEntry {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    ended_at: null,
    focus_factor: null,
    completed_session: null,
    planned: true,
    device_id: 'test-device',
    ...overrides,
  };
}

export function makeBlock(
  overrides: Partial<ScheduleBlock> & {
    id: Uuid;
    task_id: Uuid;
    starts_at: string;
    ends_at: string;
  },
): ScheduleBlock {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    anchor_type: 'none',
    rrule: null,
    status: 'committed',
    suggestion_reason: null,
    computed_at: null,
    external_event_id: null,
    ...overrides,
  };
}

export function makeSprint(
  overrides: Partial<Sprint> & { id: Uuid; starts_on: string; ends_on: string },
): Sprint {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    title: 'sprint',
    ...overrides,
  };
}

export function makeMembership(
  overrides: Partial<SprintMembership> & { id: Uuid; sprint_id: Uuid; node_id: Uuid },
): SprintMembership {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    ...overrides,
  };
}

export function makeBlockerRule(
  overrides: Partial<BlockerRule> & { id: Uuid; predicate: JsonValue },
): BlockerRule {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    scope: {},
    label: 'blocker',
    enabled: true,
    ...overrides,
  };
}

export function makeHabit(
  overrides: Partial<Habit> & { id: Uuid; vision_id: Uuid },
): Habit {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    title: 'habit',
    rrule: 'FREQ=DAILY',
    streak_mode: 'daily',
    daily_target_minutes: null,
    mastery_target_hours: null,
    level_thresholds_hours: [],
    ...overrides,
  };
}

export function makeHabitCompletion(
  overrides: Partial<HabitCompletion> & {
    id: Uuid;
    habit_id: Uuid;
    occurrence_date: string;
  },
): HabitCompletion {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    completed_at: `${overrides.occurrence_date}T12:00:00.000Z`,
    ...overrides,
  };
}

export function makeAutomationRule(
  overrides: Partial<AutomationRule> & {
    id: Uuid;
    trigger: AutomationTrigger;
    actions: JsonValue;
  },
): AutomationRule {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    conditions: { all: [] },
    enabled: true,
    ...overrides,
  };
}

export function makeWeatherFact(
  overrides: Partial<ExternalFact> & { id: Uuid; key: string; payload: JsonValue },
): ExternalFact {
  return {
    user_id: TEST_USER,
    created_at: T0,
    updated_at: T0,
    deleted_at: null,
    kind: 'weather_forecast',
    computed_at: T0,
    ...overrides,
  };
}
