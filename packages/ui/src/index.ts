/**
 * @prisms/ui — shared React hooks (PowerSync reactive queries → core
 * selectors), the PowerSync data layer (schema, connector, command bridge),
 * and the base design system. Imports core; never imports server.
 */
export const UI_PACKAGE = '@prisms/ui' as const;

// data layer
export { appSchema } from './powersync/schema';
export { createConnector, type ConnectorOptions, type CommandRejection } from './powersync/connector';
export { crudToCommand, type CrudLike, type CrudOp, type TranslatedCommand } from './powersync/crud-to-command';
export { createCommands, type Commands, type CommandContext, type WritableDb } from './powersync/commands';
export { newId, createHlc, getDeviceId, browserClock, browserRng } from './powersync/client-runtime';

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
