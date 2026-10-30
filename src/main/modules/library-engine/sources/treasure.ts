import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { SourceHit } from '../../../../shared/library-sources'
export const TREASURE_SENTINEL = 'READY_OPTIONAL_TREASURE_IMPLEMENTATION_V1'
const mirrors = [
  'https://jbiaojerry.github.io/ebook-treasure-chest/all-books.json',
  'https://cdn.jsdelivr.net/gh/jbiaojerry/ebook-treasure-chest@main/docs/all-books.json',
  'https://raw.githubusercontent.com/jbiaojerry/ebook-treasure-chest/main/docs/all-books.json',
]
const rawSchema = z.array(z.object({ title: z.string().min(1), author: z.string().default(''), category: z.string().default(''), link: z.string().url() }))
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '')
type Entry = SourceHit & { categories: string[] }
export class TreasureIndex {
  private loading?: Promise<Entry[]>
  constructor(private readonly cache: string, private readonly request: typeof fetch = fetch) {}
  private load(): Promise<Entry[]> {
    if (!this.loading) this.loading = this.read().catch(error => { this.loading = undefined; throw error })
    return this.loading
  }
  private async read(): Promise<Entry[]> {
    const file = join(this.cache, 'treasure-all-books.json')
    let raw: z.infer<typeof rawSchema> | undefined
    try { raw = rawSchema.parse(JSON.parse(await readFile(file, 'utf8'))) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (!raw) {
      const errors: string[] = []
      for (const url of mirrors) {
        try {
          const response = await this.request(url, { signal: AbortSignal.timeout(45_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          raw = rawSchema.parse(await response.json())
          await mkdir(this.cache, { recursive: true })
          await writeFile(`${file}.tmp`, JSON.stringify(raw)); await rename(`${file}.tmp`, file)
          break
        } catch (error) { errors.push(String(error)) }
      }
      if (!raw) throw new Error(`${TREASURE_SENTINEL}: 无法下载索引：${errors.join('; ')}`)
    }
    const books = new Map<string, Entry>()
    for (const row of raw) {
      const hit = books.get(row.link)
      if (hit) { if (row.category && !hit.categories.includes(row.category)) hit.categories.push(row.category) }
      else books.set(row.link, { source: 'treasure', ref: row.link, title: row.title, author: row.author, format: 'epub', categories: row.category ? [row.category] : [] })
    }
    return [...books.values()]
  }
  async categories(): Promise<string[]> { return [...new Set((await this.load()).flatMap(book => book.categories))].sort() }
  async search(query: string, category: string): Promise<SourceHit[]> {
    const words = query.split(/\s+/).map(norm).filter(Boolean)
    return (await this.load()).filter(book => (!category || book.categories.includes(category)) && words.every(word => norm(`${book.title} ${book.author} ${book.categories.join(' ')}`).includes(word)))
      .sort((a, b) => Number(norm(b.title) === norm(query)) - Number(norm(a.title) === norm(query)) || a.title.length - b.title.length)
      .slice(0, 100).map(({ categories: _categories, ...book }) => book)
  }
}
