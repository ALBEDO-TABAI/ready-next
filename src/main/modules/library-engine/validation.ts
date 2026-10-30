import { z } from 'zod'
import { TOPICS } from '../../../shared/library-topics'

export const bookIdSchema = z.string().trim().min(1)
export const formats = ['epub', 'txt', 'md', 'pdf', 'mobi', 'azw3', 'fb2', 'cbz', 'djvu'] as const
export const statusSchema = z.enum(['想读', '在读', '读完'])
export const topicSchema = z.string().refine(value => TOPICS.some(topic => topic.key === value), '未知书房分类')
const nonnegative = z.number().int().nonnegative()
export const positionSchema = z.object({ bookId: bookIdSchema, chapter: nonnegative, offset: nonnegative, pct: z.number().min(0).max(1), updatedAt: nonnegative }).strict()
export const bookmarksSchema = z.array(z.object({ id: bookIdSchema, chapter: nonnegative, offset: nonnegative, label: z.string(), createdAt: nonnegative }).strict())
  .refine(items => new Set(items.map(item => item.id)).size === items.length, '书签 id 重复')
export const bookmarkInputSchema = z.object({ bookId: bookIdSchema, bookmarks: bookmarksSchema }).strict()
export const updateSchema = z.object({
  id: bookIdSchema,
  patch: z.object({ title: z.string(), author: z.string(), topic: topicSchema, tags: z.array(z.string()), status: statusSchema }).partial().strict(),
}).strict()
export const importSchema = z.array(z.string().min(1))
