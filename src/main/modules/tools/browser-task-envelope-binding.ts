import { createHash } from 'node:crypto'
import type { BrowserOperationId, BrowserPublicToolName } from '../../../shared/browser-capability-registry'
import type { BrowserTaskEnvelope } from '../../../shared/browser-task-envelope'

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]))
    }
    return item
  }
  return JSON.stringify(normalize(value))
}

export function browserInvocationArgsDigest(
  toolName: BrowserPublicToolName,
  operationId: BrowserOperationId,
  args: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256')
    .update(canonicalJson({ toolName, operationId, args }))
    .digest('hex')
}

export function browserEnvelopeMatchesInvocation(
  envelope: BrowserTaskEnvelope | null | undefined,
  toolName: BrowserPublicToolName,
  operationId: BrowserOperationId,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return Boolean(
    envelope
    && envelope.version === 3
    && envelope.scopeId
    && envelope.runId
    && envelope.parentTaskId
    && envelope.toolName === toolName
    && envelope.operationId === operationId
    && envelope.argsDigest === browserInvocationArgsDigest(toolName, operationId, args),
  )
}
