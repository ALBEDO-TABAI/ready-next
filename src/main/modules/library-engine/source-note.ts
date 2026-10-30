import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { LIBRARY_FIELDS as F, LIBRARY_KIND_BOOK, type LibraryBook } from '../../../shared/library'
import { readDocumentSource } from '../../../shared/document-operations'
import { formats, statusSchema, topicSchema } from './validation'

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (isMissing(error)) return false; throw error }
}

export async function insideVault(root: string, path: string): Promise<string> {
  const canonical = await realpath(path)
  const rel = relative(await realpath(root), canonical)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文件超出资料库范围')
  return canonical
}

// Dates are human-facing frontmatter: an ISO date-time with offset, or a plain YYYY-MM-DD (local midnight).
const timestamp = z.union([
  z.string().datetime({ offset: true }).transform(value => Date.parse(value)),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform(value => new Date(`${value}T00:00:00`).getTime()),
])
const fieldsSchema = z.object({
  [F.id]: z.string().min(1), [F.kind]: z.literal(LIBRARY_KIND_BOOK),
  title: z.string().min(1).optional(),
  [F.author]: z.string(), [F.topic]: topicSchema, [F.tags]: z.array(z.string()), [F.status]: statusSchema,
  [F.file]: z.string().min(1), [F.cover]: z.string().min(1).optional(),
  [F.year]: z.number().int().optional(), [F.publisher]: z.string().optional(), [F.language]: z.string().optional(),
  [F.words]: z.number().int().nonnegative().optional(), [F.addedAt]: timestamp, [F.finishedAt]: timestamp.optional(),
  [F.source]: z.object({ kind: z.enum(['local', 'zlib', 'treasure']), ref: z.string().optional(), url: z.string().optional() }),
})

export async function readBook(root: string, notePath: string): Promise<LibraryBook | null> {
  await insideVault(root, notePath)
  if ((await lstat(notePath)).isSymbolicLink()) throw new Error('来源页不能是符号链接')
  const { frontmatter } = readDocumentSource(await readFile(notePath, 'utf8'))
  if (frontmatter[F.kind] !== LIBRARY_KIND_BOOK) return null
  const fields = fieldsSchema.parse(frontmatter)
  const asset = async (path: string) => {
    const resolved = await insideVault(root, resolve(dirname(notePath), path))
    if (!(await lstat(resolved)).isFile()) throw new Error('书籍附件不是文件')
    return resolved
  }
  const filePath = await asset(fields[F.file])
  const cover = fields[F.cover]
  return {
    id: fields[F.id], title: fields.title ?? basename(notePath, extname(notePath)),
    author: fields[F.author], topic: fields[F.topic], tags: fields[F.tags], status: fields[F.status],
    year: fields[F.year], publisher: fields[F.publisher], language: fields[F.language],
    words: fields[F.words], addedAt: fields[F.addedAt], finishedAt: fields[F.finishedAt], source: fields[F.source],
    notePath, filePath, coverPath: cover ? await asset(cover) : undefined,
    format: z.enum(formats).parse(extname(filePath).slice(1).toLowerCase()),
  }
}
