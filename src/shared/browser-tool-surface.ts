import type { BrowserPowerEffect } from './browser-power'
import {
  BROWSER_PUBLIC_TOOL_NAMES,
  browserCapabilityEntry,
  browserOperationCapability,
  browserToolBaseEffects,
  isBrowserPublicToolName,
  type BrowserPublicToolName,
} from './browser-capability-registry'

export {
  BROWSER_PUBLIC_TOOL_NAMES,
  isBrowserPublicToolName,
  type BrowserPublicToolName,
} from './browser-capability-registry'

export type BrowserToolAccess = 'read' | 'write'

export interface BrowserToolSurfaceEntry {
  name: string
  defaultAccess: BrowserToolAccess
  effects: readonly BrowserPowerEffect[]
}

/**
 * Compatibility projection for callers that only need exposure metadata.
 * Operation identity, mode and effects remain owned by
 * BROWSER_CAPABILITY_REGISTRY; this projection contains no classification
 * decisions of its own.
 */
export const BROWSER_TOOL_SURFACE_MANIFEST: readonly BrowserToolSurfaceEntry[] = BROWSER_PUBLIC_TOOL_NAMES.map((name) => {
  const entry = browserCapabilityEntry(name)
  if (!entry) throw new Error(`browser_tool_surface_missing:${name}`)
  const isReadOnly = entry.operations.every((operationId) => (
    browserOperationCapability(operationId).mode === 'observe'
  ))
  return Object.freeze({
    name,
    defaultAccess: isReadOnly ? 'read' : 'write',
    effects: Object.freeze(browserToolBaseEffects(name)),
  })
})

const SURFACE_BY_NAME = new Map(BROWSER_TOOL_SURFACE_MANIFEST.map((entry) => [entry.name, entry]))

export function browserToolSurfaceEntry(name: string): BrowserToolSurfaceEntry | null {
  if (!browserCapabilityEntry(name)) return null
  return SURFACE_BY_NAME.get(name) || null
}
