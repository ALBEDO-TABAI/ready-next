export interface AgentRuntimeReadinessSnapshot {
  ready: boolean
  bootGeneration: number
}

export function parseAgentRuntimeReadinessSnapshot(value: unknown): AgentRuntimeReadinessSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent_runtime_readiness_invalid')
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.ready !== 'boolean'
    || typeof input.bootGeneration !== 'number'
    || !Number.isInteger(input.bootGeneration)
    || input.bootGeneration < 0
    || (input.ready && input.bootGeneration === 0)
  ) {
    throw new Error('agent_runtime_readiness_invalid')
  }
  return {
    ready: input.ready,
    bootGeneration: input.bootGeneration,
  }
}
