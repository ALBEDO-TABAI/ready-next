import { z } from 'zod'

export const thirdPartyNoticesSchema = z.array(z.object({
  name: z.string().min(1),
  version: z.string().nullable(),
  license: z.string().nullable(),
  repository: z.string().nullable(),
  texts: z.array(z.object({ path: z.string(), content: z.string() })),
  notes: z.array(z.string()),
  textMissing: z.boolean(),
  kind: z.enum(['npm', 'manual']),
}))

export type ThirdPartyNotice = z.infer<typeof thirdPartyNoticesSchema>[number]
export type ThirdPartyNoticesResult =
  | { ok: true; notices: ThirdPartyNotice[] }
  | { ok: false; reason: 'not_generated' }
