import { execFile } from 'node:child_process'
import { realpath, readdir, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, extname } from 'node:path'
import { z } from 'zod'
import type { SourceFormat, SourceHit, SourceStatus } from '../../../../shared/library-sources'

const bookSchema = z.object({ id: z.union([z.string(), z.number()]), name: z.string(), authors: z.array(z.string()).default([]), extension: z.string().default('') })
export class ZlibSource {
  constructor(private readonly executable = 'zlib') {}
  private run(args: string[], signal?: AbortSignal, timeout = 60_000, jsonLines = false): Promise<unknown> {
    return new Promise((resolve, reject) => {
      execFile(this.executable || 'zlib', args, { signal, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
        if (error) { reject(Object.assign(new Error(stderr.trim() || `zlib 退出码 ${error.code}: ${error.message}`), { code: error.code })); return }
        try {
          const output = jsonLines ? stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).at(-1) : JSON.parse(stdout.trim())
          resolve(output)
        } catch { reject(new Error('zlib 没有返回有效的 JSON')) }
      })
    })
  }
  async status(): Promise<SourceStatus> {
    try {
      const result = z.object({ loggedIn: z.boolean().optional(), logged_in: z.boolean().optional() }).parse(await this.run(['profile', '--json']))
      return { state: result.loggedIn === false || result.logged_in === false ? 'logged_out' : 'available' }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      return { state: code === 'ENOENT' ? 'missing' : code === 3 ? 'logged_out' : 'error', error: error instanceof Error ? error.message : String(error) }
    }
  }
  async search(query: string, format: SourceFormat): Promise<SourceHit[]> {
    const result = z.object({ books: z.array(bookSchema) }).parse(await this.run(['search', query, '--json', '--count', '24', '--ext', format]))
    return result.books.map(book => ({ source: 'zlib', ref: String(book.id), title: book.name, author: book.authors.join(' / '), format: book.extension.toLowerCase() }))
  }
  async download(ref: string, directory: string, signal: AbortSignal): Promise<string> {
    // JSON is validated even when the CLI reports its filename differently; the owned directory is authoritative.
    z.object({}).passthrough().parse(await this.run(['download', ref, '--dir', directory, '--json'], signal, 30 * 60_000, true))
    const files = (await readdir(directory)).filter(name => /\.(epub|pdf|mobi|azw3|txt|fb2|cbz)$/i.test(name))
    if (files.length !== 1) throw new Error('zlib 下载结果必须包含一本电子书')
    return ownedDownload(directory, join(directory, files[0]))
  }
}

export async function ownedDownload(directory: string, path: string): Promise<string> {
  const root = await realpath(directory), resolved = await realpath(path), rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || (await lstat(path)).isSymbolicLink() || !(await lstat(path)).isFile()) throw new Error('下载文件不在任务目录中')
  if (!['.epub', '.pdf', '.mobi', '.azw3', '.txt', '.fb2', '.cbz'].includes(extname(path).toLowerCase())) throw new Error('下载文件不是支持的电子书')
  return resolved
}
