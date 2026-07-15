import type { ZodObject, ZodRawShape } from 'zod'
import { z } from 'zod'

const ReferenceImageOrdersSchema = z.array(z.number().int().positive()).max(8).superRefine((orders, context) => {
  for (let index = 1; index < orders.length; index += 1) {
    if (orders[index] <= orders[index - 1]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'reference_image_orders must be strictly increasing',
      })
      return
    }
  }
})

export const GenerateImageSchema = z.object({
  prompt: z.string().trim().min(1).max(10_000),
  service_id: z.string().trim().min(1).max(200).optional(),
  reference_image_orders: ReferenceImageOrdersSchema.optional(),
  size: z.string().trim().min(1).max(40).optional(),
  aspect_ratio: z.string().trim().min(1).max(20).optional(),
  image_size: z.string().trim().min(1).max(20).optional(),
}).strict()

export const IMAGE_GENERATION_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  generate_image: GenerateImageSchema as unknown as ZodObject<ZodRawShape>,
}
