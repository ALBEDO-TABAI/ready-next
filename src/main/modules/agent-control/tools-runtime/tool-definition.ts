import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import type { ToolResultShape } from './tool-result-types'

export type ToolDomain =
  | 'browser'
  | 'document'
  | 'file'
  | 'rss'
  | 'calendar'
  | 'feishu'
  | 'skill'
  | 'memory'
  | 'session'
  | 'pet'
  | 'system'
  | 'general_research'
  | 'image_generation'
  | 'map'
  | 'mcp'
  | 'agent_interaction'
  | 'skill_install'
  | 'skill_activation'
  | 'channel'
  | 'mcp_install'
  | 'command_exec'

export type ToolKind = 'read' | 'write' | 'interactive' | 'job'
export type ToolConcurrency = 'parallel_read_safe' | 'serialized'
export type ToolInterruptBehavior = 'abort_signal' | 'host_managed'
export type ToolExecutionVisibility = 'model' | 'internal'
export type ToolTimeoutProfile =
  | 'default'
  | 'browser_interactive'
  | 'document_write'
  | 'skill'
  | 'skill_long'
  | 'feishu'
  | 'image_generation'
  | 'map'
  | 'command_exec'
  | 'user_interaction'

export interface ToolProjectionHint {
  mutating?: boolean
  // Consumers: DomainAdapter.applyResult should advance a projection step when a tool with
  // emitsProjectionPatch=true executes in a tool_batch (see DocumentDomainAdapter for the
  // document-domain implementation; SkillDomainAdapter consumes the same hint).
  emitsProjectionPatch?: boolean
}

export interface ToolDefinitionSchema {
  type: string
  properties?: Record<string, unknown>
  required?: string[]
  items?: unknown
  additionalProperties?: unknown
  [key: string]: unknown
}

export interface ToolDefinition {
  name: string
  groupId: CapabilityGroupId
  domain: ToolDomain
  kind: ToolKind
  concurrency: ToolConcurrency
  interruptBehavior: ToolInterruptBehavior
  timeoutProfile: ToolTimeoutProfile
  supportsTextBridge: boolean
  projectionHint: ToolProjectionHint | null
  description: string
  schema: ToolDefinitionSchema | null
  executionTimeoutMs?: number
  executionVisibility: ToolExecutionVisibility
  requiresExplicitAllowlist?: boolean
  /** Host-only admission bit. It is recomputed from live runtime state and is
   * intentionally excluded from the persisted/provider tool surface. */
  codexExecutionSafe?: boolean
  resultShape: ToolResultShape
}

export function isChildInternalStrictAdmissionEnabled(
  env: { [key: string]: string | undefined } = process.env as { [key: string]: string | undefined },
): boolean {
  const raw = env.READY_SKILL_CHILD_INTERNAL_STRICT_ADMISSION
  if (typeof raw !== 'string') return true
  const normalized = raw.trim().toLowerCase()
  return normalized !== '0' && normalized !== 'false' && normalized !== 'off'
}
