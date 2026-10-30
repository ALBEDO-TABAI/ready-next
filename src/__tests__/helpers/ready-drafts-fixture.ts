import type { DocumentDraft, DocumentDraftAPI, DraftCreate, DraftReceipt } from '../../shared/document-drafts'
import type { DraftPort } from '../../renderer/modules/document/drafts/controller'
import type { DocTab } from '../../renderer/stores/useDocTabs'
import { contentHash } from '../../renderer/modules/document/drafts/migration'

export function createDraftFixture() {
  let counter = 0
  let createGate: { started(): void; wait: Promise<void> } | undefined
  const values = new Map<string, string>()
  const imports = new Map<string, DraftReceipt>()
  const f = {
    tabs: [{ id: 'tab', path: null, title: 'Test', content: '', isDirty: false }] as DocTab[],
    drafts: new Map<string, DocumentDraft>(), saved: [] as string[], discarded: [] as string[], failImport: false,
    storage: { get length() { return values.size }, key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) }, clear: () => values.clear() } satisfies Storage,
    holdCreate() {
      let release!: () => void; let started!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      const signal = new Promise<void>(resolve => { started = resolve })
      createGate = { started, wait }
      return { release, started: signal }
    },
    api: undefined! as DocumentDraftAPI,
    port: undefined! as DraftPort,
  }
  const receipt = (draft: DocumentDraft): DraftReceipt => ({ draftId: draft.draftId, revision: draft.revision, contentHash: draft.contentHash })
  const create = async (input: DraftCreate) => {
    if (createGate) { const gate = createGate; createGate = undefined; gate.started(); await gate.wait }
    const draft: DocumentDraft = { ...input, tabId: input.tabId ?? null, draftId: `draft-${++counter}`, revision: Math.max(0, ...[...f.drafts.values()].filter(d => d.tabId === input.tabId).map(d => d.revision)) + 1, contentHash: await contentHash(input.content),
      objectId: input.origin === 'document' ? input.objectId : null, baseVersion: input.origin === 'document' ? input.baseVersion : null,
      sourceCanvas: null, suggestedParent: null, attachments: [], title: input.title ?? '', state: 'editing', finalize: null, createdAt: 1, updatedAt: 1 }
    f.drafts.set(draft.draftId, draft)
    return { ok: true as const, value: receipt(draft) }
  }
  f.api = {
    create,
    save: async (id, revision, content, tabId) => {
      const draft = f.drafts.get(id)!
      if (draft.revision !== revision) return { ok: false, code: 'revision_conflict', message: 'revision changed' }
      const next = { ...draft, tabId, revision: revision + 1, content, contentHash: await contentHash(content) }
      f.drafts.set(id, next); f.saved.push(content)
      return { ok: true, value: receipt(next) }
    },
    read: async id => ({ ok: true, value: f.drafts.get(id) ?? null }),
    list: async tabId => ({ ok: true, value: [...f.drafts.values()].filter(d => tabId === undefined ? d.state === 'editing' || d.state === 'conflict' : d.tabId === tabId).sort((a, b) => b.revision - a.revision || Number(!['editing', 'conflict'].includes(a.state)) - Number(!['editing', 'conflict'].includes(b.state))) }),
    discard: async (id, revision) => {
      const draft = f.drafts.get(id)!
      if (draft.revision !== revision) return { ok: false, code: 'revision_conflict', message: 'revision changed' }
      f.drafts.set(id, { ...draft, state: 'discarded', revision: revision + 1 }); f.discarded.push(id)
      return { ok: true, value: { ...receipt(draft), revision: revision + 1 } }
    },
    finalize: async (id, revision, input) => ({ ok: true, value: { ...receipt(f.drafts.get(id)!), revision, objectId: 'object', path: '/vault/Test.md', operationId: input.operationId, parentObjectId: null } }),
    importLegacy: async items => {
      if (f.failImport) return { ok: false, code: 'failed', message: 'interrupted' }
      const result = []
      for (const item of items) {
        let saved = imports.get(item.migrationKey)
        if (!saved) { saved = (await create({ tabId: item.tabId, origin: 'new', vaultRoot: '/vault', content: item.content })).value; imports.set(item.migrationKey, saved) }
        result.push({ ...saved, migrationKey: item.migrationKey })
      }
      return { ok: true, value: result }
    },
  }
  f.port = { api: () => f.api, tabs: () => f.tabs, root: async () => '/vault', locate: async () => '/vault/Test.md', resolve: async () => 'object', read: async () => [...f.drafts.values()].at(-1)?.content ?? '', notify: () => {},
    patch: (id, patch) => { f.tabs = f.tabs.map(tab => tab.id === id ? { ...tab, ...patch } as DocTab : tab) } }
  return f
}
