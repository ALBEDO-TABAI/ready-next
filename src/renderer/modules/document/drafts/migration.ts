import type { DocumentDraftAPI, DraftResult } from '../../../../shared/document-drafts'
import { z } from 'zod'

export const TAB_METADATA_KEY = 'ready-doc-tabs-v2'
export const LEGACY_HANDOFF_KEY = 'ready-legacy-draft-handoff-v1'
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
const metadataSchema = z.object({
  version: z.number(),
  state: z.object({ tabs: z.array(z.object({
    id: z.string(), path: z.string().nullable().optional(), title: z.string().optional(),
    content: z.string().optional(), isDirty: z.boolean().optional(), kind: z.string().optional(),
  }).passthrough()).optional() }).passthrough(),
}).passthrough()
const handoffSchema = z.object({ version: z.literal(1), metadata: z.string().nullable(), drafts: z.record(z.string(), z.string()) })
type LegacyTab = NonNullable<z.infer<typeof metadataSchema>['state']['tabs']>[number]
type Handoff = z.infer<typeof handoffSchema>

function writeHandoff(storage: Storage, handoff: Handoff): void {
  const raw = JSON.stringify(handoff)
  storage.setItem(LEGACY_HANDOFF_KEY, raw)
  if (storage.getItem(LEGACY_HANDOFF_KEY) !== raw) throw new Error('旧草稿交接回读不一致，原文已保留')
}

/** Runs before the store exists. No metadata writer may destroy the only body. */
export function captureLegacyDrafts(storage: Storage): void {
  const existing = storage.getItem(LEGACY_HANDOFF_KEY)
  const handoff: Handoff = existing !== null ? handoffSchema.parse(JSON.parse(existing)) : {
    version: 1, metadata: storage.getItem(TAB_METADATA_KEY), drafts: {},
  }
  const metadata = handoff.metadata === null ? null : metadataSchema.parse(JSON.parse(handoff.metadata))
  if (existing === null) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(PREFIX)) {
        const content = storage.getItem(key)
        if (content !== null) handoff.drafts[key] = content
      }
    }
    if (!Object.keys(handoff.drafts).length && !metadata?.state.tabs?.some(tab => typeof tab.content === 'string')) return
    writeHandoff(storage, handoff)
  }
  // Once the copy is verified, retire the old sources synchronously. A crash
  // here leaves the handoff intact; retry only cleans sources still identical.
  if (metadata && storage.getItem(TAB_METADATA_KEY) === handoff.metadata) {
    for (const tab of metadata.state.tabs ?? []) delete tab.content
    storage.setItem(TAB_METADATA_KEY, JSON.stringify(metadata))
  }
  for (const [key, content] of Object.entries(handoff.drafts)) {
    if (storage.getItem(key) === content) storage.removeItem(key)
  }
}

/** Async migration owns only the handoff, never the live tab metadata. */
export async function migrateLegacyDrafts(storage: Storage, api: DocumentDraftAPI): Promise<void> {
  const raw = storage.getItem(LEGACY_HANDOFF_KEY)
  if (raw === null) return
  const handoff = handoffSchema.parse(JSON.parse(raw))
  const metadata = handoff.metadata === null ? { version: 5, state: { tabs: [] } } : metadataSchema.parse(JSON.parse(handoff.metadata))
  const tabs = metadata.state.tabs ?? []
  const items = new Map<string, { content: string; tab?: LegacyTab; key?: string }>()
  for (const [key, content] of Object.entries(handoff.drafts)) {
    if (!key.startsWith(PREFIX)) throw new Error('旧草稿交接键无效，原文已保留')
    items.set(decodeURIComponent(key.slice(PREFIX.length)), { content, key })
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
    if (!readback || readback.tabId !== id || readback.content !== item.content || readback.contentHash !== hash || readback.revision !== receipt.revision) {
      throw new Error('旧草稿回读不一致，原文已保留')
    }
    if (item.tab) delete item.tab.content
    if (item.key) delete handoff.drafts[item.key]
    handoff.metadata = JSON.stringify(metadata)
    writeHandoff(storage, handoff)
  }
  storage.removeItem(LEGACY_HANDOFF_KEY)
}
