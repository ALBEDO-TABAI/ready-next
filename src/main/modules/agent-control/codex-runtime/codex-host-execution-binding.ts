import type { TaskExecutionBinding } from '../../../../shared/agent-execution-profile'

export function createCodexHostExecutionBinding(input: {
  runId: string
  ownerAgentIdAtStart: string
}): TaskExecutionBinding {
  return {
    schemaVersion: 1,
    runId: input.runId,
    ownerAgentIdAtStart: input.ownerAgentIdAtStart,
    runOrigin: 'initial',
    kind: 'ephemeral',
    requestedAgentId: null,
    effectiveAgentId: null,
    ephemeralRole: 'codex_host',
    executionMaterialHash: 'codex_host_identity:v1',
    ownerAssignmentSource: 'conversation_active',
    executionSelectionSource: 'ephemeral_role',
    resolutionKind: 'direct',
  }
}
