export type DeliveryFailureAction = 'redispatch' | 'degrade' | 'block'
export type DeliverySettlementStatus = 'redispatching' | 'degraded' | 'blocked'

export interface DeliveryFailureSettlement {
  packageId: string
  action: DeliveryFailureAction
  status: DeliverySettlementStatus
  nextAttempt: 0 | 1
  reason: string
}

export const DELIVERY_PLAN_REDISPATCH_CAP = 1

export function settleDeliveryFailure(input: {
  packageId: string
  requested: DeliveryFailureAction
  currentAttempt: 0 | 1
  planRedispatchesUsed: number
  degradeReason?: string
  blockReason?: string
}): DeliveryFailureSettlement {
  if (!input.packageId.trim()) throw new Error('[delivery-settlement] packageId is required')
  if (input.requested === 'redispatch') {
    if (input.currentAttempt >= 1) throw new Error('[delivery-settlement] package attempt cap exhausted')
    if (input.planRedispatchesUsed >= DELIVERY_PLAN_REDISPATCH_CAP) throw new Error('[delivery-settlement] plan redispatch cap exhausted')
    return {
      packageId: input.packageId,
      action: 'redispatch',
      status: 'redispatching',
      nextAttempt: 1,
      reason: 'redispatch_once',
    }
  }
  if (input.requested === 'degrade') {
    const reason = input.degradeReason?.trim()
    if (!reason) throw new Error('[delivery-settlement] degrade requires an explicit reason')
    return { packageId: input.packageId, action: 'degrade', status: 'degraded', nextAttempt: input.currentAttempt, reason }
  }
  if (input.requested === 'block') {
    return {
      packageId: input.packageId,
      action: 'block',
      status: 'blocked',
      nextAttempt: input.currentAttempt,
      reason: input.blockReason?.trim() || 'delivery_worker_blocked',
    }
  }
  throw new Error(`[delivery-settlement] unknown action: ${String(input.requested)}`)
}

export function listUnsettledRequiredPackageIds(packages: ReadonlyArray<{
  packageId: string
  criticality: 'required' | 'optional'
  status: 'planned' | 'running' | 'completed' | 'redispatching' | 'degraded' | 'blocked'
}>): string[] {
  return packages
    .filter((pkg) => pkg.criticality === 'required' && ['planned', 'running', 'redispatching'].includes(pkg.status))
    .map((pkg) => pkg.packageId)
}

export const unsettledRequiredPackages = listUnsettledRequiredPackageIds
