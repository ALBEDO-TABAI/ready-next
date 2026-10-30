import { z } from 'zod'

const id = z.string().min(1)
export const DraftRevisionSchema = z.number().int().positive()
export const DraftIdSchema = id
export const DraftHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const DraftAttachmentSchema = z.object({ sourcePath: id, name: id, contentHash: DraftHashSchema }).strict()
// Main page creation has no tab; Renderer IPC requires a non-null tabId.
const common = {
  tabId: id.nullable().default(null), vaultRoot: id, content: z.string(), title: z.string().default(''), suggestedParent: id.nullable().default(null),
  attachments: z.array(DraftAttachmentSchema).default([]),
}
export const DraftCreateSchema = z.discriminatedUnion('origin', [
  z.object({ ...common, origin: z.literal('new') }).strict(),
  z.object({ ...common, origin: z.literal('document'), objectId: id, baseVersion: DraftHashSchema }).strict(),
  z.object({ ...common, origin: z.literal('canvas'), sourceCanvas: z.object({ objectId: id, nodeId: id }).strict() }).strict(),
])
export type DraftCreate = z.input<typeof DraftCreateSchema>
export const DraftReceiptSchema = z.object({ draftId: id, revision: DraftRevisionSchema, contentHash: DraftHashSchema })
export type DraftReceipt = z.infer<typeof DraftReceiptSchema>
export const DraftFinalizeInputSchema = z.object({
  parentObjectId: id.optional(), parentPath: id.optional(), title: z.string(), operationId: id,
}).strict().refine(value => Number(value.parentObjectId !== undefined) + Number(value.parentPath !== undefined) === 1, 'Exactly one parent is required')
export type DraftFinalizeInput = z.infer<typeof DraftFinalizeInputSchema>
export const DraftFinalizeReceiptSchema = DraftReceiptSchema.extend({ operationId: id, objectId: id, path: id, parentObjectId: id.nullable() })
export type DraftFinalizeReceipt = z.infer<typeof DraftFinalizeReceiptSchema>
export const DraftFinalizeIntentSchema = z.object({
  request: DraftFinalizeInputSchema, path: id, parentObjectId: id.nullable(), directory: id,
  stagingDirectory: id, content: z.string(), contentHash: DraftHashSchema,
  files: z.array(z.object({ path: id, stagePath: id, contentHash: DraftHashSchema, sourcePath: id.nullable() })),
  receipt: DraftFinalizeReceiptSchema.nullable(),
})
export type DraftFinalizeIntent = z.infer<typeof DraftFinalizeIntentSchema>
export const DocumentDraftSchema = z.object({
  draftId: id, tabId: id.nullable(), vaultRoot: id, revision: DraftRevisionSchema, content: z.string(), contentHash: DraftHashSchema,
  origin: z.enum(['new', 'document', 'canvas']), objectId: id.nullable(), baseVersion: DraftHashSchema.nullable(),
  suggestedParent: id.nullable(), sourceCanvas: z.object({ objectId: id, nodeId: id }).nullable(),
  attachments: z.array(DraftAttachmentSchema), title: z.string(),
  state: z.enum(['editing', 'finalizing', 'finalized', 'conflict', 'discarded']),
  finalize: DraftFinalizeIntentSchema.nullable(), createdAt: z.number(), updatedAt: z.number(),
}).superRefine((draft, ctx) => {
  if ((draft.origin === 'document') !== (draft.objectId !== null && draft.baseVersion !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Document drafts require an object and base version' })
  }
  if ((draft.state === 'finalizing' && !draft.finalize) || (draft.state === 'finalized' && !draft.finalize?.receipt)) {
    ctx.addIssue({ code: 'custom', message: 'Finalization state requires durable intent or receipt' })
  }
})
export type DocumentDraft = z.infer<typeof DocumentDraftSchema>
export const LegacyDraftItemSchema = z.object({ tabId: id, migrationKey: id, contentHash: DraftHashSchema, content: z.string(), path: id.optional(), title: z.string().optional() }).strict()
export type LegacyDraftItem = z.infer<typeof LegacyDraftItemSchema>
export type LegacyDraftReceipt = DraftReceipt & { migrationKey: string }
export type DraftResult<T> = { ok: true; value: T } | {
  ok: false; code: string; message: string; candidateNames?: string[]; receipt?: DraftReceipt
}
export interface DocumentDraftAPI {
  create(input: DraftCreate & { tabId: string }): Promise<DraftResult<DraftReceipt>>
  save(draftId: string, expectedRevision: number, content: string, tabId: string): Promise<DraftResult<DraftReceipt>>
  list(tabId?: string): Promise<DraftResult<DocumentDraft[]>>
  read(draftId: string): Promise<DraftResult<DocumentDraft | null>>
  discard(draftId: string, expectedRevision: number): Promise<DraftResult<DraftReceipt>>
  finalize(draftId: string, expectedRevision: number, input: DraftFinalizeInput): Promise<DraftResult<DraftFinalizeReceipt>>
  importLegacy(items: LegacyDraftItem[]): Promise<DraftResult<LegacyDraftReceipt[]>>
}
