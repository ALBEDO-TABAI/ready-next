import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
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
  | 'system'

export type ToolKind = 'read' | 'write' | 'interactive' | 'job'
export type ToolConcurrency = 'parallel_read_safe' | 'serialized'
export type ToolInterruptBehavior = 'abort_signal' | 'host_managed'
export type ToolTimeoutProfile =
  | 'default'
  | 'browser_interactive'
  | 'document_write'
  | 'skill'
  | 'skill_long'
  | 'feishu'

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
  resultShape: ToolResultShape
}
