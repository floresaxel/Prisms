/** Shared row builders for graph tests. */
import type { Edge, Node, NodeType } from '../../src/domain/entities';
import type { Uuid } from '../../src/domain/primitives';

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
