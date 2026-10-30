import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { DatabaseDefinitionSchema, readDatabase, writeDatabase, type DatabaseDefinition } from '../../../shared/document-database'
import { readDocumentSource, setFrontmatterFields, type DocumentOperation } from '../../../shared/document-operations'
import { applyDocumentOperation, documentVersion, publishDocumentContent } from '../document-engine/document-write-service'
import { checkedPath, ensureDirectory, stageFile, vaultRoot } from '../document-drafts/files'
import { exists } from './source-note'

const legacyDefinition = z.object({ source: z.string(), fields: z.record(z.string(), z.object({ type: z.string() }).passthrough()), views: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()) }).passthrough()
/** One-time conversion only. Production readers accept version 1 exclusively. */
export function upgradeReadingDefinition(input: unknown): DatabaseDefinition {
  const old = legacyDefinition.parse(input)
  if (old.version !== undefined) return DatabaseDefinitionSchema.parse(input)
  const fields = Object.fromEntries(Object.entries(old.fields).map(([key, field]) => [key === '来源' ? '来源说明' : key, { ...field, id: field.id ?? key, name: field.name ?? key, ...(key === '来源' ? { type: 'text' } : {}) }]))
  if (old.fields.来源 && old.fields.来源说明) throw new Error('来源说明 already exists; cannot choose a storage key without losing a field')
  const views = old.views.map((view, index) => ({ ...view, id: view.id ?? `reading-view-${index + 1}` }))
  return DatabaseDefinitionSchema.parse({ ...old, version: 1, source: old.source, recursive: true, fields, views })
}
export const readingDefinition = upgradeReadingDefinition({ source: '阅读', fields: {
  类型: { type: 'select', options: ['书'] }, 作者: { type: 'text' }, 分类: { type: 'select' },
  状态: { type: 'select', options: ['想读', '在读', '读完'] }, 读完: { type: 'date' }, 加入: { type: 'date' }, 字数: { type: 'number' }, 来源: { type: 'text' },
}, views: [{ name: '书架', type: 'bookshelf' }, { name: '表格', type: 'table' }, { name: '日历', type: 'calendar', dateField: '读完' }] })
export const readingDatabasePage = writeDatabase('', readingDefinition)
export function readingSourceText(source: unknown): string {
  if (typeof source === 'string') return source
  const parsed = z.object({ kind: z.string(), ref: z.string().optional(), url: z.string().optional() }).passthrough().parse(source)
  return [parsed.kind, parsed.ref, parsed.url].filter(Boolean).join(' · ')
}
const stepSchema = z.object({ path: z.string(), before: z.string(), after: z.string(), backup: z.string() }).strict()
const planSchema = z.object({ version: z.literal(1), state: z.enum(['prepared', 'committed']), steps: z.array(stepSchema) }).strict()
const tails = new Map<string, Promise<void>>()
export function upgradeReadingDatabase(root: string, dependencies: { write?: typeof applyDocumentOperation; afterWrite?(index: number): void | Promise<void> } = {}): Promise<void> {
  const canonical = vaultRoot(root), prior = tails.get(canonical) ?? Promise.resolve()
  const result = prior.then(() => upgrade(canonical, dependencies))
  const tail = result.then(() => undefined, () => undefined); tails.set(canonical, tail)
  return result.finally(() => { if (tails.get(canonical) === tail) tails.delete(canonical) })
}
async function upgrade(root: string, dependencies: { write?: typeof applyDocumentOperation; afterWrite?(index: number): void | Promise<void> }): Promise<void> {
  const path = checkedPath(root, join(root, '阅读.md'))
  if (!await exists(path)) return
  const directory = checkedPath(root, join(root, '.ready', 'database-upgrades', 'reading-v1')), journal = join(directory, 'operation.json')
  let plan: z.infer<typeof planSchema>
  if (await exists(journal)) {
    checkedPath(root, journal); plan = planSchema.parse(JSON.parse(await readFile(journal, 'utf8')))
    if (plan.state === 'committed') { readDatabase(await readFile(path, 'utf8')); return }
  } else {
    const before = await readFile(path, 'utf8'), old = readDocumentSource(before).frontmatter.ready_database
    if (!old) throw new Error('阅读.md has no database definition')
    if (typeof old === 'object' && 'version' in old) { readDatabase(before); return }
    const definition = upgradeReadingDefinition(old)
    ensureDirectory(root, directory)
    const steps: z.infer<typeof stepSchema>[] = []
    const add = (path: string, before: string, after: string) => { if (before !== after) steps.push({ path, before, after, backup: join(directory, `${steps.length}-${basename(path)}.backup`) }) }
    const scan = async (folder: string): Promise<void> => {
      checkedPath(root, folder)
      if (!await exists(folder)) return
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.assets')) continue
        const rowPath = checkedPath(root, join(folder, entry.name))
        if (entry.isDirectory()) { await scan(rowPath); continue }
        if (!entry.name.toLowerCase().endsWith('.md')) continue
        const row = await readFile(rowPath, 'utf8'), fields = readDocumentSource(row).frontmatter
        if (fields.来源 !== undefined && fields.来源说明 === undefined) add(rowPath, row, setFrontmatterFields(row, { set: { 来源说明: readingSourceText(fields.来源) } }))
      }
    }
    if (Object.hasOwn(definition.fields, '来源说明')) await scan(checkedPath(root, join(root, definition.source)))
    add(path, before, writeDatabase(before, definition))
    plan = { version: 1, state: 'prepared', steps }
    // Backup every original before publishing even the first row.
    for (const step of steps) await stageFile(root, step.backup, step.before, documentVersion(step.before))
    await publishDocumentContent(journal, JSON.stringify(plan, null, 2))
  }
  for (const [index, step] of plan.steps.entries()) {
    checkedPath(root, step.path); checkedPath(root, step.backup)
    if (await readFile(step.backup, 'utf8') !== step.before) throw new Error('Reading migration backup mismatch')
    const current = await readFile(step.path, 'utf8')
    if (current !== step.after && current !== step.before) throw new Error(`version_conflict: reading migration ${step.path}`)
    const operation: DocumentOperation = step.path === path
      ? { type: 'replaceRange', start: 0, end: current.length, expectedText: current, replacement: step.after }
      : { type: 'setFrontmatterFields', set: { 来源说明: readDocumentSource(step.after).frontmatter.来源说明 } }
    const receipt = await (dependencies.write ?? applyDocumentOperation)({ path: step.path, expectedVersion: documentVersion(current), operation, origin: 'library-database-upgrade' })
    if ('code' in receipt) throw new Error(`${receipt.code}: ${receipt.message}`)
    if (receipt.tab === 'merged_dirty') throw new Error('unsaved: save the source page before resuming reading migration')
    if (await readFile(step.path, 'utf8') !== step.after) throw new Error('Reading migration readback mismatch')
    await dependencies.afterWrite?.(index)
  }
  for (const step of plan.steps) if (await readFile(step.path, 'utf8') !== step.after) throw new Error('Reading migration changed during verification')
  readDatabase(await readFile(path, 'utf8'))
  await publishDocumentContent(journal, JSON.stringify({ ...plan, state: 'committed' }, null, 2))
}
