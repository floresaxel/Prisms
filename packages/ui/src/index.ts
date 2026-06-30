/**
 * @prisms/ui — shared React hooks (PowerSync reactive queries → core
 * selectors), the PowerSync data layer (schema, connector, command bridge),
 * and the base design system. Imports core; never imports server.
 */
export const UI_PACKAGE = '@prisms/ui' as const;

// data layer
export { appSchema, clientSchema, client_commands, overlay_effects, sync_review_items, LOCAL_ONLY_TABLE_NAMES } from './powersync/schema';
export { createConnector, type ConnectorOptions, type CommandRejection } from './powersync/connector';
export { crudToCommand, type CrudLike, type CrudOp, type TranslatedCommand } from './powersync/crud-to-command';
export { createCommands, type Commands, type CommandContext, type WritableDb } from './powersync/commands';
export { newId, createHlc, getDeviceId, browserClock, browserRng } from './powersync/client-runtime';

// two-layer client store (1.3 §7.2, R15) — M0 spike
export {
  createSqlOverlayStore,
  readMergedRows,
  type OverlayStore,
  type SqlExecutor,
  type SqlTx,
  type ReviewItem,
} from './powersync/overlay-store';
export { createExecuteCommand, type ExecuteCommand, type ExecuteContext, type ExecuteDeps, type ExecuteOptions } from './powersync/execute';
export { buildOptimisticEffects, type EffectSpec, type OptimisticEffectCtx } from './powersync/effects';
export { uploadClientCommands, type UploadCommandsOptions, type UploadSummary } from './powersync/upload-commands';

// hooks
export {
  useNodeTree,
  useFactContext,
  useWorklist,
  useRunningTimer,
  useActivityInbox,
  usePromoteTargets,
  useDayTimeLeft,
  useNextBlockMinutes,
  useAgenda,
  useHabits,
  useKanban,
  useDecisionBoards,
  useDashboard,
  useFlowchart,
  useGantt,
  useRules,
  useBlockers,
  useUserSettings,
  useAggregates,
  useCommands,
  useTagCatalog,
  useBlockTags,
  useTimeBlocksForDay,
  useGroupedWorklist,
  useHabitTasks,
  type WorklistItem,
  type RunningTimer,
  type PromoteTarget,
  type Agenda,
  type AgendaBlock,
  type AgendaEntry,
  type TodoTask,
  type HabitView,
  type KanbanColumn,
  type DecisionBoardView,
  type DashboardData,
  type ProjectCompletion,
  type FlowNode,
  type FlowEdge,
  type FlowchartView,
  type GanttBar,
  type GanttView,
  type AggregateRow,
  type UserSettingsView,
  type BlockTagView,
  type TimeBlockOption,
  type HabitTasksView,
} from './hooks';
export { groupWorklistBySchedule, type WorklistGroup } from './worklist-grouping';

// design system
export { Layout, type LayoutProps, type NavLinkSpec } from './components/Layout';
export { List, ListItem, type ListProps, type ListItemProps } from './components/List';
export { Modal, type ModalProps } from './components/Modal';
