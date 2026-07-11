import type { DeliveryStateV1 } from '../../../../../shared/dynamic-delivery'

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
