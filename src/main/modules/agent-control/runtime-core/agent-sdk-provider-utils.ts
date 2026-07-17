import { type RunStreamEvent, type ToolCallOutputContent } from '@openai/agents'
import {
  getProviderDef,
  type AIModelConfig,
  type AIModelDef
} from '../../../../shared/ai-providers'
import {} from '../compaction/compact-agent-input'
import { TOOL_ADMISSION_ERROR_KINDS } from '../contracts/error-kinds'
import {
  buildModelVisibleToolResultPayload,
  redactModelVisibleToolText
} from '../tools-runtime/model-visible-tool-output'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type { TerminalFailureReason } from './agent-sdk-types'

// ── Group H: Provider resolution helpers (lines 2124-2388) ──

export function resolveConfiguredModelDef(
  config: AIModelConfig,
  baseUrl?: string
): AIModelDef | null {
  const providerDef = getProviderDef(
    config.provider,
    String(baseUrl || config.baseUrl || '').trim()
  )
  return providerDef?.models.find((modelDef) => modelDef.id === config.model) || null
}

export function extractToolCallFromStreamEvent(event: RunStreamEvent): {
  name: string
  args: Record<string, unknown>
} | null {
  if (event.type !== 'run_item_stream_event' || event.name !== 'tool_called') return null
  const rawItem = (event.item as { rawItem?: unknown }).rawItem
  if (!rawItem || typeof rawItem !== 'object') return null
  const record = rawItem as { type?: unknown; name?: unknown; arguments?: unknown }
  if (record.type !== 'function_call' || typeof record.name !== 'string') return null
  if (typeof record.arguments !== 'string') {
    return { name: record.name, args: {} }
  }
  try {
    const parsed = JSON.parse(record.arguments) as unknown
    return {
      name: record.name,
      args:
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
    }
  } catch {
    // silent-catch: unparseable tool arguments degrade to empty args, same as the non-string branch above
    return { name: record.name, args: {} }
  }
}

export function stringifyModelVisibleFunctionResult(output: unknown): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output || '')
  return redactModelVisibleToolText(text)
}

export function stringifyToolResult(output: ToolExecutionOutput): string {
  return JSON.stringify(buildModelVisibleToolResultPayload(output))
}

export function toAgentSdkToolResult(output: ToolExecutionOutput): string | ToolCallOutputContent[] {
  const normalized = normalizeToolExecutionOutput(output)
  if (!normalized.content?.length) return stringifyToolResult(normalized)
  const content: ToolCallOutputContent[] = []
  if (normalized.text) {
    content.push({ type: 'text', text: redactModelVisibleToolText(normalized.text) })
  }
  for (const part of normalized.content) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: redactModelVisibleToolText(part.text) })
    } else if (part.type === 'image') {
      content.push({
        type: 'image',
        image: { data: part.data, mediaType: part.mediaType },
        detail: part.detail || 'auto',
      })
    } else {
      content.push({ type: 'file', file: part.path })
    }
  }
  return content
}

export function readStructuredResultRecord(output: ToolExecutionOutput): Record<string, unknown> {
  const normalized = normalizeToolExecutionOutput(output)
  if (normalized.data && typeof normalized.data === 'object' && !Array.isArray(normalized.data)) {
    return normalized.data as Record<string, unknown>
  }
  if (normalized.text) {
    try {
      const parsed = JSON.parse(normalized.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // silent-catch: malformed optional tool text degrades to an empty object.
      return {}
    }
  }
  return {}
}

export const RECOVERABLE_SKILL_PATH_ERROR_KINDS = new Set([
  'absolute_path',
  'path_escape',
  'home_path',
  'empty_path',
  'no_root_match'
])

export const SKILL_ARTIFACT_TOOLS = new Set([
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact'
])

function isRelativePathInputValidationFailure(
  toolName: string,
  structuredData: Record<string, unknown>
): boolean {
  if (!SKILL_ARTIFACT_TOOLS.has(toolName)) return false
  if (structuredData.errorKind !== 'input_validation') return false
  const issues = Array.isArray(structuredData.issues) ? structuredData.issues : []
  return issues.some((issue) => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return false
    const path = (issue as { path?: unknown }).path
    return Array.isArray(path) && path.map((segment) => String(segment)).includes('relativePath')
  })
}

function isRecoverableSkillPathFailure(
  toolName: string,
  structuredData: Record<string, unknown>,
  errorKind: string
): boolean {
  if (!toolName.startsWith('skill_')) return false
  return (
    RECOVERABLE_SKILL_PATH_ERROR_KINDS.has(errorKind) ||
    isRelativePathInputValidationFailure(toolName, structuredData)
  )
}

export function terminalFailureReasonFromToolFailure(
  toolName: string,
  structuredData: Record<string, unknown>
): TerminalFailureReason | null {
  const errorKind =
    typeof structuredData.errorKind === 'string' ? structuredData.errorKind.trim() : ''
  if (isRecoverableSkillPathFailure(toolName, structuredData, errorKind)) return null
  if (errorKind === 'send_failed' || errorKind === 'blocked_external') return 'delivery_failed'
  if (
    errorKind === 'sidecar_unavailable' ||
    errorKind === 'channel_not_ready' ||
    errorKind === TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code ||
    errorKind === TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code ||
    errorKind === TOOL_ADMISSION_ERROR_KINDS.authorizationDenied.code
  ) {
    return 'tool_unavailable'
  }
  if (
    errorKind === 'file_not_found' ||
    errorKind === 'file_ambiguous' ||
    errorKind === 'directory_not_supported' ||
    errorKind === 'path_missing'
  ) {
    return 'no_artifact'
  }
  if (toolName === 'skill_send_im_file' && errorKind) return 'delivery_failed'
  // An arbitrary tool failure is not itself a terminal verdict. Optional reads
  // may fail before another tool supplies valid proof; the final adjudicator
  // owns the decision when no explicit terminal category applies.
  return null
}
