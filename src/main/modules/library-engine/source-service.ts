import { dirname, basename, join } from 'node:path'
import { z } from 'zod'
import type { DatabaseConnection } from '../database/connection'
import type { LibraryEngine } from './library-engine'
import type { SourceSettings } from '../../../shared/library-sources'
import { BookSourceJobs, downloadInput } from './source-jobs'
import { ZlibSource } from './sources/zlib'

declare const __READY_FEATURE_CTFILE__: boolean
export const sourceBuildMarker = __READY_FEATURE_CTFILE__ ? 'READY_BOOK_SOURCE_BUILD_CTFILE_ON' : 'READY_BOOK_SOURCE_BUILD_CTFILE_OFF'
export async function loadExtraSources(cache: string) {
  if (__READY_FEATURE_CTFILE__) return (await import('./sources/extra')).extraSources(cache)
  throw new Error('此版本未包含更多书源')
}
export const sourceSettingsSchema = z.object({ executable: z.string().trim().max(4096), format: z.enum(['epub', 'pdf', 'mobi', 'azw3', 'txt', 'fb2', 'cbz']), treasure: z.boolean(), ctfile: z.boolean() }).strict()
export const sourceSearchSchema = z.object({ source: z.enum(['zlib', 'treasure', 'ctfile']), query: z.string().trim().max(500), format: sourceSettingsSchema.shape.format, category: z.string().max(200).optional() }).strict()
const KEY = 'library_book_sources'
export class BookSourceService {
  readonly jobs: BookSourceJobs
  readonly ready: Promise<void>
  private extra?: ReturnType<typeof loadExtraSources>
  private roots = new Map<string, string>()
  private announced = new Set<string>()
  constructor(private readonly dependencies: {
    db: DatabaseConnection; cache: string; engine: LibraryEngine
    settings: { getSetting(key: string): string | undefined; setSetting(key: string, value: string): void }
    changed: ConstructorParameters<typeof BookSourceJobs>[4]
    libraryChanged(): Promise<void>
    openExternal(url: string): Promise<void>
  }) {
    this.jobs = new BookSourceJobs(dependencies.db, join(dependencies.cache, 'work'), async (job, folder, signal, context) => {
      this.assertEnabled(job.source)
      if (this.roots.get(job.id) !== dependencies.engine.vaultRoot()) throw new Error('资料库已切换，请重新下载')
      if (job.source === 'zlib') return new ZlibSource(this.settings().settings.executable).download(job.ref, folder, signal)
      return (await this.optional()).download(job.ref, folder, signal, context)
    }, async path => {
      const root = this.roots.get(basename(dirname(path)))
      if (!root || root !== dependencies.engine.vaultRoot()) throw new Error('资料库已切换，请重新下载')
      const job = this.jobs.get(basename(dirname(path)))
      const book = await dependencies.engine.importDownload(path, job.id, {
        kind: job.source === 'zlib' ? 'zlib' : 'treasure', ref: job.ref,
        ...(job.source !== 'zlib' ? { url: job.ref } : {}),
      }, root)
      return book.id
    }, jobs => {
      dependencies.changed(jobs)
      for (const job of jobs) if (['done', 'failed', 'cancelled'].includes(job.status)) this.roots.delete(job.id)
      const completed = jobs.filter(job => job.status === 'done' && !this.announced.has(job.id))
      completed.forEach(job => this.announced.add(job.id))
      if (completed.length) dependencies.libraryChanged().catch(error => console.error('[book-sources] shelf notification failed', error))
    })
    this.ready = this.jobs.initialize()
    this.ready.catch(error => console.error('[book-sources] startup failed', error))
  }
  settings(): { settings: SourceSettings; extraSources: boolean; buildMarker: string } {
    const raw = this.dependencies.settings.getSetting(KEY)
    const settings = raw ? sourceSettingsSchema.parse(JSON.parse(raw)) : { executable: '', format: 'epub' as const, treasure: false, ctfile: false }
    return { settings: { ...settings, treasure: __READY_FEATURE_CTFILE__ && settings.treasure, ctfile: __READY_FEATURE_CTFILE__ && settings.ctfile }, extraSources: __READY_FEATURE_CTFILE__, buildMarker: sourceBuildMarker }
  }
  configure(input: unknown): SourceSettings {
    const settings = sourceSettingsSchema.parse(input)
    if (!__READY_FEATURE_CTFILE__ && (settings.treasure || settings.ctfile)) throw new Error('此版本未包含更多书源')
    this.dependencies.settings.setSetting(KEY, JSON.stringify(settings))
    return this.settings().settings
  }
  status() { return new ZlibSource(this.settings().settings.executable).status() }
  private assertEnabled(source: string): void {
    const settings = this.settings().settings
    if (source !== 'zlib' && (!__READY_FEATURE_CTFILE__ || (source === 'treasure' ? !settings.treasure : !settings.ctfile))) throw new Error('书源尚未启用')
  }
  private optional() { return this.extra ??= loadExtraSources(this.dependencies.cache) }
  async search(input: unknown) {
    const request = sourceSearchSchema.parse(input); this.assertEnabled(request.source)
    if (request.source === 'zlib') return request.query ? new ZlibSource(this.settings().settings.executable).search(request.query, request.format) : []
    if (request.source !== 'treasure') throw new Error('网盘链接请直接粘贴下载')
    return (await this.optional()).index.search(request.query, request.category || '')
  }
  async categories() { this.assertEnabled('treasure'); return (await this.optional()).index.categories() }
  async start(input: unknown) {
    const request = downloadInput.parse(input); this.assertEnabled(request.source)
    const root = this.dependencies.engine.vaultRoot()
    if (!root) throw new Error('请先配置可用的资料库')
    if (request.source !== 'zlib') (await this.optional()).parseLink(request.ref)
    const job = this.jobs.start(request); if (!this.roots.has(job.id)) this.roots.set(job.id, root)
    return job
  }
  async retry(id: string) {
    const job = this.jobs.get(id); this.assertEnabled(job.source)
    const root = this.dependencies.engine.vaultRoot()
    if (!root) throw new Error('请先配置可用的资料库')
    const restarted = this.jobs.retry(id); this.roots.set(id, root); return restarted
  }
  async openManual(id: string): Promise<void> {
    const job = this.jobs.get(id); this.assertEnabled(job.source)
    if (job.source === 'zlib') throw new Error('这个任务没有网盘链接')
    const link = (await this.optional()).parseLink(job.ref)
    await this.dependencies.openExternal(link.link)
  }
}
