import type { DocumentDraftAPI, DraftResult } from '../../../../shared/document-drafts'

export const TAB_METADATA_KEY = 'ready-doc-tabs-v2'
const PREFIX = 'ready-doc-tab-draft-v1:'
export function getDocTabDraftStorageKey(id: string): string { return `${PREFIX}${encodeURIComponent(id)}` }
export async function contentHash(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function unwrap<T>(result: DraftResult<T>): T {
  if (!result.ok) throw new Error(result.message)
  return result.value
}
type LegacyTab = { id: string; path?: string | null; title?: string; content?: string; isDirty?: boolean; kind?: string; draftId?: string }

/** Only this importer reads legacy bodies. Each source survives until verified readback. */
export async function migrateLegacyDrafts(storage: Storage, api: DocumentDraftAPI): Promise<void> {
  const raw = storage.getItem(TAB_METADATA_KEY)
  const metadata: { version: number; state: { tabs?: LegacyTab[] } } = raw ? JSON.parse(raw) : { version: 5, state: {} }
  const tabs = metadata.state.tabs ?? []
  const items = new Map<string, { content: string; tab?: LegacyTab; key?: string }>()
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    const content = storage.getItem(key)
    if (content !== null) items.set(decodeURIComponent(key.slice(PREFIX.length)), { content, key })
  }
  for (const tab of tabs) {
    const existing = items.get(tab.id)
    if (existing) existing.tab = tab
    else if (metadata.version < 4 && tab.kind !== 'library' && (tab.isDirty || !tab.path) && typeof tab.content === 'string') {
      items.set(tab.id, { content: tab.content, tab })
    }
  }
  for (const [id, item] of items) {
    const hash = await contentHash(item.content)
    const migrationKey = `renderer-tab:${id}:${hash}`
    const receipts = unwrap(await api.importLegacy([{ tabId: id, migrationKey, contentHash: hash, content: item.content,
      ...(item.tab?.path ? { path: item.tab.path } : {}), title: item.tab?.title }]))
    const receipt = receipts.find(value => value.migrationKey === migrationKey)
    if (!receipt || receipt.contentHash !== hash) throw new Error('旧草稿迁移回执不一致，原文已保留')
    const readback = unwrap(await api.read(receipt.draftId))
    if (!readback || readback.content !== item.content || readback.contentHash !== hash || readback.revision !== receipt.revision) {
      throw new Error('旧草稿回读不一致，原文已保留')
    }
    if (item.tab) { item.tab.draftId = receipt.draftId; delete item.tab.content }
    // Save the binding before removing its separate body; retry uses the same import key.
    storage.setItem(TAB_METADATA_KEY, JSON.stringify(metadata))
    if (item.key) storage.removeItem(item.key)
  }
  for (const tab of tabs) delete tab.content
  metadata.version = 5
  storage.setItem(TAB_METADATA_KEY, JSON.stringify(metadata))
}
