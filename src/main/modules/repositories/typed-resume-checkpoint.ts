import type { AgentInputItem } from '@openai/agents'

import { workflowDigest } from './browser-workflow-codec'

const RECOVERY_KEY = 'readyTypedResumeRecovery'

function hasExactPrefix(prefix: readonly AgentInputItem[], items: readonly AgentInputItem[]): boolean {
  return prefix.length <= items.length
    && workflowDigest(prefix) === workflowDigest(items.slice(0, prefix.length))
}

function alreadyDurable(item: AgentInputItem): boolean {
  const providerData = (item as { providerData?: unknown }).providerData
  return Boolean(
    providerData
    && typeof providerData === 'object'
    && !Array.isArray(providerData)
    && (
      (providerData as Record<string, unknown>).readySteeringReceipt
      || (providerData as Record<string, unknown>).readyBrowserVerifierRecovery
      || (providerData as Record<string, unknown>).readyBrowserPowerConfirmation
      || (providerData as Record<string, unknown>).readyBrowserPermissionConfirmation
    ),
  )
}

export function buildTypedResumeCheckpointInput(input: {
  suspensionInput: readonly AgentInputItem[]
  previousCleanInput: readonly AgentInputItem[] | null
  wakeId: string
}): AgentInputItem[] {
  const recoveryStart = input.previousCleanInput
    && hasExactPrefix(input.previousCleanInput, input.suspensionInput)
    ? input.previousCleanInput.length
    : 0
  return input.suspensionInput.map((item, index) => {
    const cloned = structuredClone(item) as AgentInputItem
    if (index < recoveryStart || alreadyDurable(cloned)) return cloned
    const record = cloned as AgentInputItem & { providerData?: Record<string, unknown> }
    record.providerData = {
      ...(record.providerData || {}),
      [RECOVERY_KEY]: {
        version: 1,
        wakeId: input.wakeId,
        recoveryOrdinal: index - recoveryStart,
        itemDigest: workflowDigest(item),
      },
    }
    return record
  })
}

export function typedResumeRecoveryId(item: AgentInputItem): string | null {
  const providerData = (item as { providerData?: unknown }).providerData
  if (!providerData || typeof providerData !== 'object' || Array.isArray(providerData)) return null
  const recovery = (providerData as Record<string, unknown>)[RECOVERY_KEY]
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null
  const marker = recovery as Record<string, unknown>
  const wakeId = String(marker.wakeId || '')
  const recoveryOrdinal = Number(marker.recoveryOrdinal)
  const itemDigest = String(marker.itemDigest || '')
  if (
    marker.version !== 1
    || !wakeId
    || !Number.isInteger(recoveryOrdinal)
    || recoveryOrdinal < 0
    || !itemDigest
  ) return null
  const cloned = structuredClone(item) as AgentInputItem & { providerData?: Record<string, unknown> }
  const cleanProviderData = { ...(cloned.providerData || {}) }
  delete cleanProviderData[RECOVERY_KEY]
  if (Object.keys(cleanProviderData).length > 0) cloned.providerData = cleanProviderData
  else delete cloned.providerData
  if (workflowDigest(cloned) !== itemDigest) return null
  return `${wakeId}:${recoveryOrdinal}:${itemDigest}`
}

export function consumeTypedResumeRecoveryMarkers(items: readonly AgentInputItem[]): AgentInputItem[] {
  return items.map((item) => {
    const providerData = (item as { providerData?: unknown }).providerData
    const hasMarker = Boolean(
      providerData
      && typeof providerData === 'object'
      && !Array.isArray(providerData)
      && RECOVERY_KEY in providerData,
    )
    if (!hasMarker) return structuredClone(item) as AgentInputItem
    if (!typedResumeRecoveryId(item)) throw new Error('typed_resume_recovery_marker_invalid')
    const cloned = structuredClone(item) as AgentInputItem & { providerData?: Record<string, unknown> }
    const cleanedProviderData = { ...(cloned.providerData || {}) }
    delete cleanedProviderData[RECOVERY_KEY]
    if (Object.keys(cleanedProviderData).length > 0) cloned.providerData = cleanedProviderData
    else delete cloned.providerData
    return cloned
  })
}
