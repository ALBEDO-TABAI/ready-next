import type { RequestEnvelope } from '../agent-control/contracts/request-envelope'
import { resolveBrowserCapability } from '../../../shared/browser-capability-registry'

export function httpOrigin(value: string): string | null {
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin : null } catch { return null }
}

export function browserWriteOrigins(text: string, pageOrigins: readonly (string | null | undefined)[]): string[] {
  const urls = text.match(/https?:\/\/[^\s<>"'`]+/g) || []
  return [...new Set([...pageOrigins, ...urls].filter((value): value is string => typeof value === 'string')
    .map(httpOrigin).filter((value): value is string => value !== null))].sort()
}

export function isBrowserOriginWrite(toolName: string, args: Record<string, unknown>): boolean {
  if (['browser_tabs', 'browser_scroll', 'browser_hover', 'browser_collect'].includes(toolName)) return false
  const capability = resolveBrowserCapability(toolName, args)
  return Boolean(capability?.effects.some(effect => ['page_mutation', 'upload', 'external_submit'].includes(effect)))
}

export function requiresBrowserOriginApproval(toolName: string, args: Record<string, unknown>, origin: string,
  envelope: Pick<RequestEnvelope, 'environmentHints'> | null, approved: readonly string[]): boolean {
  return isBrowserOriginWrite(toolName, args) && !(envelope?.environmentHints.browserWriteOrigins || []).includes(origin) && !approved.includes(origin)
}
