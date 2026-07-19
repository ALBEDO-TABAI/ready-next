import type {
  BrowserConfirmationSuspensionRequest,
  BrowserOwnerCrashRecoveryReceipt,
  BrowserPowerConfirmationSuspensionRequest,
} from '../../../shared/browser-workflow-control'

export function powerConfirmationRequestFromContinuation(
  continuation: Record<string, unknown>,
): BrowserPowerConfirmationSuspensionRequest | null {
  const value = continuation.suspensionRequest
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  const target = request.target
  const actionIntent = request.actionIntent
  if (
    request.version !== 1
    || request.kind !== 'browser_power_confirmation'
    || request.wakeKind !== 'browser_power_confirmation'
    || typeof request.requestId !== 'string'
    || !request.requestId.trim()
    || (request.toolName !== 'browser_eval' && request.toolName !== 'browser_cdp')
    || !Array.isArray(request.effects)
    || request.effects.length === 0
    || !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || !actionIntent
    || typeof actionIntent !== 'object'
    || Array.isArray(actionIntent)
  ) return null
  return structuredClone(value) as BrowserPowerConfirmationSuspensionRequest
}

export function permissionConfirmationRequestFromContinuation(
  continuation: Record<string, unknown>,
): Extract<BrowserConfirmationSuspensionRequest, { kind: 'browser_permission' }> | null {
  const value = continuation.suspensionRequest
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  const target = request.target
  const actionIntent = request.actionIntent
  if (
    request.version !== 1
    || request.kind !== 'browser_permission'
    || request.wakeKind !== 'browser_permission'
    || request.toolName !== 'browser_permission'
    || typeof request.requestId !== 'string'
    || !request.requestId.trim()
    || request.purpose !== 'site_permission_request'
    || !target
    || typeof target !== 'object'
    || Array.isArray(target)
    || !actionIntent
    || typeof actionIntent !== 'object'
    || Array.isArray(actionIntent)
  ) return null
  const intent = actionIntent as Record<string, unknown>
  const boundTarget = target as Record<string, unknown>
  if (
    typeof intent.siteRequestId !== 'string'
    || !intent.siteRequestId.trim()
    || typeof intent.permission !== 'string'
    || !intent.permission.trim()
    || typeof intent.origin !== 'string'
    || !intent.origin.trim()
    || (intent.decision !== 'allow' && intent.decision !== 'deny')
    || typeof intent.inputHash !== 'string'
    || !intent.inputHash.trim()
    || typeof boundTarget.scopeId !== 'string'
    || typeof boundTarget.ownerRunId !== 'string'
    || typeof boundTarget.browserTaskId !== 'string'
    || typeof boundTarget.tabId !== 'string'
    || typeof boundTarget.targetDigest !== 'string'
  ) return null
  return structuredClone(value) as Extract<BrowserConfirmationSuspensionRequest, { kind: 'browser_permission' }>
}

export function confirmationRequestFromContinuation(
  continuation: Record<string, unknown>,
): BrowserConfirmationSuspensionRequest | null {
  return powerConfirmationRequestFromContinuation(continuation)
    || permissionConfirmationRequestFromContinuation(continuation)
}

export function ownerCrashReceiptFromContinuation(
  continuation: Record<string, unknown>,
): BrowserOwnerCrashRecoveryReceipt | null {
  const value = continuation.ownerCrashReceipt
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const receipt = value as Record<string, unknown>
  if (
    receipt.version !== 1
    || typeof receipt.receiptId !== 'string'
    || !receipt.receiptId.trim()
    || typeof receipt.failedOwnerRunId !== 'string'
    || !receipt.failedOwnerRunId.trim()
    || typeof receipt.checkpointId !== 'string'
    || !receipt.checkpointId.trim()
    || typeof receipt.errorDigest !== 'string'
    || !receipt.errorDigest.trim()
    || typeof receipt.createdAt !== 'string'
    || !receipt.createdAt.trim()
  ) return null
  return structuredClone(value) as BrowserOwnerCrashRecoveryReceipt
}
