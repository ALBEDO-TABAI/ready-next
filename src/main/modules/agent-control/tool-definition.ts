import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import type { ToolResultShape } from './tool-result-types'

export type ToolDomain =
  | 'browser'
  | 'document'
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
  | 'feishu'

export interface ToolDefinition {
  name: string
  groupId: CapabilityGroupId
  domain: ToolDomain
  kind: ToolKind
  concurrency: ToolConcurrency
  interruptBehavior: ToolInterruptBehavior
  timeoutProfile: ToolTimeoutProfile
  resultShape: ToolResultShape
}
