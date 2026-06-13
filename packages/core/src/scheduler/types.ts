/**
 * Scheduler data model (ARCHITECTURE.md §10). One pure function, two callers:
 * the client runs `mode:'greedy'` for drag hints and single-task reschedule
 * (this session); the server runs `mode:'optimize'` for multi-week
 * re-optimization (TODO s09). All times are `Instant` (epoch ms); the caller
 * converts schedule_blocks ISO ↔ instants at the boundary.
 */
import type { EdgeType } from '../domain/entities';
import type { IsoDate, Uuid } from '../domain/primitives';
import type { Instant } from '../time/instant';

export type SchedulerMode = 'greedy' | 'optimize';

/**
 * A named time-of-day window (morning/day/evening/night, §10) in the user's
 * local wall time. `[startMinute, endMinute)` are minutes from local
 * midnight; endMinute may be 1440. Windows do not wrap midnight — a nightly
 * window spanning midnight is expressed as two windows.
 */
export interface NamedWindow {
  id: string;
  startMinute: number;
  endMinute: number;
}

/** A timing dependency on another task (§7.1 edge semantics, applied to placement). */
export interface SchedulerDependency {
  predecessorId: Uuid;
  edgeType: EdgeType;
  lagMinutes: number;
}

export interface SchedulableTask {
  id: Uuid;
  estimateMinutes: number;
  dueDate?: IsoDate | null;
  /** I8: a done task is never (re)scheduled — reported unplaceable 'done'. */
  done?: boolean;
  /** If non-empty, restrict placement to windows with these ids; else any window. */
  allowedWindowIds?: readonly string[];
  dependencies?: readonly SchedulerDependency[];
  /** Hard floor on the start instant (e.g. "not before now" for past-due reschedule). */
  notBefore?: Instant;
}

/** An existing schedule_block in the planning context. */
export interface CommittedBlock {
  id: Uuid;
  taskId: Uuid;
  startsAt: Instant;
  endsAt: Instant;
  /** anchor_type != 'none' (I7): immovable, always an obstacle even when its task is replanned. */
  anchored: boolean;
}

export interface BlockProposal {
  taskId: Uuid;
  startsAt: Instant;
  endsAt: Instant;
}

export type UnplaceableReason =
  | 'done' // I8: task already complete
  | 'no_estimate' // missing/zero estimate — cannot size a block
  | 'no_window_fits' // estimate longer than every allowed window, or none allowed
  | 'horizon_full' // a window type fits but no free occurrence before the horizon end
  | 'dependency_cycle' // task is part of a dependency cycle
  | 'dependency_unplaceable'; // a predecessor could not be placed

export interface Unplaceable {
  taskId: Uuid;
  reason: UnplaceableReason;
}

export interface SchedulerInput {
  tasks: readonly SchedulableTask[];
  committed: readonly CommittedBlock[];
  windows: readonly NamedWindow[];
  timezone: string;
  horizon: { from: Instant; to: Instant };
  mode: SchedulerMode;
}

export interface SchedulerOutput {
  proposals: BlockProposal[];
  unplaceable: Unplaceable[];
}

/** A concrete time interval (epoch ms). */
export interface Interval {
  start: number;
  end: number;
}
