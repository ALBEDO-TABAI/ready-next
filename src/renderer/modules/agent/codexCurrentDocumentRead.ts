import { z } from 'zod'

import { codexCurrentDocumentAnchorSchema } from '../../../shared/ipc-contracts/agent-runtime'
import { performDocActionWithMetadata } from './documentActions'
import {
  digestCodexDocumentValue,
  getFocusedCodexDocumentSnapshot,
  isAuthorizedCodexDocumentDigest,
  isLatestAuthorizedCodexDocumentAnchor,
  type FocusedCodexDocumentSnapshot,
} from './codexCurrentDocumentAnchor'

const authoritySchema = z.object({
  scopeId: z.string().min(1),
  requestBindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
  anchor: codexCurrentDocumentAnchorSchema,
}).strict()

function stalePayload(requestedVersion: string): Record<string, unknown> {
  return {
    ok: false,
    errorKind: 'resource_version_superseded',
    summary: '当前文档已在本轮读取前发生变化，请基于新版本重新读取。',
    bodyBytes: 0,
    requestedVersion,
  }
}

async function snapshotMatchesAnchor(
  snapshot: FocusedCodexDocumentSnapshot | null,
  scopeId: string,
  anchor: z.infer<typeof codexCurrentDocumentAnchorSchema>,
): Promise<boolean> {
  if (!snapshot
    || snapshot.tabId !== anchor.tabId
    || snapshot.title !== anchor.title
    || snapshot.pane !== anchor.pane) return false
  const [currentDigest, pathDigest, incarnationKey] = await Promise.all([
    digestCodexDocumentValue(snapshot.content),
    snapshot.path ? digestCodexDocumentValue(snapshot.path) : Promise.resolve(null),
    digestCodexDocumentValue(JSON.stringify([
      scopeId,
      snapshot.tabId,
      snapshot.pane,
      snapshot.path,
    ])),
  ])
  return isAuthorizedCodexDocumentDigest(scopeId, anchor, currentDigest)
    && anchor.currentVersion === `sha256:${anchor.currentDigest}`
    && pathDigest === anchor.pathDigest
    && incarnationKey === anchor.incarnationKey
}

export async function executeCodexCurrentDocumentRead(
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const parsed = authoritySchema.safeParse(args.__readyResourceRead)
  if (!parsed.success) return null
  const { scopeId, requestBindingDigest, anchor } = parsed.data
  if (!isLatestAuthorizedCodexDocumentAnchor(scopeId, anchor)) {
    return stalePayload(anchor.currentVersion)
  }
  const before = getFocusedCodexDocumentSnapshot()
  if (!(await snapshotMatchesAnchor(before, scopeId, anchor))) {
    return stalePayload(anchor.currentVersion)
  }

  const publicArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== '__readyResourceRead'),
  )
  const result = await performDocActionWithMetadata({
    type: 'read_section',
    ...publicArgs,
    tabId: anchor.tabId,
    maxChars: Math.min(
      anchor.readScope.maxChars,
      typeof publicArgs.maxChars === 'number' ? publicArgs.maxChars : anchor.readScope.maxChars,
    ),
  })
  const after = getFocusedCodexDocumentSnapshot()
  const afterMatches = await snapshotMatchesAnchor(after, scopeId, anchor)
  if (!afterMatches
    || !isLatestAuthorizedCodexDocumentAnchor(scopeId, anchor)
    || before?.content !== after?.content
    || before?.path !== after?.path) {
    return stalePayload(anchor.currentVersion)
  }

  const summaryDigest = await digestCodexDocumentValue(result.summary)
  if (!isLatestAuthorizedCodexDocumentAnchor(scopeId, anchor)) {
    return stalePayload(anchor.currentVersion)
  }
  return {
    ok: true,
    intent: 'document.readSection',
    summary: result.summary,
    resourceRead: {
      logicalResourceId: anchor.logicalResourceId,
      currentVersion: anchor.currentVersion,
      currentDigest: anchor.currentDigest,
      policyEpoch: anchor.policyEpoch,
      tabId: anchor.tabId,
      pane: anchor.pane,
      pathDigest: anchor.pathDigest,
      incarnationKey: anchor.incarnationKey,
      operation: 'read_section',
      requestBindingDigest,
      summaryDigest,
      bodyBytes: new TextEncoder().encode(result.summary).byteLength,
    },
  }
}
