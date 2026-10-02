import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { useAgent } from '../renderer/stores/useAgent'
import { useMode } from '../renderer/stores/useMode'
import { useRSSSession } from '../renderer/stores/useRSSSession'
import { RSSQuerySchema } from '../shared/rss-workspace'
import { RSSReferenceSchema } from '../shared/rss-reference'
import { addRSSReferenceToAgentInput } from '../renderer/modules/agent/chat-input-bridge'
import { buildCodexIngressInputWithDiagnostics, extractAttachmentsFromMeta, serializePersistedAttachments, resolveReferencedFilePoolAttachments } from '../renderer/modules/agent/messageComposer'
import { collectWorkbenchSurfaceResources } from '../renderer/stores/agent-workbench-resources'

function setup() {
  const dom = new JSDOM('<div></div>', { url: 'http://localhost' })
  const prior = new Map(['window', 'CustomEvent'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true })
  useRSSSession.getState().reset(); useAgent.setState({ attachments: [] }); useMode.setState({ workbenchMode: 'browser', splitMode: null })
  return () => {
    useAgent.setState({ attachments: [] }); useRSSSession.getState().reset(); useMode.setState({ workbenchMode: 'browser', splitMode: null })
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key] }
    dom.window.close()
  }
}

test('typed RSS references survive persistence and direct/file-pool Codex ingress without file reads', async () => {
  const cleanup = setup(); let reads = 0
  Object.assign(window, { electronAPI: { chat: { readFileForAI: () => { reads++; throw new Error('Not a local file') } } } })
  const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'a', expectedRevision: 'v1' } })
  try {
    addRSSReferenceToAgentInput('Article.md', reference)
    const restored = extractAttachmentsFromMeta({ attachments: serializePersistedAttachments(useAgent.getState().attachments) })!
    assert.deepEqual(restored[0].rssReference, reference)
    for (const attachments of [restored, resolveReferencedFilePoolAttachments('整理 @[Article.md]', restored)]) {
      const composed = await buildCodexIngressInputWithDiagnostics({ content: '整理一下', attachments })
      assert.equal(composed.diagnostics.inputFailedCount, 0)
      assert.equal(composed.resources?.length, 1)
      assert.deepEqual(composed.resources?.[0], { kind: 'rss_reference', id: restored[0].id, name: 'Article.md', reference })
    }
    assert.equal(reads, 0)
  } finally { cleanup() }
})

test('current RSS context uses a frozen visible selection or matching query without reading hidden content', () => {
  const cleanup = setup()
  const query = RSSQuerySchema.parse({ scope: 'library', search: 'Scope' })
  useRSSSession.setState({ query, view: { query, revision: 9, total: 20, unreadTotal: 20, items: [], nextCursor: null, lastFetchAt: null }, selectedItemId: null })
  useMode.setState({ workbenchMode: 'browser', splitMode: 'rss' })
  try {
    const context = collectWorkbenchSurfaceResources()
    assert.equal(context.length, 1); assert.equal(context[0].kind, 'rss_reference')
    if (context[0].kind !== 'rss_reference') throw new Error('wrong resource')
    assert.equal(context[0].reference.kind, 'query')
    useRSSSession.getState().setSelection({ selectedItemId: 'selected', selectedItemExpectedRevision: 'v2' })
    const selected = collectWorkbenchSurfaceResources()[0]
    assert.equal(selected.kind, 'rss_reference'); if (selected.kind !== 'rss_reference') throw new Error('wrong resource')
    assert.equal(selected.reference.kind, 'article')
    useRSSSession.getState().setSelection({ selectedItemId: null }); useRSSSession.getState().setQuery({ search: 'Other' })
    assert.deepEqual(collectWorkbenchSurfaceResources(), [], 'a late query must not masquerade as the new visible scope')
    useMode.setState({ workbenchMode: 'browser', splitMode: null }); assert.deepEqual(collectWorkbenchSurfaceResources(), [])
  } finally { cleanup() }
})
