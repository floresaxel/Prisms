/**
 * @prisms/ui — shared React hooks (PowerSync reactive queries → core
 * selectors), the PowerSync data layer (schema, connector, command bridge),
 * and the base design system. Imports core; never imports server.
 */
export const UI_PACKAGE = '@prisms/ui' as const;

// data layer
export { appSchema, clientSchema, client_commands, overlay_effects, sync_review_items, LOCAL_ONLY_TABLE_NAMES } from './powersync/schema';
export {
  createConnector,
  startCommandUpload,
  type ConnectorOptions,
  type CommandRejection,
  type CommandUploadOptions,
  type WatchableDb,
} from './powersync/connector';
export { createCommands, type PrismsCommands, type CommandContext } from './powersync/commands';
export {
  newId,
  createHlc,
  getDeviceId,
  browserClock,
  browserRng,
  observeImportedHlc,
  persistImportedHlc,
  loadImportedHlcFloor,
  __resetHlcFloorForTests,
} from './powersync/client-runtime';

// portability + privacy adapters (1.3 §13.1/§13.2, R13/R20) — M13
export {
  type SecureStorage,
  createWebSecureStorage,
  createMemorySecureStorage,
} from './adapters/secure-storage';
export { type DbEncryptionAdapter, noopDbEncryption, createStaticDbEncryption } from './adapters/db-encryption';
export {
  encryptExport,
  decryptExport,
  isEncryptedExport,
  ENCRYPTED_EXPORT_FORMAT,
  ENCRYPTED_EXPORT_VERSION,
  type EncryptedExport,
} from './portability/crypto';
export {
  serializeExport,
  parseImportFile,
  exportFilename,
  ImportFormatError,
  type SerializeOptions,
  type ParseOptions,
} from './portability/export-import';
export {
  buildJournalArchive,
  journalDayFilename,
  journalArchiveFilename,
  type JournalExportEntry,
} from './portability/journal-md';
export {
  applyMarkdownEdit,
  truncatePlain,
  type Selection,
  type MarkdownAction,
  type MarkdownEdit,
} from './markdown';
export { projectTone, type DotTone } from './format';

// two-layer client store (1.3 §7.2, R15) — M0 spike
export {
  createSqlOverlayStore,
  readMergedRows,
  type OverlayStore,
  type PendingCommand,
  type SqlExecutor,
  type SqlTx,
  type ReviewItem,
  type AckEffect,
} from './powersync/overlay-store';
export { createExecuteCommand, type ExecuteCommand, type ExecuteContext, type ExecuteDeps, type ExecuteOptions } from './powersync/execute';
export { buildOptimisticEffects, buildAcceptSuggestionEffects, type EffectSpec, type OptimisticEffectCtx, type AcceptSuggestionBlock } from './powersync/effects';
export { uploadClientCommands, UploadClientError, MAX_UPLOAD_BATCH, type UploadCommandsOptions, type UploadSummary } from './powersync/upload-commands';

// persistent client read layer (1.4 §7.14, Fix A) — M11
export { PrismsDataProvider, usePrismsData, toOverlayEffect, type PrismsData, type SharedRows } from './powersync/data-provider';

// sync-stream tiers — lazy Tier 2 (1.3 §7.3) — M14; lazy journal months (D3) — J3
export {
  subscribeHistory,
  HISTORY_STREAM,
  createJournalMonthSubscriptions,
  JOURNAL_MONTH_STREAM,
  type StreamSubscriber,
  type StreamSubscription,
  type HistorySubscribeOptions,
  type JournalMonthSubscriptions,
  type JournalMonthOptions,
} from './powersync/streams';

// provenance ("why does this exist?", §7.8) — M9
export { explainProvenance, type ProvenanceFields, type ProvenanceExplanation } from './provenance';

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
  useReviewInbox,
  useTagCatalog,
  useBlockTags,
  useJournalMonths,
  useJournalDay,
  useTimeBlocksForDay,
  useTaskSteps,
  useTaskStepsByTask,
  useTasksByProject,
  useGroupedWorklist,
  useMyDayAvailable,
  useProjectPriorities,
  useDoneToday,
  useTodayItinerary,
  useBlockedTasks,
  useHabitTasks,
  // loading-aware read layer (1.4 §7.15, Fix C) — M12
  useIsHydrated,
  useHabitsHydrated,
  useDecisionsHydrated,
  useRulesHydrated,
  useReviewInboxHydrated,
  __resetReadCacheForTests,
  clearReadCaches,
  type RowsRead,
  type WorklistItem,
  type MyDayItem,
  type DoneTodayItem,
  type ProjectTasksGroup,
  type BlockedTask,
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
  type ReviewItemView,
  type JournalMonthsRead,
  type JournalDayRead,
  type TodayItinerary,
} from './hooks';
export { groupWorklistBySchedule, type WorklistGroup } from './worklist-grouping';
export {
  buildItinerary,
  loggedMinutesByTask,
  minutesOfDay,
  formatWallTime,
  type ItineraryRow,
  type ItineraryState,
} from './today-itinerary';

// design system
export { Layout, type LayoutProps, type NavItemSpec, type NavGroupSpec, type BreadcrumbSpec } from './components/Layout';
export { Ic, IconSprite, type IcProps, type IconName } from './components/icons';
export { List, ListItem, Skeleton, ListSkeleton, type ListProps, type ListItemProps, type SkeletonProps } from './components/List';
export { Modal, type ModalProps } from './components/Modal';
