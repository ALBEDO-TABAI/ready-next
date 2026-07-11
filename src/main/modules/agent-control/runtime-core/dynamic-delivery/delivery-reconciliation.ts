import type { DeliveryStateV1 } from '../../../../../shared/dynamic-delivery'

const TERMINAL_PROJECTION_STATUSES = new Set(['completed', 'failed', 'killed'])
const TERMINAL_RUN_META_STATUSES = new Set(['done', 'error', 'cancelled', 'interrupted', 'checkpoint', 'killed'])

export function shouldReconcileInterruptedDeliveryProjection(input: {
  projectionStatus: string
  runMetaStatus: string | null
}): boolean {
  if (TERMINAL_PROJECTION_STATUSES.has(input.projectionStatus)) return false
  if (input.runMetaStatus && TERMINAL_RUN_META_STATUSES.has(input.runMetaStatus)) return false
  return input.projectionStatus === 'queued' || input.projectionStatus === 'running'
}

export function reconcileInterruptedDeliveryState(state: DeliveryStateV1): DeliveryStateV1 {
  const interrupted = state.packages.some((entry) =>
    entry.status === 'planned' || entry.status === 'running' || entry.status === 'redispatching',
  )
  if (!interrupted && state.verifier.status !== 'pending' && state.verifier.status !== 'repair') return state
  return {
    ...state,
    stateRevision: state.stateRevision + 1,
    packages: state.packages.map((entry) =>
      entry.status === 'planned' || entry.status === 'running' || entry.status === 'redispatching'
        ? { ...entry, status: entry.criticality === 'required' ? 'blocked' : 'degraded' }
        : entry,
    ),
    verifier: state.verifier.status === 'accepted'
      ? state.verifier
      : { ...state.verifier, status: 'blocked' },
  }
}
