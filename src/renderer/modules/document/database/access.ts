import { z } from 'zod'
import { DatabaseDefinitionSchema, UserStateSchema, type DatabaseReply, type DatabaseRequest } from '../../../../shared/document-database'
import type { PageNode } from '../../../../shared/document-pages'

export interface PageChoice { id: string; title: string; reference: string }
export interface DatabaseAPI {
  request(request: DatabaseRequest): Promise<DatabaseReply>
  pages(): Promise<PageChoice[]>
  openRow(id: string): Promise<void>
}
const row = z.object({ id: z.string(), title: z.string(), version: z.string(), values: z.record(z.string(), z.unknown()) })
const cell = z.discriminatedUnion('status', [
  z.object({ status: z.literal('value'), value: z.unknown() }),
  z.object({ status: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ status: z.literal('incomplete'), reasons: z.array(z.string()) }),
])
/** sourcePath: the row folder on disk, which the view watches while it is open. */
export const SnapshotSchema = z.object({ databaseId: z.string(), definition: DatabaseDefinitionSchema, version: z.string(), rows: z.array(row), sourcePath: z.string().optional() })
export const QuerySchema = z.object({
  databaseId: z.string(), version: z.string(), viewId: z.string(), type: z.string(),
  rows: z.array(row.extend({ cells: z.record(z.string(), cell) })), total: z.number(),
  groups: z.array(z.object({ value: z.unknown(), rowIds: z.array(z.string()) })),
  calculations: z.record(z.string(), cell), issues: z.array(z.object({ rowId: z.string(), fieldId: z.string(), cell })),
})
export const WriteSchema = z.object({ state: z.enum(['saved', 'unsaved']), afterVersion: z.string() })
export const CreatedSchema = z.object({ state: z.literal('committed'), objectId: z.string() })
export type Snapshot = z.infer<typeof SnapshotSchema>
export type Query = z.infer<typeof QuerySchema>
export type ViewRow = Query['rows'][number]
export type PersonalState = z.infer<typeof UserStateSchema>
export class DatabaseError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export async function request<T>(api: DatabaseAPI, input: DatabaseRequest, schema: z.ZodType<T>): Promise<T> {
  const reply = await api.request(input)
  if (!reply.ok) throw new DatabaseError(reply.code, reply.message)
  return schema.parse(reply.value)
}
export const databaseAPI: DatabaseAPI = {
  request: input => window.electronAPI.documentDatabase(input),
  pages: async () => {
    const vault = await window.electronAPI.vault.get()
    if (vault.status !== 'ready') throw new Error('请先打开资料库')
    const tree = await window.electronAPI.documentPages.tree({ path: vault.root, kind: 'vault' })
    if (!tree.ok) throw new Error(tree.message)
    const pages: PageChoice[] = []
    const visit = (node: PageNode) => {
      if (node.kind === 'page') pages.push({ id: node.objectId, title: node.title, reference: `[[${node.path.slice(vault.root.length + 1).replace(/\\/g, '/').replace(/\.md$/i, '')}]]` })
      node.children.forEach(visit)
    }
    visit(tree.value); return pages
  },
  openRow: async id => { const { openReadyRef } = await import('../../workbench/open-ready-ref'); await openReadyRef({ kind: 'page', id }) },
}

// A state write replaces the service record. Serialize read/merge/write across mounted views.
const personalWrites = new WeakMap<DatabaseAPI, Promise<unknown>>()
export function savePersonal(api: DatabaseAPI, databaseId: string, patch: PersonalState): Promise<PersonalState> {
  const next = (personalWrites.get(api) ?? Promise.resolve()).then(async () => {
    const state = await request(api, { type: 'getState', databaseId }, UserStateSchema)
    return request(api, { type: 'setState', databaseId, state: { ...state, ...patch, ...(patch.widths ? { widths: { ...state.widths, ...patch.widths } } : {}) } }, UserStateSchema)
  })
  personalWrites.set(api, next.catch(() => undefined)) // The caller receives and displays the original rejection.
  return next
}

export interface PendingBuffer { rowId: string; version: string; set: Record<string, unknown> }
type Change = { databaseId: string; origin: symbol }
const listeners = new Set<(api: DatabaseAPI, change: Change) => void>()
export const observeDatabase = (listener: (api: DatabaseAPI, change: Change) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const publishDatabase = (api: DatabaseAPI, change: Change) => { for (const listener of listeners) listener(api, change) }
