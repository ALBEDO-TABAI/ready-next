import type { ScopeRunState } from './types'
import type {
  ActiveChildRunSummaryData,
  TaskProjectionRecordData,
} from '../../types/electron'

/**
 * Task status vocabulary —— 集中各 UI 表面需要的 phase / projection-status / child-run 翻译。
 *
 * **硬约束**: 各 UI surface 的字面量保持现状，不允许统一文案。
 * - `taskCard` surface: 任务卡（ChatPanel 等），保留旧的"进行中 / 已完成 / 已停止"等中文
 * - `taskPanel` surface: TaskPanel 侧栏，保留旧的"执行工具 / 完成 / 已取消"等中文
 *
 * 任何文案变更必须分独立 commit，并由 1.2b 范围处理。
 */
export type LabelSurface = 'taskCard' | 'taskPanel'

/**
 * Stage 6 L5 contract: the single canonical Chinese label set used to render
 * task-card / task-panel agent status. The L5 gate (`scripts/check-status-vocabulary-single-source.cjs`)
 * imports this list (by parsing this file) and asserts no other agent-surface
 * file inlines any of these strings — every translation must go through the
 * helpers below.
 *
 * RSS / calendar / document-widget / settings strings are intentionally NOT
 * included; the gate is scoped to files that consume `ScopeRunState |
 * TaskProjectionRecordData | ActiveChildRunSummaryData | TaskCardRun` shapes.
 */
export const __GATE_CANONICAL_LABELS: ReadonlyArray<string> = Object.freeze([
  // phase / projection-status / step / interaction-state — task-card surface
  '排队中', '规划中', '规划', '执行工具', '检查点', '人工接管', '恢复中',
  '生成回复', '进行中', '等待继续', '等待补充', '待继续', '已完成', '完成',
  '失败', '已停止', '已取消', '待命', '待处理',
  // visual-state surface
  '预算已暂停', '后台运行中',
  // interaction-state extras (full-form)
  '等待确认', '人工接手', '已暂停', '执行中',
  // step-status extras
  '待执行',
  // badge surface (compact form)
  '等补充', '等确认',
])

/**
 * Stage O §1.4 / §3.5 — fallback placeholder used by
 * `activeChildRunDebugRow` when the persisted `task_projections` table
 * has not yet caught up with an active child run. The literal must live
 * here (single source) so the status-vocabulary gate can prevent
 * renderer files from inlining a status-flavored Chinese string. The
 * `(projection 暂未覆盖)` clause makes the user-visible state honest:
 * the UI is not pretending to know the task's current real state.
 */
export const DEBUG_PLACEHOLDER_TASK_SUMMARY = '后台任务（projection 暂未覆盖）'

export type TaskCardVisualState =
  | 'failed'
  | 'budget_paused'
  | 'background_running'
  | 'waiting_handoff'
  | 'waiting_input'
  | 'done'
  | 'running'

export function taskCardVisualStateLabel(state: TaskCardVisualState): string {
  switch (state) {
    case 'failed': return '失败'
    case 'budget_paused': return '预算已暂停'
    case 'background_running': return '后台运行中'
    case 'waiting_handoff': return '等待继续'
    case 'waiting_input': return '等待补充'
    case 'done': return '已完成'
    case 'running': return '进行中'
  }
}

export function interactionStateToUserLabel(
  interactionState: TaskProjectionRecordData['interactionState'] | undefined,
): string {
  switch (interactionState) {
    case 'awaiting_clarification':
      return '等待补充'
    case 'awaiting_confirmation':
      return '等待确认'
    case 'human_takeover':
      return '人工接手'
    case 'suspended':
      return '已暂停'
    case 'resuming':
      return '恢复中'
    case 'running':
      return '执行中'
    default:
      return '进行中'
  }
}

export function taskStepStatusToUserLabel(
  status: 'done' | 'running' | 'blocked' | 'error' | string | undefined,
): string {
  if (status === 'done') return '已完成'
  if (status === 'running') return '进行中'
  if (status === 'blocked') return '待继续'
  if (status === 'error') return '失败'
  return '待执行'
}

/**
 * Compact badge variant of {@link interactionStateToUserLabel} (3-character
 * labels for tight UI surfaces like ChatPanel's per-task badge). Stage 6 L5
 * keeps badge wording centralised so renderer files don't inline canonical
 * label strings.
 */
export function interactionStateToBadgeLabel(
  interactionState: TaskProjectionRecordData['interactionState'] | undefined,
): string {
  switch (interactionState) {
    case 'awaiting_clarification':
      return '等补充'
    case 'awaiting_confirmation':
      return '等确认'
    case 'human_takeover':
      return '人工接手'
    case 'suspended':
      return '已暂停'
    case 'resuming':
      return '恢复中'
    case 'running':
      return '执行中'
    default:
      return '进行中'
  }
}

export function phaseToUserLabel(
  phase: ScopeRunState['phase'] | undefined,
  surface: LabelSurface = 'taskCard',
): string {
  if (surface === 'taskPanel') {
    switch (phase) {
      case 'queued':
        return '排队中'
      case 'planning':
        return '规划'
      case 'tool_running':
        return '执行工具'
      case 'checkpoint':
        return '检查点'
      case 'takeover':
        return '人工接管'
      case 'resuming':
        return '恢复中'
      case 'responding':
        return '生成回复'
      case 'done':
        return '完成'
      case 'error':
        return '失败'
      case 'cancelled':
        return '已取消'
      default:
        return '待命'
    }
  }
  // 'taskCard' surface (default) — 复刻 taskCardViewModel.ts 现有 mapping。
  if (phase === 'planning') return '规划中'
  if (phase === 'tool_running' || phase === 'responding' || phase === 'resuming') return '进行中'
  if (phase === 'checkpoint' || phase === 'takeover') return '等待继续'
  if (phase === 'done') return '已完成'
  if (phase === 'error') return '失败'
  if (phase === 'cancelled') return '已停止'
  return '待处理'
}

export function projectionStatusToUserLabel(
  status: TaskProjectionRecordData['status'] | undefined,
  surface: LabelSurface = 'taskCard',
): string | null {
  if (surface === 'taskPanel') {
    switch (status) {
      case 'queued':
        return '排队中'
      case 'running':
        return '进行中'
      case 'recoverable_paused':
      case 'budget_paused':
      case 'blocked':
        return '待继续'
      case 'completed':
        return '已完成'
      case 'failed':
        return '失败'
      case 'killed':
        return '已取消'
      default:
        return '待命'
    }
  }
  // 'taskCard' surface (default) — 复刻 taskCardViewModel.ts 现有 mapping。
  if (status === 'queued') return '排队中'
  if (status === 'running') return '进行中'
  if (status === 'blocked' || status === 'recoverable_paused' || status === 'budget_paused') return '等待继续'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'killed') return '已停止'
  return null
}

export function childRunToProjectionStatus(
  row: ActiveChildRunSummaryData,
): TaskProjectionRecordData['status'] {
  if (row.closeStatus === 'completed' || row.status === 'completed') return 'completed'
  if (row.closeStatus === 'failed' || row.status === 'failed') return 'failed'
  if (row.closeStatus === 'killed' || row.status === 'killed') return 'killed'
  if (row.closeStatus === 'budget_paused' || row.status === 'budget_paused') return 'budget_paused'
  if (row.closeStatus === 'recoverable_paused' || row.status === 'recoverable_paused') return 'recoverable_paused'
  if (row.closeStatus === 'blocked' || row.status === 'blocked') return 'blocked'
  return 'running'
}

export function childRunToPhase(row: ActiveChildRunSummaryData): ScopeRunState['phase'] {
  if (row.closeStatus === 'completed' || row.status === 'completed') return 'done'
  if (row.closeStatus === 'failed' || row.status === 'failed') return 'error'
  if (row.closeStatus === 'killed' || row.status === 'killed') return 'cancelled'
  return 'checkpoint'
}

export function childRunToWaitingFor(
  row: ActiveChildRunSummaryData,
): ScopeRunState['waitingFor'] {
  const status = childRunToProjectionStatus(row)
  if (status === 'running') return 'background'
  if (status === 'blocked') return 'input'
  return 'none'
}

export function childRunToTaskActions(
  row: ActiveChildRunSummaryData,
): ScopeRunState['resumableActions'] {
  const status = childRunToProjectionStatus(row)
  if (status === 'completed') return ['open_artifact']
  if (status === 'failed') return ['retry', 'cancel', 'open_artifact']
  if (status === 'killed') return ['none']
  return ['continue', 'cancel', 'open_artifact']
}
