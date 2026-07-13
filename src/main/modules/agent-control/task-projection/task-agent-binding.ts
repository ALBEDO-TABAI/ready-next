import type {
  RunExecutionOrigin,
  TaskCreationOrigin,
  TaskExecutionBinding,
} from '../../../../shared/agent-execution-profile'

export interface ResolveTaskOwnerInput {
  taskOrigin: TaskCreationOrigin
  conversationActiveAgentId?: string | null
  continuationOwnerAgentId?: string | null
  parentOwnerAgentId?: string | null
}

export interface ResolvedTaskOwner {
  ownerAgentId: string | null
  source: TaskExecutionBinding['ownerAssignmentSource'] | 'legacy'
}

export function resolveTaskOwner(input: ResolveTaskOwnerInput): ResolvedTaskOwner {
  if (input.continuationOwnerAgentId) {
    return { ownerAgentId: input.continuationOwnerAgentId, source: 'continuation' }
  }
  if (input.taskOrigin === 'workflow_child') {
    if (!input.parentOwnerAgentId) {
      throw new Error('[task-agent-binding] workflow_child requires parent owner')
    }
    return { ownerAgentId: input.parentOwnerAgentId, source: 'parent_task' }
  }
  if (input.taskOrigin === 'user_root') {
    if (!input.conversationActiveAgentId) {
      throw new Error('[task-agent-binding] user_root requires conversation active agent')
    }
    return { ownerAgentId: input.conversationActiveAgentId, source: 'conversation_active' }
  }
  return { ownerAgentId: null, source: 'legacy' }
}

export function assertTaskExecutionBinding(binding: TaskExecutionBinding): TaskExecutionBinding {
  if (!binding || typeof binding !== 'object' || binding.schemaVersion !== 1 || !binding.runId || !binding.ownerAgentIdAtStart || !binding.executionMaterialHash) {
    throw new Error('[task-agent-binding] incomplete execution binding')
  }
  if (binding.kind === 'registered_agent') {
    if (!binding.requestedAgentId || !binding.effectiveAgentId || binding.ephemeralRole) {
      throw new Error('[task-agent-binding] invalid registered-agent binding')
    }
  } else if (!binding.ephemeralRole || binding.requestedAgentId || binding.effectiveAgentId) {
    throw new Error('[task-agent-binding] invalid ephemeral binding')
  }
  return binding
}

export function runOriginForRequest(input: {
  isHandoffTakeover?: boolean
  isContinuation?: boolean
  isWorkflowParticipant?: boolean
  isScheduledTask?: boolean
}): RunExecutionOrigin {
  if (input.isHandoffTakeover) return 'handoff_takeover'
  if (input.isWorkflowParticipant) return 'workflow_participant'
  if (input.isScheduledTask) return 'scheduled_task'
  if (input.isContinuation) return 'continuation'
  return 'initial'
}
