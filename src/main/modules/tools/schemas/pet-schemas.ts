import { z } from 'zod'

const PetStickyToneSchema = z.enum(['default', 'info', 'success', 'warning', 'danger'])

export const PetShowStickyNoteSchema = z.object({
  title: z.string().max(36).optional().describe('可选，便利贴标题，建议 12 字以内'),
  body: z.string().min(1).max(1200).describe('要贴到宠物旁边的正文。用户要求整理或生成时，可以先组织成简洁便利贴内容再贴上去。'),
  tone: PetStickyToneSchema.optional().describe('便利贴语气/颜色：default, info, success, warning, danger'),
  enablePet: z.boolean().optional().describe('默认 true；为 true 时如果宠物未显示，会先显示宠物。'),
})

export const PetDismissStickyNoteSchema = z.object({
  id: z.string().min(1).describe('要关闭的便利贴 id'),
})

export const PetClearStickyNotesSchema = z.object({})

export type PetToolName =
  | 'pet_show_sticky_note'
  | 'pet_dismiss_sticky_note'
  | 'pet_clear_sticky_notes'

export const PET_SCHEMAS: Record<PetToolName, z.ZodObject<z.ZodRawShape>> = {
  pet_show_sticky_note: PetShowStickyNoteSchema,
  pet_dismiss_sticky_note: PetDismissStickyNoteSchema,
  pet_clear_sticky_notes: PetClearStickyNotesSchema,
}
