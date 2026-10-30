import { z } from 'zod'
import { colorSchema, offsetSchema } from './highlight-anchors'
import { topicSchema, formats } from './validation'

const progress = z.object({ chapter: offsetSchema, offset: offsetSchema, pct: z.number().min(0).max(1), at: offsetSchema }).strict()
const bookmark = z.object({ chapter: offsetSchema, offset: offsetSchema, label: z.string(), at: offsetSchema }).strict()
const highlight = z.object({ id: z.string().min(1), chapter: offsetSchema, from: offsetSchema, to: offsetSchema,
  text: z.string().refine(s => !!s.trim()), color: colorSchema, note: z.string().optional(), at: offsetSchema }).strict().refine(h => h.to > h.from)
const book = z.object({
  id: z.string().regex(/^[\w-]+$/), title: z.string().min(1), author: z.string(),
  year: z.number().int().optional(), publisher: z.string().optional(), language: z.string().optional(), description: z.string().optional(),
  topic: topicSchema.optional(), tags: z.array(z.string()), favorite: z.boolean().optional(),
  source: z.enum(['local', 'zlib', 'treasure']), sourceRef: z.string().optional(), sourceUrl: z.string().optional(), formats: z.array(z.string()).optional(),
  file: z.object({ name: z.string(), ext: z.enum(formats), size: offsetSchema }).strict().optional(), cover: z.literal('file').optional(),
  status: z.enum(['ready', 'wish', 'error']), addedAt: offsetSchema, openedAt: offsetSchema.optional(), finishedAt: offsetSchema.optional(), words: offsetSchema.optional(),
  progress: progress.optional(), bookmarks: z.array(bookmark).optional(), highlights: z.array(highlight).refine(items => new Set(items.map(h => h.id)).size === items.length, '重复划线 id').optional(),
}).strict()
export const archiveSchema = z.object({ version: z.literal(1), books: z.array(book).refine(items => new Set(items.map(b => b.id)).size === items.length, '重复书籍 id') }).strict()
export type ArchiveBook = z.infer<typeof book>
