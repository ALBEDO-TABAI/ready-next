import { z } from 'zod'

export const PageRootSchema = z.object({ path: z.string().min(1), kind: z.enum(['vault', 'external']) }).strict()
export type PageRoot = z.infer<typeof PageRootSchema>
export interface PageNode {
  objectId: string; revision: number; path: string; name: string
  kind: 'vault' | 'page' | 'folder' | 'canvas' | 'file'
  title: string; icon?: string; cover?: string; assetsPath?: string
  ambiguity?: string; children: PageNode[]; hasChildren: boolean; position: number
}
export const PagePropertiesSchema = z.object({
  title: z.string().optional(), icon: z.string().optional(), cover: z.string().optional(),
  ready_page: z.object({ font: z.enum(['sans', 'serif', 'mono']).optional(), small_text: z.boolean().optional(),
    full_width: z.boolean().optional(), cover_y: z.number().min(0).max(1).optional() }).strict().optional(),
}).strict()
export type PageProperties = z.infer<typeof PagePropertiesSchema>
const base = { operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/), root: z.string().min(1) }
const target = { parentObjectId: z.string().min(1).optional(), parentPath: z.string().min(1).optional() }
export const PageOperationSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('create'), ...target, title: z.string(), content: z.string().default('') }).strict(),
  z.object({ ...base, type: z.literal('rename'), objectId: z.string().min(1), title: z.string() }).strict(),
  z.object({ ...base, type: z.literal('move'), objectId: z.string().min(1), ...target }).strict(),
  z.object({ ...base, type: z.literal('trash'), objectId: z.string().min(1) }).strict(),
  z.object({ ...base, type: z.literal('restore'), objectId: z.string().min(1), ...target }).strict(),
  z.object({ ...base, type: z.literal('delete'), objectId: z.string().min(1) }).strict(),
])
export type PageOperation = z.input<typeof PageOperationSchema>
export interface PageReceipt { operationId: string; state: 'committed'; objectId: string; revision: number; path: string | null }
export interface PageTrashEntry extends PageReceipt { originalPath: string; trashedPath: string; title: string; parentObjectId: string | null }
export interface PageChange { operationId: string; objectId: string; revision: number }
export type PageTreeChange = PageChange | { type: 'tree_invalidated'; paths: string[] }
export interface PageUserState { objectId: string; favorite: boolean; lastVisitedAt: number | null }
export interface PageOperationRecord { operationId: string; state: 'prepared' | 'committed' | 'rolled_back' | 'recovery_required'; receipt: PageReceipt | null; error: string | null }
export type PageResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string; candidateNames?: string[] }
export interface DocumentPagesAPI {
  tree(root: PageRoot): Promise<PageResult<PageNode>>
  properties(objectId: string): Promise<PageResult<{ properties: PageProperties; version: string }>>
  patchProperties(objectId: string, expectedVersion: string, set: PageProperties, remove?: (keyof PageProperties)[]): Promise<PageResult<{ version: string }>>
  operate(input: PageOperation): Promise<PageResult<PageReceipt>>
  operation(operationId: string): Promise<PageResult<PageOperationRecord | null>>
  trash(root: string): Promise<PageResult<PageTrashEntry[]>>
  order(parentObjectId: string, objectIds: string[]): Promise<PageResult<void>>
  favorite(objectId: string, value: boolean): Promise<PageResult<void>>
  visit(objectId: string): Promise<PageResult<void>>
  states(): Promise<PageResult<PageUserState[]>>
  save(input: { path: string; content: string; expectedVersion: string }): Promise<PageResult<{ path: string; beforeVersion: string; afterVersion: string; committedAt: number }>>
  onChanged(listener: (event: PageTreeChange) => void): () => void
}
