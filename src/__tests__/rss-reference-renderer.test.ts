import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { useAgent } from '../renderer/stores/useAgent'
import { useMode } from '../renderer/stores/useMode'
import { useRSSSession } from '../renderer/stores/useRSSSession'
import { RSSQuerySchema } from '../shared/rss-workspace'
import { RSSReferenceSchema, rssReferencesFromEnvelope } from '../shared/rss-reference'
import { addRSSReferenceToAgentInput } from '../renderer/modules/agent/chat-input-bridge'
import { buildComposedAgentInputWithDiagnostics, extractAttachmentsFromMeta, serializePersistedAttachments } from '../renderer/modules/agent/messageComposer'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { buildRSSContext } from '../renderer/modules/rss/rss-context-reference'

function setup() {
  const dom = new JSDOM('<div></div>', { url: 'http://localhost' })
  const prior = new Map(['window', 'CustomEvent'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true })
  useRSSSession.getState().reset()
  useAgent.setState({ attachments: [] })
  useMode.setState({ workbenchMode: 'browser', splitMode: null })
  return () => {
    useAgent.setState({ attachments: [] })
    useRSSSession.getState().reset()
    useMode.setState({ workbenchMode: 'browser', splitMode: null })
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}
const messageText = (message: Awaited<ReturnType<typeof buildComposedAgentInputWithDiagnostics>>['message']) => typeof message === 'string' ? message : message.map((block) => block.text || '').join('\n')

test('RSS references survive attachment persistence and both immediate and file-pool composition without filesystem reads', async () => {
  const cleanup = setup()
  let fileReads = 0
  Object.assign(window, { electronAPI: { chat: { readFileForAI: () => { fileReads++; throw new Error('RSS is not a local file') } } } })
  const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'a', expectedRevision: 'v1' } })
  try {
    addRSSReferenceToAgentInput('Article.md', reference)
    const restored = extractAttachmentsFromMeta({ attachments: serializePersistedAttachments(useAgent.getState().attachments) })!
    assert.deepEqual(restored[0].rssReference, reference)
    for (const input of [
      { content: '整理一下', attachments: restored, filePool: [] },
      { content: '整理 @[Article.md]', attachments: [], filePool: restored },
    ]) {
      const composed = await buildComposedAgentInputWithDiagnostics(input)
      assert.equal(composed.diagnostics.inputFailedCount, 0)
      const refs = rssReferencesFromEnvelope(buildRequestEnvelope({ userText: messageText(composed.message) }))
      assert.equal(refs.length, 1)
      assert.deepEqual(refs[0].reference, reference)
    }
    assert.equal(fileReads, 0)
  } finally { cleanup() }
})

test('RSS split-pane context is frozen and explicit references suppress an unrelated visible query', async () => {
  const cleanup = setup()
  let reads = 0
  Object.assign(window, { electronAPI: { rss: { readArticle: async () => { reads++; return { success: true, data: { article: { title: 'Selected', revision: 'v2' } } } } } } })
  const query = RSSQuerySchema.parse({ scope: 'library', search: 'Scope' })
  useRSSSession.setState({ query, view: { query, revision: 9, total: 20, unreadTotal: 20, items: [], nextCursor: null, lastFetchAt: null }, selectedItemId: 'selected' })
  useMode.setState({ workbenchMode: 'browser', splitMode: 'rss' })
  try {
    const context = await buildRSSContext()
    assert.ok(context)
    const refs = rssReferencesFromEnvelope(buildRequestEnvelope({ userText: context }))
    assert.equal(refs.length, 2)
    assert.equal(refs[0].reference.kind, 'query')
    assert.equal(refs[1].reference.kind, 'article')
    const reference = RSSReferenceSchema.parse({ kind: 'article', read: { itemId: 'other', expectedRevision: 'v3' } })
    addRSSReferenceToAgentInput('Explicit', reference)
    const composed = await buildComposedAgentInputWithDiagnostics({ content: '总结', attachments: useAgent.getState().attachments, filePool: [], includeRSSContext: true })
    assert.equal(rssReferencesFromEnvelope(buildRequestEnvelope({ userText: messageText(composed.message) })).length, 1)
    assert.equal(reads, 1)
    Object.assign(window.electronAPI.rss, { readArticle: async () => { useRSSSession.getState().setQuery({ search: 'Other' }); return { success: true, data: { article: { title: 'Old', revision: 'v2' } } } } })
    assert.equal(await buildRSSContext(), null)
  } finally { cleanup() }
})
