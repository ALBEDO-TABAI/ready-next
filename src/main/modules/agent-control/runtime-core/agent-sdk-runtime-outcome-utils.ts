import {} from '../compaction/compact-agent-input'
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
import {
  isCompletedChildCloseStatus,
  isFailedChildCloseStatus,
  isKilledChildCloseStatus,
  type SkillChildCloseEvent
} from '../skills/skill-child-run-types'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type { SdkLongSkillCheckpoint } from './agent-sdk-types'
import type { TurnTerminalReason } from './turn-frame'

import { asRecord, stringField } from './agent-sdk-model-message-utils'
import {
  readStructuredResultRecord,
  terminalFailureReasonFromToolFailure
} from './agent-sdk-provider-utils'

// ── Group I: Projection & terminal helpers (lines 2390-3002) ──

export function buildTerminalFailureProjectionPatch(
  toolName: string,
  structuredData: Record<string, unknown>
): Record<string, unknown> {
  const errorKind = typeof structuredData.errorKind === 'string' ? structuredData.errorKind : null
  const errorCode = typeof structuredData.errorCode === 'string' ? structuredData.errorCode : null
  const terminalFailureReason = terminalFailureReasonFromToolFailure(toolName, structuredData)
  return {
    ...(terminalFailureReason ? { terminalFailureReason } : {}),
    terminalFailureTool: toolName,
    ...(errorKind ? { terminalFailureErrorKind: errorKind } : {}),
    ...(errorCode ? { terminalFailureErrorCode: errorCode } : {})
  }
}

export function readTextField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

const LOCAL_DOCUMENT_SOURCE_READ_TOOL_NAMES = new Set([
  'file_read_excerpt',
  'document_read_section'
])

export function isLocalDocumentSourceReadTool(toolName: string): boolean {
  return LOCAL_DOCUMENT_SOURCE_READ_TOOL_NAMES.has(toolName)
}

export function isLocalDocumentSourceReadFailure(toolName: string, text: string): boolean {
  if (!isLocalDocumentSourceReadTool(toolName)) return false
  const normalized = String(text || '').trim()
  if (!normalized) return false
  return (
    /^(?:Error:|Document action failed:)/i.test(normalized) ||
    /(?:ok["']?\s*:\s*false|未找到章节|没有可读取|无法读取|读取失败|不在当前工作区|工作区索引|not in index|outside any known workspace|path_missing|not found|找不到|未找到)/i.test(
      normalized
    )
  )
}

export function buildFileReadExcerptCheckpoint(output: ToolExecutionOutput): string | null {
  const normalized = normalizeToolExecutionOutput(output)
  const data = readStructuredResultRecord(normalized)
  if (data.ok === false) return null
  const content = readTextField(data, 'content')
  if (!content) return null
  const path = readTextField(data, 'path')
  const excerpt = content.length > 1600 ? `${content.slice(0, 1600).trimEnd()}...` : content
  return [
    '我已经读到相关文件，但模型在工具轮次内没有收口；先把已读到的关键片段给你，避免变成发送失败。',
    path ? `文件：${path}` : '',
    '',
    excerpt
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function mapToolFailureClose(
  results: Array<{
    id: string
    name: string
    args: Record<string, unknown>
    result: ToolExecutionOutput
  }>
): import('./agent-sdk-types').MapToolFailureClose | null {
  for (const item of [...results].reverse()) {
    if (item.name !== 'map_plan_route') continue
    const normalized = normalizeToolExecutionOutput(item.result)
    const data = readStructuredResultRecord(normalized)
    if (data.ok !== false && typeof data.errorKind !== 'string') return null
    const message =
      typeof data.message === 'string' && data.message.trim()
        ? data.message.trim()
        : normalized.text || '地图规划没有完成。'
    if (data.errorKind === 'place_ambiguous') {
      return {
        message,
        status: 'checkpoint',
        terminalReason: 'checkpoint_user_input',
        success: true
      }
    }
    return {
      message,
      status: 'error',
      terminalReason: 'blocked_tool_error',
      success: false
    }
  }
  return null
}

export function resolveToolFailurePageUrl(
  controller:
    | {
        getTabList?: () => Array<{ id: string; url: string }> | undefined
        getActiveTab?: () => { url: string } | undefined
      }
    | null
    | undefined,
  args: Record<string, unknown> | undefined
): string | null {
  if (!controller) return null
  try {
    const targetedTabId = typeof args?.tab_id === 'string' ? args.tab_id : null
    if (targetedTabId) {
      return controller.getTabList?.()?.find((tab) => tab.id === targetedTabId)?.url ?? null
    }
    return controller.getActiveTab?.()?.url ?? null
  } catch {
    // silent-catch: missing browser state only removes optional page attribution.
    return null
  }
}

export function projectionPatchFromChildClose(
  close: SkillChildCloseEvent | null
): Record<string, unknown> | null {
  const existing = asRecord(close?.projectionPatch)
  if (!close) return existing ? { ...existing } : null
  const handle: Record<string, unknown> = {}
  if (close.runStatePath) handle.runStatePath = close.runStatePath
  if (close.outputDir) handle.outputDir = close.outputDir
  if (close.deliveryReportPath) handle.deliveryReportPath = close.deliveryReportPath
  if (close.sceneScoresPath) handle.sceneScoresPath = close.sceneScoresPath
  const synthesized = Object.keys(handle).length > 0 ? { continuationRef: handle } : {}
  const merged = { ...synthesized, ...(existing ?? {}) }
  return Object.keys(merged).length > 0 ? merged : null
}

function turnTerminalReasonFromChildClose(close: SkillChildCloseEvent): TurnTerminalReason {
  if (isCompletedChildCloseStatus(close.status)) return 'done'
  if (isKilledChildCloseStatus(close.status)) return 'cancelled_user'
  switch (close.terminalReason) {
    case 'checkpoint_budget':
      return 'checkpoint_budget'
    case 'checkpoint_background':
    case 'queued_global_concurrency':
    case 'launch_stuck':
      return 'checkpoint_background'
    case 'blocked_config':
      return 'blocked_config'
    case 'blocked_external':
      return 'blocked_external'
    case 'cancelled_user':
      return 'cancelled_user'
    case 'failed_skill':
    case 'child_process_crashed':
    case 'host_unavailable':
    case 'nested_child_run_not_supported':
      return 'failed_skill'
    case 'resume_launch_failed':
      return 'resume_launch_failed'
    case 'persistence_failed':
      return 'persistence_failed'
    case TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code:
    case 'input_validation':
      return 'blocked_tool_error'
    case 'process_restarted':
      return 'checkpoint_background'
    case 'completed':
      return 'done'
    default:
      return 'checkpoint_user_input'
  }
}

export function sdkStatusFromTerminalReason(
  reason: TurnTerminalReason,
  success = true
): 'done' | 'error' | 'cancelled' | 'checkpoint' {
  if (reason === 'done') return 'done'
  if (reason === 'adjudication_degraded') return success ? 'done' : 'error'
  if (
    reason === 'cancelled_user' ||
    reason === 'cancelled_runtime' ||
    reason === 'main_no_progress_timeout'
  )
    return 'cancelled'
  if (
    reason === 'failed_skill' ||
    reason === 'resume_launch_failed' ||
    reason === 'persistence_failed' ||
    reason === 'blocked_tool_error' ||
    reason === 'browser_transaction_unconfirmed' ||
    reason === 'delivery_failed' ||
    reason === 'tool_unavailable' ||
    reason === 'no_artifact' ||
    reason === 'proof_gap'
  ) {
    return 'error'
  }
  return 'checkpoint'
}

export function isCheckpointTerminalReason(reason: TurnTerminalReason): boolean {
  return (
    reason === 'checkpoint_budget' ||
    reason === 'checkpoint_background' ||
    reason === 'checkpoint_user_input' ||
    reason === 'checkpoint_steered' ||
    reason === 'manual_suspend'
  )
}

export function summarizeChildResume(
  childRunId: string,
  close: SkillChildCloseEvent | null
): {
  message: string
  terminalReason: TurnTerminalReason
  status: 'done' | 'error' | 'cancelled' | 'checkpoint'
} {
  if (!close) {
    return {
      message: `已继续技能任务 ${childRunId}，后台仍在运行。`,
      terminalReason: 'checkpoint_background',
      status: 'checkpoint'
    }
  }
  if (isCompletedChildCloseStatus(close.status)) {
    return {
      message: `技能任务 ${childRunId} 已完成。`,
      terminalReason: 'done',
      status: 'done'
    }
  }
  if (isKilledChildCloseStatus(close.status)) {
    return {
      message: `技能任务 ${childRunId} 已取消。`,
      terminalReason: 'cancelled_user',
      status: 'cancelled'
    }
  }
  const terminalReason = turnTerminalReasonFromChildClose(close)
  const detail = close.error?.message || close.terminalReason
  return {
    message: isFailedChildCloseStatus(close.status)
      ? `继续技能任务 ${childRunId} 失败：${detail}`
      : `技能任务 ${childRunId} 仍在等待：${detail}`,
    terminalReason,
    status: sdkStatusFromTerminalReason(terminalReason, isCompletedChildCloseStatus(close.status))
  }
}

function isChildSkillEnvelopeStatus(status: string | null): boolean {
  return (
    status === 'child_launched' ||
    status === 'child_reused' ||
    status === 'child_paused' ||
    status === 'child_terminal'
  )
}

export function shouldRecoverLongSkillCheckpoint(
  checkpoint: SdkLongSkillCheckpoint | null
): checkpoint is SdkLongSkillCheckpoint {
  if (!checkpoint) return false
  if (
    checkpoint.terminalReason === 'blocked_config' ||
    checkpoint.terminalReason === 'failed_skill'
  )
    return false
  return Boolean(checkpoint.childRunId || checkpoint.outputDir || checkpoint.runStatePath)
}

export function summarizeLongSkillCheckpoint(checkpoint: SdkLongSkillCheckpoint): string {
  const output = checkpoint.outputDir
    ? `输出目录：${checkpoint.outputDir}`
    : checkpoint.runStatePath
      ? `run_state：${checkpoint.runStatePath}`
      : checkpoint.childRunId
        ? `子任务：${checkpoint.childRunId}`
        : ''
  const action = checkpoint.action || checkpoint.toolName
  return [
    `技能任务已启动并进入后台/暂停状态（${action}）。`,
    output,
    '可以从任务卡继续、取消或查看产物。'
  ]
    .filter(Boolean)
    .join('\n')
}

export function continuationHandleFromLongSkillCheckpoint(
  checkpoint: SdkLongSkillCheckpoint
): string | null {
  return checkpoint.runStatePath || checkpoint.outputDir || checkpoint.childRunId || null
}

export function extractLongSkillCheckpoint(
  toolName: string,
  output: ToolExecutionOutput,
  previous: SdkLongSkillCheckpoint | null
): SdkLongSkillCheckpoint | null {
  const normalized = normalizeToolExecutionOutput(output)
  const data = normalized.data
  const status = stringField(data, 'status')
  if (!toolName.startsWith('skill_') || !isChildSkillEnvelopeStatus(status)) return previous

  const closeEvent = asRecord(data?.closeEvent)
  const closeReason = stringField(closeEvent, 'terminalReason')
  const terminalReason: TurnTerminalReason =
    closeReason === 'blocked_config'
      ? 'blocked_config'
      : closeReason === 'failed_skill'
        ? 'failed_skill'
        : closeReason === 'checkpoint_budget'
          ? 'checkpoint_budget'
          : 'checkpoint_background'
  const next: SdkLongSkillCheckpoint = {
    toolName,
    skillId: stringField(data, 'skillId'),
    action: stringField(data, 'action'),
    childRunId: stringField(data, 'childRunId'),
    outputDir: stringField(data, 'outputDir'),
    runStatePath: stringField(data, 'runStatePath'),
    terminalReason
  }
  if (!previous) return next
  if ((next.outputDir || next.runStatePath) && !(previous.outputDir || previous.runStatePath))
    return next
  return previous
}
