import { z } from 'zod'

export const readyMemoryCategorySchema = z.enum([
  'preference', 'fact', 'project', 'workflow', 'other',
])

export type ReadyMemoryCategory = z.infer<typeof readyMemoryCategorySchema>

export const readyMemoryEntryViewSchema = z.object({
  entryId: z.string().min(1),
  category: readyMemoryCategorySchema,
  content: z.string().min(1).max(16_000),
  origin: z.enum(['manual', 'consolidated']),
  confidence: z.number().min(0).max(1),
  pinned: z.boolean(),
  status: z.enum(['active', 'superseded', 'expired']),
  expiresAt: z.string().datetime().nullable(),
  sourceRefs: z.array(z.string().min(1)).max(32),
  lastUsedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export type ReadyMemoryEntryView = z.infer<typeof readyMemoryEntryViewSchema>

export const readyMemoryViewSchema = z.object({
  useMemories: z.boolean(),
  generateMemories: z.boolean(),
  automaticGenerationAvailable: z.boolean(),
  conversationId: z.string().min(1).nullable(),
  contributeToMemories: z.boolean().nullable(),
  entries: z.array(readyMemoryEntryViewSchema).max(1_000),
  pendingGenerationJobs: z.number().int().nonnegative(),
  unresolvedGenerationJobs: z.number().int().nonnegative(),
}).strict()

export type ReadyMemoryView = z.infer<typeof readyMemoryViewSchema>

export const readyMemoryReadRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
}).strict()

export const readyMemoryGlobalPolicyRequestSchema = z.object({
  useMemories: z.boolean().optional(),
  generateMemories: z.boolean().optional(),
  acknowledgeModelCost: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (value.useMemories === undefined && value.generateMemories === undefined) {
    context.addIssue({ code: 'custom', message: 'ready_memory_policy_empty' })
  }
  if (value.generateMemories === true && value.acknowledgeModelCost !== true) {
    context.addIssue({ code: 'custom', message: 'ready_memory_cost_ack_required' })
  }
})

export const readyMemoryConversationPolicyRequestSchema = z.object({
  conversationId: z.string().min(1),
  contributeToMemories: z.boolean(),
}).strict()

export const readyMemoryAddRequestSchema = z.object({
  category: readyMemoryCategorySchema,
  content: z.string().trim().min(1).max(16_000),
  pinned: z.boolean().optional(),
}).strict()

export const readyMemoryUpdateRequestSchema = z.object({
  entryId: z.string().min(1),
  category: readyMemoryCategorySchema,
  content: z.string().trim().min(1).max(16_000),
}).strict()

export const readyMemoryPinRequestSchema = z.object({
  entryId: z.string().min(1),
  pinned: z.boolean(),
}).strict()

export const readyMemoryDeleteRequestSchema = z.object({
  entryId: z.string().min(1),
}).strict()

export const readyMemoryResetRequestSchema = z.object({
  confirm: z.literal(true),
}).strict()

export type ReadyMemoryReadRequest = z.infer<typeof readyMemoryReadRequestSchema>
export type ReadyMemoryGlobalPolicyRequest = z.infer<typeof readyMemoryGlobalPolicyRequestSchema>
export type ReadyMemoryConversationPolicyRequest = z.infer<typeof readyMemoryConversationPolicyRequestSchema>
export type ReadyMemoryAddRequest = z.infer<typeof readyMemoryAddRequestSchema>
export type ReadyMemoryUpdateRequest = z.infer<typeof readyMemoryUpdateRequestSchema>
export type ReadyMemoryPinRequest = z.infer<typeof readyMemoryPinRequestSchema>
export type ReadyMemoryDeleteRequest = z.infer<typeof readyMemoryDeleteRequestSchema>
export type ReadyMemoryResetRequest = z.infer<typeof readyMemoryResetRequestSchema>
