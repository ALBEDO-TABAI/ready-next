export interface AgentMessage {
  id: string
  agent: string
  content: string
  type: 'user' | 'agent' | 'system'
  timestamp: Date
  attachments?: ChatAttachment[]
  meta?: Record<string, unknown>
}

export interface Agent {
  name: string
  displayName: string
  avatar: string
  status: 'idle' | 'working' | 'done' | 'error' | 'cancelled'
  selected: boolean
}

export interface ChatAttachment {
  id: string
  name: string
  path: string
  type: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  size: number
  ext: string
  source?: 'file' | 'browser-tab' | 'skill-folder' | 'channel'
  browserTabId?: string
  url?: string
  title?: string
  heading?: string
  selection?: string
  excerpt?: string
  capturedAt?: number
  skillId?: string
  skillFolderPath?: string
}

export interface ChatConversation {
  id: string
  agent: string
  title: string
  created_at: string
  updated_at: string
}

export interface ConversationScope {
  id: string
  agent: string
  title: string
  sourceKind: 'local' | 'channel'
  sourceId: string
  threadKey: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ToolTraceEvent {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: Date
}

export type AgentModuleKind = 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar' | 'feishu' | 'system'
export type ModuleExecutionKind = 'deterministic' | 'interactive' | 'job' | 'pipeline'
export type AgentMemoryLayer = 'l0' | 'l1' | 'l2'

export interface AgentMemoryRef {
  id: string
  layer: AgentMemoryLayer
  title: string
  summary?: string | null
  path?: string | null
  triggerId?: string | null
  sensitive?: boolean
  loadedAt: string
}

export interface AgentTriggerHit {
  id: string
  label: string
  module?: AgentModuleKind | null
  blocking: boolean
  refs: string[]
}

export interface AgentContextBudget {
  totalChars: number
  l0Chars: number
  l1Chars: number
  l2Chars: number
  droppedRefs: string[]
}

export interface AgentArtifact {
  id: string
  module: AgentModuleKind
  kind: string
  label: string
  path?: string | null
  url?: string | null
  mimeType?: string | null
  sourceRunId?: string | null
  createdAt: string
  meta?: Record<string, unknown>
}

export interface ScopeRunStepMetrics {
  toolCalls: number
  toolResults: number
  lastToolAt: string | null
}

export interface ScopeRunState {
  scopeId: string
  agent: string
  requestId: string | null
  phase: 'idle' | 'queued' | 'planning' | 'tool_running' | 'checkpoint' | 'takeover' | 'resuming' | 'responding' | 'done' | 'error' | 'cancelled'
  toolTrace: ToolTraceEvent[]
  startedAt: string | null
  updatedAt: string | null
  latestText?: string | null
  module?: AgentModuleKind | null
  intent?: string | null
  executionKind?: ModuleExecutionKind | null
  jobId?: string | null
  artifactRefs?: AgentArtifact[]
  memoryRefs?: AgentMemoryRef[]
  triggerHits?: AgentTriggerHit[]
  contextBudget?: AgentContextBudget | null
  ownerResourceId?: string | null
  lastEvidenceAt?: string | null
  blockedReason?: string | null
  controllerId?: string | null
  ownerTabId?: string | null
  checkpointExpiresAt?: number | null
  responseMessageId?: string | null
  responseBuffer?: string
  stepMetrics?: ScopeRunStepMetrics
  error?: string | null
}

export interface AttachmentPreviewState {
  attachment: ChatAttachment
  mode: 'image' | 'video' | 'text' | 'file'
  content?: string
  error?: string | null
}
