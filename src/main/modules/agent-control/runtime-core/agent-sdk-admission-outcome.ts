export function resolveBeginRunRejection(reason: 'superseded' | 'orphan_limit' | 'active_owner_exists'): {
  status: 'cancelled' | 'error'
  terminalReason: 'cancelled_runtime' | 'blocked_external'
  cancelled: boolean
} {
  return reason === 'superseded'
    ? { status: 'cancelled', terminalReason: 'cancelled_runtime', cancelled: true }
    : { status: 'error', terminalReason: 'blocked_external', cancelled: false }
}
