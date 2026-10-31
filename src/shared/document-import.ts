import { z } from 'zod'

export const ImportKindSchema = z.enum(['notion', 'inkwell'])
export type ImportKind = z.infer<typeof ImportKindSchema>
export const ImportTargetSchema = z.object({ parentPath: z.string().min(1), title: z.string().min(1).max(120) }).strict()
export const ImportLocationSchema = z.object({ parentPath: z.string().min(1).optional(), parentObjectId: z.string().min(1).optional(), title: z.string().min(1).max(120) }).strict().refine(value => Number(!!value.parentPath) + Number(!!value.parentObjectId) === 1, 'Exactly one parent required')
export type ImportLocation = z.infer<typeof ImportLocationSchema>
export type ImportTarget = z.infer<typeof ImportTargetSchema>
export interface ImportIssue { kind: 'missing' | 'unsupported' | 'renamed' | 'conflict'; item: string; message: string }
export interface ImportReport {
  id: string; sourceName: string; sourceHash: string; target?: ImportTarget
  counts: { pages: number; databases: number; rows: number; attachments: number }
  pages: { source: string; path: string; database: boolean; row: boolean }[]
  issues: ImportIssue[]
}
export interface ImportStatus {
  id: string; state: 'prepared' | 'running' | 'interrupted' | 'completed' | 'incomplete'
  done: number; total: number; issues: ImportIssue[]; error?: string
  results: { objectId: string; path: string; database: boolean }[]
}
export type ImportReply<T> = { ok: true; value: T } | { ok: false; message: string }
export interface DocumentImportAPI {
  choose(kind: ImportKind): Promise<ImportReply<{ sourceId: string; name: string } | null>>
  preflight(sourceId: string, target?: ImportLocation): Promise<ImportReply<ImportReport>>
  execute(reportId: string): Promise<ImportReply<ImportStatus>>
  resume(operationId: string): Promise<ImportReply<ImportStatus>>
  status(operationId: string): Promise<ImportReply<ImportStatus>>
  list(): Promise<ImportReply<ImportStatus[]>>
}
