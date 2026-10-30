import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { DatabaseConnection } from '../database/connection'
import type { SourceJob, SourceJobStatus } from '../../../shared/library-sources'
import { ownedDownload } from './sources/zlib'

export const downloadInput = z.object({ source: z.enum(['zlib', 'treasure', 'ctfile']), ref: z.string().trim().min(1).max(4096) }).strict()
const active: SourceJobStatus[] = ['queued', 'downloading', 'captcha', 'extracting']
const transitions: Record<SourceJobStatus, SourceJobStatus[]> = {
  queued: ['downloading', 'cancelled', 'failed'], downloading: ['captcha', 'extracting', 'cancelled', 'failed'],
  captcha: ['downloading', 'cancelled', 'failed'], extracting: ['done', 'cancelled', 'failed'],
  done: [], failed: ['queued'], cancelled: ['queued'],
}
export interface DownloadContext {
  progress(value: number, message?: string): void
  extracting(): void
  captcha(image: string): Promise<string>
}
type Download = (job: SourceJob, folder: string, signal: AbortSignal, context: DownloadContext) => Promise<string>
type Running = { controller: AbortController; promise: Promise<void>; committing: boolean }

/** DB is the sole task-state owner. Captcha promises and process handles never cross IPC. */
export class BookSourceJobs {
  private tail = Promise.resolve()
  private running = new Map<string, Running>()
  private challenges = new Map<string, { token: string; image: string; resolve(text: string): void }>()
  private messages = new Map<string, string>()
  private initialized = false
  private closing = false
  constructor(private readonly db: DatabaseConnection, private readonly work: string, private readonly download: Download,
    private readonly importBook: (path: string) => Promise<string>, private readonly changed: (jobs: SourceJob[]) => void) {}

  async initialize(): Promise<void> {
    await mkdir(this.work, { recursive: true })
    for (const name of await readdir(this.work)) await rm(join(this.work, name), { recursive: true, force: true })
    this.db.prepare(`UPDATE library_source_jobs SET status = CASE WHEN book_id IS NULL THEN 'failed' ELSE 'done' END,
      error = CASE WHEN book_id IS NULL THEN '应用退出时中断' ELSE NULL END, updated_at = ?
      WHERE status IN ('queued','downloading','captcha','extracting')`).run(Date.now())
    this.initialized = true
  }
  list(): SourceJob[] {
    return this.db.prepare('SELECT * FROM library_source_jobs ORDER BY created_at DESC, id').all<SourceJob>().map(job => {
      const challenge = this.challenges.get(job.id)
      return { ...job, message: this.messages.get(job.id), ...(challenge ? { captcha: { token: challenge.token, image: challenge.image } } : {}) }
    })
  }
  get(id: string): SourceJob {
    const job = this.list().find(row => row.id === id)
    if (!job) throw new Error('找不到下载任务')
    return job
  }
  private emit(): void { this.changed(this.list()) }
  private transition(id: string, status: SourceJobStatus, error: string | null = null): void {
    const job = this.get(id)
    if (!transitions[job.status].includes(status)) throw new Error(`任务状态不允许 ${job.status} → ${status}`)
    this.db.prepare('UPDATE library_source_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, Date.now(), id)
    this.emit()
  }
  start(input: unknown): SourceJob {
    if (!this.initialized) throw new Error('下载任务尚未完成启动清扫')
    const request = downloadInput.parse(input)
    const existing = this.list().find(job => job.source === request.source && job.ref === request.ref && active.includes(job.status))
    if (existing) return existing
    const id = randomUUID(), now = Date.now()
    this.db.prepare(`INSERT INTO library_source_jobs (id, source, ref, status, progress, error, book_id, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, ?)`).run(id, request.source, request.ref, now, now)
    this.enqueue(id); this.emit()
    return this.get(id)
  }
  retry(id: string): SourceJob {
    if (this.closing) throw new Error('应用正在退出')
    const job = this.get(id)
    if (job.book_id || !['failed', 'cancelled'].includes(job.status) || this.running.has(id)) throw new Error('这个任务现在不能重试')
    this.transition(id, 'queued')
    this.db.prepare('UPDATE library_source_jobs SET progress = 0 WHERE id = ?').run(id)
    this.enqueue(id); this.emit()
    return this.get(id)
  }
  async cancel(id: string): Promise<SourceJob> {
    const job = this.get(id), owned = this.running.get(id)
    if (!active.includes(job.status)) return job
    if (owned?.committing) throw new Error('书籍正在上架，请等待完成')
    if (job.status === 'queued') this.transition(id, 'cancelled')
    owned?.controller.abort()
    if (job.status !== 'queued') await owned?.promise
    return this.get(id)
  }
  answer(id: string, token: string, text: string): void {
    const pending = this.challenges.get(id)
    if (!pending || pending.token !== token || this.get(id).status !== 'captcha') throw new Error('验证码已过期')
    pending.resolve(z.string().trim().min(1).max(16).parse(text))
  }
  private enqueue(id: string): void {
    const owned: Running = { controller: new AbortController(), promise: Promise.resolve(), committing: false }
    this.running.set(id, owned)
    owned.promise = this.tail.then(() => this.run(id, owned)).finally(() => this.running.delete(id))
    this.tail = owned.promise.catch(error => console.error('[book-sources] task persistence failed', error))
  }
  async idle(): Promise<void> { await this.tail }
  async shutdown(): Promise<void> {
    this.closing = true; this.initialized = false
    for (const owned of this.running.values()) if (!owned.committing) owned.controller.abort()
    await this.idle()
  }
  private async ask(id: string, image: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    let cleanup = () => {}
    try {
      const answer = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('验证码等待超时')), 15 * 60_000)
        const abort = () => reject(new Error('已取消'))
        signal.addEventListener('abort', abort, { once: true })
        cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
        this.challenges.set(id, { token: randomUUID(), image, resolve })
      })
      this.transition(id, 'captcha')
      return await answer
    } finally {
      cleanup(); this.challenges.delete(id)
      this.transition(id, 'downloading')
    }
  }
  private async run(id: string, owned: Running): Promise<void> {
    if (this.get(id).status === 'cancelled') return
    const folder = join(this.work, id), signal = owned.controller.signal
    let outcome: 'done' | 'failed' | 'cancelled' = 'done', error: string | null = null
    try {
      signal.throwIfAborted()
      await mkdir(folder, { recursive: true })
      this.transition(id, 'downloading')
      signal.throwIfAborted()
      const path = await this.download(this.get(id), folder, signal, {
        progress: (value, message) => {
          signal.throwIfAborted()
          this.db.prepare('UPDATE library_source_jobs SET progress = ?, updated_at = ? WHERE id = ?').run(z.number().min(0).max(99).parse(value), Date.now(), id)
          if (message) this.messages.set(id, message)
          this.emit()
        },
        extracting: () => this.transition(id, 'extracting'),
        captcha: image => this.ask(id, image, signal),
      })
      const verifiedPath = await ownedDownload(folder, path)
      signal.throwIfAborted()
      if (this.get(id).status !== 'extracting') this.transition(id, 'extracting')
      owned.committing = true
      const bookId = await this.importBook(verifiedPath)
      this.db.prepare('UPDATE library_source_jobs SET book_id = ?, progress = 100 WHERE id = ?').run(bookId, id)
    } catch (cause) {
      outcome = signal.aborted && !this.closing ? 'cancelled' : 'failed'
      error = this.closing ? '应用退出时中断' : cause instanceof Error ? cause.message : String(cause)
    }
    try { await rm(folder, { recursive: true, force: true }) } catch (cause) {
      // Retain book_id so a cleanup failure can never duplicate an already imported book.
      outcome = 'failed'; error = `临时目录清理失败：${String(cause)}`
    }
    this.messages.delete(id)
    this.transition(id, outcome, error)
  }
}
