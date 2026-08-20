/**
 * Stage V — V1.1 ChatPanel pure helper extraction.
 *
 * Badge label + visibility helpers split out of `ChatPanel.tsx`.
 * Pure functions only — no React, no hooks, no IPC, no DOM.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md §2 V1.1
 */

import type {
  RecoveryRecordData,
  TaskProjectionRecordData,
} from '../../../../types/electron'
import type { TaskCardRun } from '../../task-card-from-projection'
import {
  hasTaskRunResumeIdentity,
  deriveTaskCardRuntimeState,
} from '../../../../modules/agent/taskCardViewModel'
import { interactionStateToBadgeLabel } from '../../../../modules/agent/task-status-vocabulary'
import { readBrowserConfirmationRequest } from '../../../../../shared/browser-confirmation-card'

export function taskTypeBadgeLabel(taskType: TaskCardRun['taskType'] | undefined): string {
  switch (taskType) {
    case 'direct_answer':
      return '直答'
    case 'short_task':
      return '短任务'
    case 'artifact_task':
      return '文件任务'
    case 'transaction_task':
      return '执行任务'
    case 'research_artifact_task':
      return '研究交付'
    case 'multi_step_task':
      return '多步任务'
    case 'media_task':
      return '媒体任务'
    case 'continuation':
      return '继续任务'
    default:
      return '任务'
  }
}

export function interactionStateBadgeLabel(
  interactionState: TaskCardRun['interactionState'] | undefined
): string {
  return interactionStateToBadgeLabel(interactionState)
}

export function recoveryBadgeLabel(recoveryHistory: RecoveryRecordData[]): string {
  const latest = recoveryHistory[recoveryHistory.length - 1]
  if (!latest) return '自动恢复'
  switch (latest.kind) {
    case 'rate_limit':
      return '限流恢复'
    case 'context_overflow':
      return '压缩恢复'
    case 'timeout_model':
      return '模型超时恢复'
    case 'timeout_tool':
      return '工具超时恢复'
    case 'auth':
      return '认证恢复'
    case 'transient':
      return '重试恢复'
    case 'host_unavailable':
      return '宿主降级'
    default:
      return '自动恢复'
  }
}

export function budgetWarningBadgeLabel(level: TaskProjectionRecordData['budgetWarningLevel']): string | null {
  switch (level) {
    case 'warning':
      return '预算预警'
    case 'converge':
      return '接近上限'
    case 'exhausted':
      return '预算耗尽'
    default:
      return null
  }
}

export function isTaskVisible(run: Omit<TaskCardRun, '__brand'> | null | undefined): boolean {
  if (!run) return false
  return Boolean(
    readBrowserConfirmationRequest(run.taskContinuation) ||
    run.taskTitle ||
    run.taskSummary ||
    run.progress ||
    (run.steps && run.steps.length > 0)
  )
}

export function isBackgroundTaskRun(run: TaskCardRun | null | undefined): boolean {
  if (!run) return false
  // Stage O §1.9 — both the visual state ("after-the-fact label") and
  // the foreground/background grouping ("which pile does this card go
  // into") share a single decision point: `deriveTaskCardRuntimeState`.
  // This deliberately treats `budget_paused` cards as background — they
  // are not actively waiting on the user — while their per-card visual
  // label stays the budget-paused canonical label (resolved via
  // `taskCardVisualStateLabel('budget_paused')` in the view-model).
  // The `childOrDetachedIdentity` clause keeps Stage 6 L6's
  // "child/detached resume identity → background pile until completion"
  // semantics so the foreground pile stays clean when the user spawns
  // a long-running skill task.
  const taskId = String(run.taskId || run.taskContinuation?.taskId || '').trim()
  const childOrDetachedIdentity = Boolean(
    run.taskContinuation?.childRunId ||
    run.taskContinuation?.detachedTaskId ||
    taskId.startsWith('skill-child:') ||
    taskId.startsWith('detached:'),
  )
  const visualState = deriveTaskCardRuntimeState(run).visualState
  const hasCollectionOutput = run.module === 'browser' && (run.recentArtifacts || []).some(
    (artifact) => artifact.kind === 'collection_output'
      || artifact.kind === 'collection_report'
      || artifact.kind === 'collection_manifest',
  )
  if (hasCollectionOutput) return true
  if (visualState === 'done') return false
  return (
    visualState === 'background_running'
    || visualState === 'budget_paused'
    || (childOrDetachedIdentity && hasTaskRunResumeIdentity(run))
  )
}
