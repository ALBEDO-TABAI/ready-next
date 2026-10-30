import { z } from 'zod'
import type { AnchorLocation, DocumentAnchor } from './document-anchors'
import type { PageResult, PageReceipt } from './document-pages'
export const CommentThreadSchema = z.object({
  id: z.string().min(1), anchorId: z.string().min(1), resolved: z.boolean(),
  messages: z.array(z.object({ id: z.string().min(1), text: z.string().trim().min(1).max(20000), createdAt: z.number() }).strict()).min(1),
}).strict()
export const CommentsSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), threads: z.array(CommentThreadSchema) }).strict()
export type CommentThread = z.infer<typeof CommentThreadSchema>
export type CommentView = CommentThread & { location: AnchorLocation; quote: string; anchor: DocumentAnchor }
const base = { path: z.string().min(1), expectedRevision: z.number().int().nonnegative() }
export const AnnotationCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), path: z.string().min(1) }).strict(),
  z.object({ type: z.literal('add'), ...base, expectedVersion: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), text: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('edit'), ...base, threadId: z.string().min(1), messageId: z.string().min(1), text: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('reply'), ...base, threadId: z.string().min(1), text: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('resolve'), ...base, threadId: z.string().min(1), resolved: z.boolean() }).strict(),
  z.object({ type: z.literal('delete'), ...base, threadId: z.string().min(1) }).strict(),
])
export type AnnotationCommand = z.infer<typeof AnnotationCommandSchema>
export interface AnnotationSnapshot { objectId: string; revision: number; threads: CommentView[] }
export interface SyncedSnapshot { objectId: string; path: string; blockId: string; content: string; version: string }
export const TemplateCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('list') }).strict(),
  z.object({ type: z.literal('expand'), template: z.string().min(1), title: z.string(), targetPath: z.string().min(1), operationId: z.string().max(160).regex(/^[\w-]+$/) }).strict(),
  z.object({ type: z.literal('create'), template: z.string().min(1), title: z.string().min(1), operationId: z.string().max(160).regex(/^[\w-]+$/), parentPath: z.string().min(1) }).strict(),
])
export type TemplateCommand = z.infer<typeof TemplateCommandSchema>
export type TemplateResult = { kind: 'list'; templates: string[] } | { kind: 'expanded'; content: string } | { kind: 'created'; receipt: PageReceipt }
export interface DocumentAnnotationsAPI {
  comments(input: AnnotationCommand): Promise<PageResult<AnnotationSnapshot>>
  synced(input: { path: string; raw: string }): Promise<PageResult<SyncedSnapshot>>
  templates(input: TemplateCommand): Promise<PageResult<TemplateResult>>
}
