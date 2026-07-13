export type ScheduleSpecV1 =
  | { kind: 'once'; localDate: string; localTime: string }
  | {
      kind: 'interval'
      every: number
      unit: 'minute' | 'hour' | 'day'
      anchorAt: string
    }
  | {
      kind: 'calendar'
      frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
      localTime: string
      weekdays?: number[]
      months?: number[]
      dayOfMonth?: number
      lastDayOfMonth?: boolean
      until?: string
      count?: number
    }

export type ScheduleMissedPolicy = 'coalesce_latest' | 'skip'

export type ScheduleTriggerSource = 'timer' | 'startup' | 'resume' | 'manual'

export interface ScheduledTaskOccurrenceSource {
  occurrenceId: string
  scheduleId: string
  scheduledFor: string
  triggerSource: ScheduleTriggerSource
}

export type ScheduleOccurrenceClaimStatus =
  | 'queued'
  | 'dispatching'
  | 'dispatched'
  | 'dispatch_failed'
  | 'skipped_missed'
  | 'skipped_coalesced'
  | 'blocked_target'

export type ScheduleBlockedReason =
  | 'blocked_scope_missing'
  | 'blocked_agent_unavailable'
  | 'blocked_workspace_unavailable'

export interface ScheduledTurnEnvelope {
  scheduleId: string
  occurrenceId: string
  scheduledFor: string
  triggeredAt: string
  triggerSource: ScheduleTriggerSource
  delayMs: number
  userRequestVerbatim: string
}

export type ScheduleMutationErrorKind =
  | 'invalid_request'
  | 'invalid_time'
  | 'target_missing'
  | 'conflict'
  | 'not_editable'
  | 'not_found'
  | 'internal_error'

export interface ScheduleMutationError {
  kind: ScheduleMutationErrorKind
  message: string
}

export type ScheduledTasksResponse<T> =
  | { success: true; data: T }
  | { success: false; error: ScheduleMutationError }

export interface AgentScheduleDefinition {
  id: string
  name: string
  instruction: string
  scheduleSpecVersion: 1
  scheduleSpec: ScheduleSpecV1
  timezone: string
  scopeId: string | null
  scopeMode: 'dedicated' | 'existing'
  agentId: string
  workspaceRoots: string[]
  enabled: boolean
  nextRunAt: string | null
  lastOccurrenceAt: string | null
  missedPolicy: ScheduleMissedPolicy
  blockedReason: ScheduleBlockedReason | null
  migrationState: 'needs_scope' | 'needs_schedule_review' | null
  createdAt: string
  updatedAt: string
}

export interface AgentScheduleOccurrence {
  id: string
  scheduleId: string
  scheduledFor: string
  triggeredAt: string
  triggerSource: ScheduleTriggerSource
  claimStatus: ScheduleOccurrenceClaimStatus
  attempt: number
  runId: string | null
  taskId: string | null
  delayMs: number
  startedAt: string | null
  finishedAt: string | null
  errorKind: string | null
  errorMessage: string | null
  runStatus?: string | null
  interactionState?: string | null
  runBlockedReason?: string | null
  createdAt: string
  updatedAt: string
}

export interface SchedulePreviewRequest {
  scheduleSpec: ScheduleSpecV1
  timezone: string
  count?: number
  from?: string
}

export interface SchedulePreview {
  occurrences: string[]
  nextRunAt: string | null
  blockedReason: ScheduleBlockedReason | null
}

interface ScheduleMutationFields {
  name: string
  instruction: string
  scheduleSpec: ScheduleSpecV1
  timezone: string
  agentId: string
  workspaceRoots: string[]
  enabled: boolean
  missedPolicy: ScheduleMissedPolicy
}

type ScheduleScopeMutation =
  | { scopeMode: 'dedicated'; scopeId?: never }
  | { scopeMode: 'existing'; scopeId: string }

export type ScheduleMutationRequest = ScheduleMutationFields & ScheduleScopeMutation
export type ScheduleCreateRequest = ScheduleMutationRequest
export type ScheduleUpdateRequest = ScheduleMutationRequest & { id: string }

export interface ScheduleIdRequest {
  id: string
}

export interface ScheduleOccurrencesRequest {
  scheduleId: string
  limit?: number
}

export type ScheduleChangedNotification = string | undefined

export interface ScheduledTasksAPI {
  list: () => Promise<ScheduledTasksResponse<AgentScheduleDefinition[]>>
  get: (id: string) => Promise<ScheduledTasksResponse<AgentScheduleDefinition>>
  preview: (request: SchedulePreviewRequest) => Promise<ScheduledTasksResponse<SchedulePreview>>
  create: (request: ScheduleCreateRequest) => Promise<ScheduledTasksResponse<AgentScheduleDefinition>>
  update: (request: ScheduleUpdateRequest) => Promise<ScheduledTasksResponse<AgentScheduleDefinition>>
  pause: (id: string) => Promise<ScheduledTasksResponse<AgentScheduleDefinition>>
  resume: (id: string) => Promise<ScheduledTasksResponse<AgentScheduleDefinition>>
  delete: (id: string) => Promise<ScheduledTasksResponse<{ id: string }>>
  runNow: (id: string) => Promise<ScheduledTasksResponse<AgentScheduleOccurrence>>
  listOccurrences: (
    scheduleId: string,
    limit?: number,
  ) => Promise<ScheduledTasksResponse<AgentScheduleOccurrence[]>>
  onChanged: (callback: (scheduleId?: string) => void) => () => void
}
