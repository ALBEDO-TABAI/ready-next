import { constants, copyFileSync, readFileSync, unlinkSync } from 'node:fs'
import { readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { RSSContentStore } from '../database/rss-content-store'
import { sanitizeNoteFileName } from '../clipping/preset-renderer'
import { buildRSSNote } from '../../../shared/rss-note-markdown'
import { RSSQuerySchema, RSSSaveNoteSchema, type RSSQueryInput, type RSSQueryExportResult, type RSSSaveNoteInput, type RSSNoteSaveResult } from '../../../shared/rss-workspace'

/** Stage and read back once, then publish without replacing any existing file. */
async function writeNewText(folder: string, stem: string, extension: string, text: string, assertCurrent: () => void): Promise<string> {
  const directory = await realpath(folder)
  if (!(await stat(directory)).isDirectory()) throw new Error('请选择有效的保存文件夹。')
  const base = Array.from(sanitizeNoteFileName(stem)).slice(0, 48).join('')
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (await readFile(temporary, 'utf8') !== text) throw new Error('文件读回校验失败，未发布保存结果。')
    assertCurrent()
    // No async gap between revision validation and publishing the complete file.
    for (let index = 0; index < 200; index++) {
      const path = join(directory, `${base}${index ? `-${index + 1}` : ''}.${extension}`)
      try {
        copyFileSync(temporary, path, constants.COPYFILE_EXCL)
        try {
          if (readFileSync(path, 'utf8') !== text) throw new Error('保存文件的读回内容不一致。')
        } catch (error) {
          try { unlinkSync(path) }
          catch { throw new Error(`文件保存未确认，且未能清理新文件，请检查：${path}`) }
          throw error
        }
        return path
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new Error('同名文件过多，请选择其他文件夹。')
  } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') console.warn('[rss-files] 临时文件清理失败', error.code) }) }
}

export class RSSWorkspaceFiles {
  constructor(private readonly content: RSSContentStore) {}

  async saveNote(input: RSSSaveNoteInput, chooseDirectory: () => Promise<string | null>): Promise<RSSNoteSaveResult> {
    const params = RSSSaveNoteSchema.parse(input)
    const read = () => {
      const article = this.content.getArticle(params.itemId)
      if (!article || article.revision !== params.expectedRevision) throw new Error('文章已变化或删除，请重新读取后保存。')
      return article
    }
    read()
    const folder = await chooseDirectory()
    if (!folder) return { canceled: true }
    const article = read()
    const path = await writeNewText(folder, `资讯-${article.title}`, 'md', buildRSSNote(article), read)
    return { canceled: false, path, itemId: article.id, revision: article.revision }
  }

  async exportQuery(input: RSSQueryInput, chooseDirectory: () => Promise<string | null>): Promise<RSSQueryExportResult> {
    const params = RSSQuerySchema.parse(input)
    if (params.cursor || params.expectedRevision === undefined) throw new Error('导出需要完整筛选条件与当前资料版本。')
    const assertCurrent = () => { this.content.query({ ...params, limit: 1 }) }
    assertCurrent()
    const folder = await chooseDirectory()
    if (!folder) return { canceled: true }
    const first = this.content.query({ ...params, limit: 100 })
    const articles = first.items.map((item) => this.content.getArticle(item.id)!)
    let cursor = first.nextCursor
    while (cursor) {
      const page = this.content.query({ ...params, limit: 100, cursor })
      articles.push(...page.items.map((item) => this.content.getArticle(item.id)!))
      cursor = page.nextCursor
    }
    const snapshot = { format: 'ready-rss-query', version: 1, capturedAt: new Date().toISOString(),
      query: { ...first.query, limit: params.limit }, revision: first.revision, total: first.total,
      lastFetchAt: first.lastFetchAt, articles }
    const path = await writeNewText(folder, `RSS-当前结果-${new Date().toISOString().slice(0, 10)}`, 'json', JSON.stringify(snapshot, null, 2), assertCurrent)
    return { canceled: false, path, query: snapshot.query, revision: first.revision, total: articles.length }
  }
}
