import {
  BROWSER_CAPABILITY_REGISTRY,
  browserOperationCapability,
  isBrowserPublicToolName,
  type BrowserPublicToolName,
} from '../../../../shared/browser-capability-registry'
import type { TrustedRequestEnvironment } from '../contracts/request-envelope'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export type TrustedBrowserPageRef = NonNullable<TrustedRequestEnvironment['browserPageRef']>

export type BrowserAdmissionAuthoritySnapshot = {
  authorityId: string
  authorityDigest: string
  activeWorkbenchMode: TrustedRequestEnvironment['workbenchMode'] | null
  currentBrowserRoot: TrustedBrowserPageRef | null
  explicitBrowserReadRefs: readonly TrustedBrowserPageRef[]
  selectedSkillBrowserToolNames: readonly string[]
  hasExplicitAttachment: boolean
  hasWritableRoot: boolean
  tagForgeExclusive: boolean
}

export const BROWSER_EXPLICIT_READ_TOOL_NAMES = [
  'browser_snapshot',
  'browser_find',
  'browser_read',
  'browser_screenshot',
  'browser_wait',
  'browser_status',
] as const satisfies readonly BrowserPublicToolName[]

export const BROWSER_CURRENT_PAGE_TOOL_NAMES = [
  'browser_navigate',
  'browser_search',
  'browser_snapshot',
  'browser_find',
  'browser_read',
  'browser_screenshot',
  'browser_wait',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_select',
  'browser_hover',
  'browser_scroll',
  'browser_press_key',
  'browser_drag',
  'browser_dialog',
  'browser_research',
  'browser_collect',
  'browser_status',
] as const satisfies readonly BrowserPublicToolName[]

const BROWSER_SKILL_ONLY_TOOL_NAMES = new Set<BrowserPublicToolName>([
  'browser_task',
  'browser_console',
  'browser_network',
  'browser_resources',
  'browser_eval',
  'browser_cdp',
  'browser_session',
  'browser_permission',
])

function pageRefIdentity(ref: TrustedBrowserPageRef): string {
  return [
    ref.tabId,
    ref.physicalTargetToken,
    ref.mainFrameDocumentToken,
    ref.mainFrameId || '',
    ref.profileId || '',
  ].join('\u0000')
}

function isCompletePageRef(value: TrustedRequestEnvironment['browserPageRef'] | null | undefined): value is TrustedBrowserPageRef {
  return Boolean(
    value
    && typeof value.tabId === 'string'
    && value.tabId
    && typeof value.physicalTargetToken === 'string'
    && value.physicalTargetToken
    && typeof value.mainFrameDocumentToken === 'string'
    && value.mainFrameDocumentToken,
  )
}

export function assertBrowserExplicitReadOperationsAreObserve(): void {
  for (const toolName of BROWSER_EXPLICIT_READ_TOOL_NAMES) {
    for (const operationId of BROWSER_CAPABILITY_REGISTRY[toolName].operations) {
      if (browserOperationCapability(operationId).mode !== 'observe') {
        throw new Error(`browser_explicit_read_not_observe:${toolName}:${operationId}`)
      }
    }
  }
}

export function buildBrowserAdmissionAuthoritySnapshot(input: {
  authorityId: string
  activeWorkbenchMode?: TrustedRequestEnvironment['workbenchMode'] | null
  currentBrowserPageRef?: TrustedRequestEnvironment['browserPageRef'] | null
  explicitBrowserReadRefs?: ReadonlyArray<TrustedRequestEnvironment['browserPageRef'] | null | undefined>
  selectedSkillToolNames?: readonly string[]
  hasExplicitAttachment?: boolean
  hasWritableRoot?: boolean
  tagForgeExclusive?: boolean
}): BrowserAdmissionAuthoritySnapshot {
  const activeWorkbenchMode = input.activeWorkbenchMode || null
  const currentBrowserRoot = activeWorkbenchMode === 'browser' && isCompletePageRef(input.currentBrowserPageRef)
    ? input.currentBrowserPageRef
    : null
  const explicitBrowserReadRefs = [...new Map(
    (input.explicitBrowserReadRefs || [])
      .filter(isCompletePageRef)
      .filter((ref) => !currentBrowserRoot || pageRefIdentity(ref) !== pageRefIdentity(currentBrowserRoot))
      .map((ref) => [pageRefIdentity(ref), ref] as const),
  ).values()].sort((left, right) => left.tabId.localeCompare(right.tabId))
  const selectedSkillBrowserToolNames = [...new Set(
    (input.selectedSkillToolNames || []).filter(isBrowserPublicToolName),
  )].sort()
  const snapshot: Omit<BrowserAdmissionAuthoritySnapshot, 'authorityDigest'> = {
    authorityId: input.authorityId,
    activeWorkbenchMode,
    currentBrowserRoot,
    explicitBrowserReadRefs,
    selectedSkillBrowserToolNames,
    hasExplicitAttachment: input.hasExplicitAttachment === true,
    hasWritableRoot: input.hasWritableRoot === true,
    tagForgeExclusive: input.tagForgeExclusive === true,
  }
  return {
    ...snapshot,
    authorityDigest: digestCanonicalJson(snapshot),
  }
}

export function composeBrowserAdmissionToolNames(
  snapshot: BrowserAdmissionAuthoritySnapshot,
): string[] {
  if (snapshot.tagForgeExclusive) return []
  const names = new Set<string>()
  if (snapshot.currentBrowserRoot) {
    for (const name of BROWSER_CURRENT_PAGE_TOOL_NAMES) {
      if (name !== 'browser_research') names.add(name)
    }
    if (snapshot.hasExplicitAttachment) names.add('browser_upload')
    if (snapshot.hasWritableRoot) names.add('browser_archive')
    for (const name of snapshot.selectedSkillBrowserToolNames) {
      if (BROWSER_SKILL_ONLY_TOOL_NAMES.has(name as BrowserPublicToolName)) names.add(name)
    }
  } else if (snapshot.explicitBrowserReadRefs.length > 0) {
    for (const name of BROWSER_EXPLICIT_READ_TOOL_NAMES) names.add(name)
  }
  return [...names].sort()
}

export function composeBrowserAdmissionExtraToolNames(
  snapshot: BrowserAdmissionAuthoritySnapshot,
): string[] {
  if (snapshot.tagForgeExclusive || !snapshot.currentBrowserRoot) return []
  const names = new Set<string>()
  if (snapshot.hasExplicitAttachment) names.add('browser_upload')
  if (snapshot.hasWritableRoot) names.add('browser_archive')
  for (const name of snapshot.selectedSkillBrowserToolNames) {
    if (BROWSER_SKILL_ONLY_TOOL_NAMES.has(name as BrowserPublicToolName)) names.add(name)
  }
  return [...names].sort()
}

export function resolveBrowserExecutionPageRef(
  snapshot: BrowserAdmissionAuthoritySnapshot,
): TrustedBrowserPageRef | null {
  return snapshot.currentBrowserRoot || snapshot.explicitBrowserReadRefs[0] || null
}

export function stripBrowserPublicToolNames(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => (
    !isBrowserPublicToolName(name)
    && name !== 'use_browser'
    && name !== 'use_skill'
  ))
}
