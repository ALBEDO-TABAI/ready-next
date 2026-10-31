import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { ImportKindSchema, ImportLocationSchema, type ImportKind, type ImportLocation, type ImportTarget, type ImportReport, type ImportStatus, type ImportIssue } from '../../../shared/document-import'
import { setFrontmatterFields } from '../../../shared/document-operations'
import { DatabaseDefinitionSchema, writeDatabase } from '../../../shared/document-database'
import { DocumentPageService } from '../document-pages/service'
import { DocumentDatabaseService } from '../document-database/service'
import { checkedPath, ensureDirectory, existsIgnoringCase, hashBytes, publishNewFile, stageFile, vaultRoot } from '../document-drafts/files'
import { objectTransaction } from '../object-service/registry'
import { parseNotion } from './notion'
import { parseInkwell } from './inkwell'
import { importName, type ImportPlan } from './model'
import { LIMITS } from './zip'
interface Preview { report: ImportReport; plan: ImportPlan; sourcePath: string }
interface FileStep { path: string; content: string; source: string; database: boolean; row: boolean; parent: string | null }
interface Journal {
  root: string; sourceHash: string; target: ImportTarget; files: FileStep[]; assets: { path: string; data: string; hash: string }[]
  status: ImportStatus
}
export type ImportStage = 'prepared' | 'staged' | 'page' | 'asset' | 'verified'
export class DocumentImportService {
  private readonly sources = new Map<string, { path: string; kind: ImportKind }>()
  private readonly previews = new Map<string, Preview>()
  private tail: Promise<unknown> = Promise.resolve()
  readonly root: string
  constructor(root: string, private readonly pages: DocumentPageService, private readonly databases: DocumentDatabaseService,
    private readonly afterStage?: (stage: ImportStage, index: number) => void | Promise<void>) { this.root = vaultRoot(root) }
  addSource(path: string, kind: ImportKind): { sourceId: string; name: string } {
    ImportKindSchema.parse(kind)
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error('来源必须是普通文件')
    if (!new RegExp(kind === 'notion' ? '\\.zip$' : '\\.json$', 'i').test(path)) throw new Error('来源格式不正确')
    const sourceId = randomUUID(); this.sources.set(sourceId, { path: realpathSync(path), kind })
    if (this.sources.size > 10) this.sources.delete(this.sources.keys().next().value!)
    return { sourceId, name: basename(path) }
  }
  preflight(sourceId: string, location?: ImportLocation): ImportReport {
    const source = this.sources.get(z.string().parse(sourceId))
    if (!source) throw new Error('请重新选择来源文件')
    if (statSync(source.path).size > LIMITS.source) throw new Error('来源超过 64 MiB 限制')
    const bytes = readFileSync(source.path)
    if (bytes.length > LIMITS.source) throw new Error('来源超过 64 MiB 限制')
    const plan = source.kind === 'notion' ? parseNotion(bytes) : parseInkwell(bytes, source.path)
    let target: ImportTarget | undefined
    if (location) {
      location = ImportLocationSchema.parse(location)
      const object = location.parentObjectId ? this.pages.registry.get(location.parentObjectId) : null
      if (location.parentObjectId && (!object?.current_path || object.status !== 'present' || object.identity_state === 'conflict')) throw new Error('目标页面不可用')
      const parent = checkedPath(this.root, object?.current_path ?? location.parentPath!)
      const directory = statSync(parent).isDirectory() ? parent : /\.md$/i.test(parent) ? parent.slice(0, -3) : null
      if (!directory) throw new Error('目标位置不是目录或页面')
      if (relative(this.root, directory).split(/[\\/]/).some(part => part === '.ready' || part.endsWith('.assets'))) throw new Error('不能导入到内部数据或附件目录')
      target = { title: location.title, parentPath: checkedPath(this.root, directory) }
      if (target.title !== importName(target.title)) throw new Error('导入名称含不支持的字符，请更换名称')
    }
    // Include external attachment bytes in the immutable source identity as well.
    const sourceHash = hashBytes(JSON.stringify([hashBytes(bytes), plan.assets.map(asset => [asset.source, asset.hash])]))
    const id = target ? hashBytes(JSON.stringify([this.root, sourceHash, target])) : randomUUID()
    const report: ImportReport = { id, sourceName: basename(source.path), sourceHash, target,
      counts: { pages: plan.pages.length, databases: plan.pages.filter(page => page.database).length, rows: plan.pages.filter(page => page.row).length, attachments: plan.assets.length },
      pages: plan.pages.map(page => ({ source: page.source, path: page.path, database: !!page.database, row: page.row })), issues: [...plan.issues] }
    if (target && !this.record(id)) report.issues.push(...this.conflicts(target))
    this.previews.set(id, { report, plan, sourcePath: source.path })
    if (this.previews.size > 10) this.previews.delete(this.previews.keys().next().value!)
    return structuredClone(report)
  }
  private conflicts(target: ImportTarget): ImportIssue[] {
    const base = checkedPath(this.root, join(target.parentPath, target.title))
    if (this.pages.registry.db.prepare('SELECT id FROM document_import_operations WHERE root=? AND target=?').get(this.root, base)) return [{ kind: 'conflict', item: base, message: '目标已属于另一份导入记录，请继续原记录或更换名称' }]
    return ['', '.md', '.assets'].filter(suffix => existsIgnoringCase(base + suffix)).map(suffix => ({ kind: 'conflict', item: base + suffix, message: '目标已存在，不能覆盖；请选择其他名称或位置' }))
  }
  private record(id: string): Journal | null {
    const row = this.pages.registry.db.prepare('SELECT journal_json FROM document_import_operations WHERE id=? AND root=?').get<{ journal_json: string }>(z.string().parse(id), this.root)
    return row ? JSON.parse(row.journal_json) as Journal : null
  }
  private save(journal: Journal): void {
    this.pages.registry.db.prepare('UPDATE document_import_operations SET journal_json=? WHERE id=? AND root=?').run(JSON.stringify(journal), journal.status.id, this.root)
  }
  status(id: string): ImportStatus { const journal = this.record(id); if (!journal) throw new Error('导入记录不存在'); return journal.status }
  list(): ImportStatus[] {
    return this.pages.registry.db.prepare('SELECT journal_json FROM document_import_operations WHERE root=? ORDER BY rowid DESC').all<{journal_json: string}>(this.root).map(row => (JSON.parse(row.journal_json) as Journal).status)
  }
  execute(id: string): Promise<ImportStatus> { return this.serial(() => this.start(id)) }
  resume(id: string): Promise<ImportStatus> { return this.serial(async () => { const journal = this.record(id); if (!journal) throw new Error('导入记录不存在'); return this.run(journal) }) }
  private serial(work: () => Promise<ImportStatus>): Promise<ImportStatus> { const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result }
  private async start(id: string): Promise<ImportStatus> {
    const prior = this.record(id); if (prior) return this.run(prior)
    const preview = this.previews.get(id)
    if (!preview?.report.target) throw new Error('请先选择目标并完成预检')
    const { target, sourceHash } = preview.report, conflicts = this.conflicts(target)
    if (conflicts.length) throw new Error(conflicts.map(item => item.message + ': ' + item.item).join('\n'))
    const base = join(target.parentPath, target.title)
    const files: FileStep[] = [{ path: base + '.md', source: '@root', parent: null, database: false, row: false, content: `# ${target.title}\n\n导入自 ${preview.report.sourceName}\n` }]
    for (const page of preview.plan.pages) {
      let content = setFrontmatterFields(page.body.replaceAll('@root.assets/', `../${target.title}.assets/`), { set: { ...page.values, title: page.title }, remove: ['ready_id', 'ready_database'] })
      if (page.database) content = writeDatabase(content, DatabaseDefinitionSchema.parse(page.database))
      files.push({ path: checkedPath(this.root, join(base, page.path)), content, source: page.source, parent: page.parent, database: !!page.database, row: page.row })
    }
    const assets = preview.plan.assets.map(asset => ({ path: checkedPath(this.root, asset.path.startsWith('@root.assets/') ? join(base + '.assets', asset.path.slice('@root.assets/'.length)) : join(base, asset.path)), data: asset.data, hash: asset.hash }))
    const journal: Journal = { root: this.root, target, sourceHash, files, assets, status: { id, state: 'prepared', done: 0, total: files.length + assets.length, issues: preview.plan.issues, results: [] } }
    objectTransaction(this.pages.registry.db, () => {
      if (this.conflicts(target).length) throw new Error('目标发生变化，请重新预检')
      this.pages.registry.db.prepare('INSERT INTO document_import_operations(id,root,target,source_hash,journal_json) VALUES (?,?,?,?,?)').run(id, this.root, base, sourceHash, JSON.stringify(journal))
    })
    await this.afterStage?.('prepared', 0)
    return this.run(journal)
  }
  private async run(journal: Journal): Promise<ImportStatus> {
    const { status } = journal, stage = checkedPath(this.root, join(this.root, '.ready', 'imports', status.id))
    const terminal = status.state === 'completed' || status.state === 'incomplete'
    if (terminal) { await this.verify(journal); return structuredClone(status) }
    status.state = 'running'; delete status.error; this.save(journal)
    try {
      ensureDirectory(this.root, stage)
      for (const [i, asset] of journal.assets.entries()) await stageFile(this.root, join(stage, String(i)), Buffer.from(asset.data, 'base64'), asset.hash)
      await this.afterStage?.('staged', 0)
      for (const [i, file] of journal.files.entries()) {
        checkedPath(this.root, file.path)
        const known = status.results.find(result => result.path === file.path)
        if (known) { if (hashBytes(readFileSync(file.path)) !== hashBytes(file.content) || this.pages.registry.find(file.path)?.id !== known.objectId) throw new Error(`已导入页面发生变化，未覆盖：${file.path}`); continue }
        const operationId = `import-${status.id}-${i}`
        const parent = journal.files.find(item => item.source === file.parent), parentResult = parent && status.results.find(item => item.path === parent.path)
        const request = { type: 'create' as const, root: this.root, operationId, parentPath: dirname(file.path), title: basename(file.path, '.md'), content: file.content }
        ensureDirectory(this.root, dirname(file.path))
        let objectId: string
        if (file.row && parent?.database && parentResult && !Object.values(this.databases.read(parentResult.objectId).definition.fields).some(field => field.type === 'relation')) {
          const result = await this.databases.request({ type: 'createRow', databaseId: parentResult.objectId, operationId, title: request.title, values: {}, body: file.content })
          objectId = z.object({ objectId: z.string() }).parse(result).objectId
        } else objectId = (await this.pages.operate(request)).objectId
        if (hashBytes(readFileSync(file.path)) !== hashBytes(file.content)) throw new Error(`页面回读不一致：${file.path}`)
        ensureDirectory(this.root, file.path.slice(0, -3)); ensureDirectory(this.root, file.path.slice(0, -3) + '.assets')
        await this.afterStage?.('page', i)
        status.results.push({ objectId, path: file.path, database: file.database }); status.done = status.results.length; this.save(journal)
      }
      for (const [i, asset] of journal.assets.entries()) {
        ensureDirectory(this.root, dirname(asset.path))
        await publishNewFile(this.root, join(stage, String(i)), asset.path, asset.hash)
        status.done = journal.files.length + i + 1; this.save(journal); await this.afterStage?.('asset', i)
      }
      await this.verify(journal); await this.afterStage?.('verified', 0)
      return structuredClone(status)
    } catch (error) {
      status.state = 'interrupted'; status.error = error instanceof Error ? error.message : String(error); this.save(journal)
      return structuredClone(status)
    }
  }
  private async verify(journal: Journal): Promise<void> {
    const issues = journal.status.issues.filter(issue => !issue.item.startsWith('回读:'))
    for (const file of journal.files) {
      try {
        checkedPath(this.root, file.path)
        if (hashBytes(readFileSync(file.path)) !== hashBytes(file.content)) throw new Error('内容已变化')
        for (const directory of [file.path.slice(0, -3), file.path.slice(0, -3) + '.assets']) if (!statSync(checkedPath(this.root, directory)).isDirectory()) throw new Error('页面配套目录缺失')
        const receipt = journal.status.results.find(result => result.path === file.path), object = this.pages.registry.find(file.path)
        if (!receipt || object?.id !== receipt.objectId || object.status !== 'present') throw new Error('页面身份不一致')
        if (file.database) {
          const result = this.databases.read(receipt.objectId), expected = journal.files.filter(row => row.parent === file.source && row.row)
          for (const row of expected) if (!result.rows.some(item => item.id === journal.status.results.find(item => item.path === row.path)?.objectId)) throw new Error(`缺失数据库行 ${row.path}`)
        }
      } catch (error) { issues.push({ kind: 'missing', item: '回读:' + relative(this.root, file.path), message: String(error) }) }
    }
    for (const asset of journal.assets) try { if (hashBytes(readFileSync(checkedPath(this.root, asset.path))) !== asset.hash) throw new Error('附件内容变化') }
    catch (error) { issues.push({ kind: 'missing', item: '回读:' + relative(this.root, asset.path), message: String(error) }) }
    journal.status.issues = issues
    journal.status.state = issues.some(issue => issue.kind !== 'renamed') ? 'incomplete' : 'completed'
    this.save(journal)
  }
}
