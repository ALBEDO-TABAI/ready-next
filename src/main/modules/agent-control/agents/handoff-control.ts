import { normalizeToolExecutionOutput, type ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type { TaskProjectionRecord } from '../contracts/run-contracts'

export function isHandoffTakeoverToolOutput(output: ToolExecutionOutput): boolean {
  const data = normalizeToolExecutionOutput(output).data
  if (!data || typeof data !== 'object') return false
  const outcome = (data as Record<string, unknown>).outcome
  return Boolean(outcome && typeof outcome === 'object' && (outcome as Record<string, unknown>).control === 'handoff_takeover')
}

export function hasAdvancedPastHandoffContinuation(
  projection: Pick<TaskProjectionRecord, 'ownerAgentId' | 'executionBinding' | 'continuationRef'> | null | undefined,
): boolean {
  if (!projection || projection.continuationRef) return false
  const binding = projection.executionBinding
  return binding?.runOrigin === 'handoff_takeover'
    && binding.effectiveAgentId === projection.ownerAgentId
}

export async function runWithHandoffToolGate<T>(
  state: { hostControl?: 'handoff_takeover' | null; toolExecutionChain?: Promise<void> },
  invoke: () => Promise<T>,
  onClosed: () => T,
): Promise<T> {
  const previous = state.toolExecutionChain ?? Promise.resolve()
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  state.toolExecutionChain = previous.then(() => barrier)
  await previous
  try {
    return state.hostControl === 'handoff_takeover' ? onClosed() : await invoke()
  } finally {
    release()
  }
}
