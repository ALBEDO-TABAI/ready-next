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
      case 'blocked':
        return '待继续'
      case 'done':
        return '已完成'
      case 'failed':
        return '失败'
      case 'cancelled':
        return '已取消'
      default:
        return '待命'
    }
  }
  // 'taskCard' surface (default) — 复刻 taskCardViewModel.ts 现有 mapping。
  if (status === 'queued') return '排队中'
  if (status === 'running') return '进行中'
  if (status === 'blocked') return '等待继续'
  if (status === 'done') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已停止'
  return null
}

export function childRunToProjectionStatus(
  row: ActiveChildRunSummaryData,
): TaskProjectionRecordData['status'] {
  if (row.closeStatus === 'completed' || row.status === 'completed') return 'done'
  if (row.closeStatus === 'failed' || row.status === 'failed') return 'failed'
  if (row.closeStatus === 'killed' || row.status === 'killed') return 'cancelled'
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
  if (status === 'done') return ['open_artifact']
  if (status === 'failed') return ['retry', 'cancel', 'open_artifact']
  if (status === 'cancelled') return ['none']
  return ['continue', 'cancel', 'open_artifact']
}
