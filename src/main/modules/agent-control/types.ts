export type ChannelAdapterType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'

export type ConversationSourceKind = 'local' | 'channel'

export type AgentTaskState =
  | 'queued'
  | 'planning'
  | 'tool_running'
  | 'responding'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface ChannelAttachment {
  name: string
  url?: string
  path?: string
  mimeType?: string
  size?: number
  type?: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  ext?: string
  remoteId?: string
}

export interface ChannelEnvelope {
  id: string
  source: ChannelAdapterType | string
  thread: string
  sender: string
  text: string
  attachments: ChannelAttachment[]
  timestamp: string
  idempotencyKey: string
}

export interface AgentChannelConfig {
  id: string
  type: ChannelAdapterType
  name: string
  enabled: boolean
  config: Record<string, unknown>
  lastError?: string | null
  lastSeenAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface CronTask {
  id: string
  name: string
  cronExpr: string
  prompt: string
  channelId?: string | null
  enabled: boolean
  payload?: Record<string, unknown>
  lastRunAt?: string | null
  nextRunAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface HeartbeatComponentSnapshot {
  healthy: boolean
  lastBeatAt?: string
  error?: string
}

export interface HeartbeatSnapshot {
  sidecar: {
    status: 'starting' | 'running' | 'stopped' | 'error'
    pid?: number
    port?: number
    lastBeatAt?: string
    error?: string
  }
  adapters: Array<HeartbeatComponentSnapshot & {
    id: string
    type: ChannelAdapterType
    status?: 'starting' | 'running' | 'stopped' | 'error'
  }>
  orchestrator: HeartbeatComponentSnapshot & { activeTasks: number }
  toolGateway: HeartbeatComponentSnapshot & { availableTools: number }
}

export interface AgentRuntimeStatus {
  orchestrator: 'claude-sdk'
  sidecarEnabled: boolean
  sidecar: HeartbeatSnapshot['sidecar']
  channels: {
    total: number
    enabled: number
    connected: number
    errors: number
    byType: Record<string, number>
  }
  schedules: {
    total: number
    enabled: number
  }
  heartbeat: HeartbeatSnapshot
}

export interface ConversationScope {
  id: string
  agent: string
  userId?: string
  title: string
  sourceKind: ConversationSourceKind
  sourceId: string
  threadKey: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ConversationScopeMessage {
  id: string
  conversationId: string
  role: string
  content: string
  timestamp: string
  meta: Record<string, unknown>
}

export interface ConversationEventPayload {
  type: 'scope_created' | 'scope_updated' | 'message_added'
  scope: ConversationScope
  message?: ConversationScopeMessage
}

export interface ConversationAttachment {
  attachmentId: string
  scopeId: string
  sourceMessageId: string
  name: string
  path: string
  type: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  size: number
  ext: string
  url?: string | null
  mimeType?: string | null
  remoteId?: string | null
  channelId?: string | null
  threadKey?: string | null
  createdAt: string
}

export interface ScopeRunTraceItem {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: string
}

export interface ScopeRunMemoryRef {
  id: string
  layer: 'l0' | 'l1' | 'l2'
  title: string
  summary?: string | null
  path?: string | null
  triggerId?: string | null
  sensitive?: boolean
  loadedAt: string
}

export interface ScopeRunTriggerHit {
  id: string
  label: string
  module?: 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar' | 'feishu' | 'system'
  blocking: boolean
  refs: string[]
}

export interface ScopeRunContextBudget {
  totalChars: number
  l0Chars: number
  l1Chars: number
  l2Chars: number
  droppedRefs: string[]
}

export interface ScopeRunEventPayload {
  type: 'started' | 'updated' | 'finished'
  scopeId: string
  agent: string
  runId?: string
  phase: 'queued' | 'planning' | 'tool_running' | 'checkpoint' | 'takeover' | 'resuming' | 'responding' | 'done' | 'error' | 'cancelled'
  latestText?: string
  module?: 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar' | 'feishu' | 'system'
  intent?: string
  executionKind?: 'deterministic' | 'interactive' | 'job' | 'pipeline'
  jobId?: string
  artifactRefs?: Array<{
    id: string
    module: string
    kind: string
    label: string
    path?: string | null
    url?: string | null
    mimeType?: string | null
    sourceRunId?: string | null
    createdAt: string
    meta?: Record<string, unknown>
  }>
  memoryRefs?: ScopeRunMemoryRef[]
  triggerHits?: ScopeRunTriggerHit[]
  contextBudget?: ScopeRunContextBudget | null
  ownerResourceId?: string
  lastEvidenceAt?: string
  toolEvent?: ScopeRunTraceItem
  error?: string
  blockedReason?: string
  controllerId?: string
  ownerTabId?: string
  checkpointExpiresAt?: number
  stepMetrics?: {
    toolCalls: number
    toolResults: number
    lastToolAt: string | null
  }
  timestamp: string
}

export interface SidecarStatus {
  state: 'starting' | 'running' | 'stopped' | 'error'
  host: string
  port: number | null
  pid: number | null
  startedAt: string | null
  lastHeartbeatAt: string | null
  error: string | null
}
