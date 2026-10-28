import type { CodexCurrentDocumentAnchor } from '../../../shared/ipc-contracts/agent-runtime'
import { useDocTabs } from '../../stores/useDocTabs'
import { useMode } from '../../stores/useMode'

const MAX_STABILITY_ATTEMPTS = 3
const previousVersionByResource = new Map<string, string>()
const latestAuthorizationByResource = new Map<string, {
  scopeId: string
  anchor: CodexCurrentDocumentAnchor
}>()
let lastPolicyEpoch = 0
// Versions reached from an authorized version only through the turn's own edits, keyed by the anchor.
const runEditedDigestsByAnchor = new Map<string, Set<string>>()

function anchorEditKey(scopeId: string, anchor: CodexCurrentDocumentAnchor): string {
  return `${scopeId}\0${anchor.logicalResourceId}\0${anchor.policyEpoch}`
}

/** Whether `digest` is the anchored version or one the same turn's edits produced from it. */
export function isAuthorizedCodexDocumentDigest(
  scopeId: string,
  anchor: CodexCurrentDocumentAnchor,
  digest: string,
): boolean {
  return digest === anchor.currentDigest
    || runEditedDigestsByAnchor.get(anchorEditKey(scopeId, anchor))?.has(digest) === true
}

/** An edit by the turn that started from an authorized version keeps the result readable; anything else does not. */
export function recordCodexDocumentEdit(
  scopeId: string,
  anchor: CodexCurrentDocumentAnchor,
  beforeDigest: string,
  afterDigest: string,
): void {
  if (!isAuthorizedCodexDocumentDigest(scopeId, anchor, beforeDigest)) return
  const key = anchorEditKey(scopeId, anchor)
  const digests = runEditedDigestsByAnchor.get(key) || new Set<string>()
  digests.add(afterDigest)
  runEditedDigestsByAnchor.set(key, digests)
}

function nextPolicyEpoch(): number {
  lastPolicyEpoch = Math.max(Date.now(), lastPolicyEpoch + 1)
  return lastPolicyEpoch
}

export async function digestCodexDocumentValue(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export type FocusedCodexDocumentSnapshot = {
  tabId: string
  title: string
  path: string | null
  content: string
  pane: 'primary' | 'split'
}

export function getFocusedCodexDocumentSnapshot(): FocusedCodexDocumentSnapshot | null {
  const mode = useMode.getState()
  if (mode.workbenchMode !== 'document' && mode.splitMode !== 'document') return null
  const state = useDocTabs.getState()
  const focusedId = state.focusedPaneTabId
  const tabId = focusedId && (focusedId === state.activeTabId || focusedId === state.splitTabId)
    ? focusedId
    : state.activeTabId
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return null
  return {
    tabId: tab.id,
    title: tab.title,
    path: tab.path,
    content: tab.content,
    pane: state.splitTabId === tab.id ? 'split' : 'primary',
  }
}

function sameSnapshot(
  left: FocusedCodexDocumentSnapshot | null,
  right: FocusedCodexDocumentSnapshot | null,
): boolean {
  return Boolean(left && right)
    && left?.tabId === right?.tabId
    && left?.title === right?.title
    && left?.path === right?.path
    && left?.content === right?.content
    && left?.pane === right?.pane
}

export async function buildCodexCurrentDocumentAnchor(
  scopeId: string,
): Promise<CodexCurrentDocumentAnchor | undefined> {
  for (let attempt = 0; attempt < MAX_STABILITY_ATTEMPTS; attempt += 1) {
    const before = getFocusedCodexDocumentSnapshot()
    if (!before) return undefined
    const [currentDigest, pathDigest, incarnationKey] = await Promise.all([
      digestCodexDocumentValue(before.content),
      before.path ? digestCodexDocumentValue(before.path) : Promise.resolve(null),
      digestCodexDocumentValue(JSON.stringify([scopeId, before.tabId, before.pane, before.path])),
    ])
    if (!sameSnapshot(before, getFocusedCodexDocumentSnapshot())) continue

    const logicalResourceId = `ready-current-document:${scopeId}:${before.tabId}`
    const currentVersion = `sha256:${currentDigest}`
    const previousVersion = previousVersionByResource.get(logicalResourceId) || null
    previousVersionByResource.set(logicalResourceId, currentVersion)
    const anchor: CodexCurrentDocumentAnchor = {
      kind: 'current_document',
      logicalResourceId,
      tabId: before.tabId,
      title: before.title,
      pane: before.pane,
      pathDigest,
      incarnationKey,
      currentVersion,
      currentDigest,
      supersedesVersion: previousVersion && previousVersion !== currentVersion ? previousVersion : null,
      policyEpoch: nextPolicyEpoch(),
      readScope: {
        operation: 'read_section',
        maxChars: 30_000,
      },
    }
    latestAuthorizationByResource.set(logicalResourceId, { scopeId, anchor })
    return anchor
  }
  throw new Error('current_document_changed_during_anchor_capture')
}

export function isLatestAuthorizedCodexDocumentAnchor(
  scopeId: string,
  anchor: CodexCurrentDocumentAnchor,
): boolean {
  const latest = latestAuthorizationByResource.get(anchor.logicalResourceId)
  if (!latest || latest.scopeId !== scopeId) return false
  return latest.anchor.tabId === anchor.tabId
    && latest.anchor.title === anchor.title
    && latest.anchor.pane === anchor.pane
    && latest.anchor.pathDigest === anchor.pathDigest
    && latest.anchor.incarnationKey === anchor.incarnationKey
    && latest.anchor.currentVersion === anchor.currentVersion
    && latest.anchor.currentDigest === anchor.currentDigest
    && latest.anchor.supersedesVersion === anchor.supersedesVersion
    && latest.anchor.policyEpoch === anchor.policyEpoch
    && latest.anchor.readScope.operation === anchor.readScope.operation
    && latest.anchor.readScope.maxChars === anchor.readScope.maxChars
}

export function resetCodexCurrentDocumentAnchorStateForTest(): void {
  previousVersionByResource.clear()
  latestAuthorizationByResource.clear()
  runEditedDigestsByAnchor.clear()
  lastPolicyEpoch = 0
}
