export function commitSameSessionHandoff(deps: {
  getTask: (taskId: string) => { scopeId: string; runId: string | null } | null
  getConversation: (scopeId: string) => { agent: string; handoffGeneration: number } | null
  begin: () => void
  commit: () => void
  rollback: () => void
  updateTask: (taskId: string, patch: Record<string, unknown>) => void
  updateConversation: (scopeId: string, activeAgentId: string, handoffGeneration: number) => void
  onCommitted: (sessionAgentId: string, scopeId: string) => void
}, input: {
  taskId: string
  scopeId: string
  targetAgentId: string
  userRequestVerbatim: string
  contextRefs: string[]
}): { handoffGeneration: number } {
  const task = deps.getTask(input.taskId)
  if (!task || task.scopeId !== input.scopeId) {
    throw new Error('[handoff] task does not belong to scope')
  }
  const conversation = deps.getConversation(input.scopeId)
  if (!conversation) throw new Error('[handoff] conversation not found')
  const handoffGeneration = conversation.handoffGeneration + 1
  const continuationRef = {
    kind: 'handoff_takeover', taskId: input.taskId, priorRunId: task.runId,
    targetAgentId: input.targetAgentId, handoffGeneration,
    userRequestVerbatim: input.userRequestVerbatim, contextRefIds: input.contextRefs,
    consumed: false,
  }
  deps.begin()
  try {
    deps.updateTask(input.taskId, {
      ownerAgentId: input.targetAgentId,
      continuationRef,
      status: 'recoverable_paused',
      interactionState: 'suspended',
      waitingFor: 'background',
      blockedReason: null,
      updatedAt: new Date().toISOString(),
    })
    deps.updateConversation(input.scopeId, input.targetAgentId, handoffGeneration)
    deps.commit()
  } catch (error) {
    deps.rollback()
    throw error
  }
  deps.onCommitted(conversation.agent, input.scopeId)
  return { handoffGeneration }
}
