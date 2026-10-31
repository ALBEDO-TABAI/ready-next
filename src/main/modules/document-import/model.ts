import { posix } from 'node:path'
import { hashBytes, filename } from '../document-drafts/files'
import type { DatabaseDefinition } from '../../../shared/document-database'
import type { ImportIssue } from '../../../shared/document-import'
export interface ImportPage { source: string; title: string; parent: string | null; body: string; values: Record<string, unknown>; database?: DatabaseDefinition; row: boolean; path: string }
export interface ImportAsset { source: string; owner: string | null; name: string; data: string; hash: string; path: string }
export interface ImportPlan { pages: ImportPage[]; assets: ImportAsset[]; issues: ImportIssue[] }
export function importName(title: string): string {
  let safe = title.normalize('NFC').replace(/[\\/#[\]%]/g, '_').replace(/\.\./g, '_').replace(/^\.+/, '_')
  while (Buffer.byteLength(safe) > 150) safe = safe.slice(0, -1)
  return filename(safe.endsWith('.assets') ? safe + '_' : safe)
}
export function assignPaths(plan: ImportPlan): void {
  const done = new Map<string, string>(), active = new Set<string>(), names = new Set<string>()
  const byId = new Map(plan.pages.map(page => [page.source, page]))
  if (byId.size !== plan.pages.length) throw new Error('Duplicate source page identity')
  const visit = (page: ImportPage): string => {
    if (done.has(page.source)) return done.get(page.source)!
    if (active.has(page.source) || active.size > 32) throw new Error('Cyclic or excessively deep page tree')
    active.add(page.source)
    const parent = page.parent ? byId.get(page.parent) : undefined
    if (page.parent && !parent) plan.issues.push({ kind: 'missing', item: page.source, message: `Parent missing: ${page.parent}` })
    const prefix = parent ? visit(parent).slice(0, -3) + '/' : ''
    let name = importName(page.title), path = prefix + name + '.md'
    if (name !== page.title && !plan.issues.some(issue => issue.kind === 'renamed' && issue.item === page.source)) plan.issues.push({ kind: 'renamed', item: page.source, message: `文件名规范化为 ${path}，原始标题保留` })
    if (names.has(path.toLowerCase())) { name += `-${hashBytes(page.source).slice(0, 8)}`; path = prefix + name + '.md'; plan.issues.push({ kind: 'renamed', item: page.source, message: `同名页面映射为 ${path}` }) }
    if (names.has(path.toLowerCase())) throw new Error('Import filename collision')
    names.add(path.toLowerCase()); page.path = path
    if (page.database) page.database.source = name
    done.set(page.source, path); active.delete(page.source); return path
  }
  plan.pages.forEach(visit)
  plan.pages.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
  const assetNames = new Set<string>()
  for (const asset of plan.assets) {
    const owner = asset.owner ? byId.get(asset.owner) : undefined
    const prefix = owner ? owner.path.slice(0, -3) + '.assets/' : '@root.assets/'
    let name = importName(asset.name), path = prefix + name
    if (assetNames.has(path.toLowerCase())) { name = `${hashBytes(asset.source).slice(0, 8)}-${name}`; path = prefix + name }
    if (assetNames.has(path.toLowerCase())) throw new Error('Duplicate attachment identity')
    assetNames.add(path.toLowerCase()); asset.path = path
  }
}
export function relativeLink(from: string, to: string): string {
  const relative = posix.relative(posix.dirname(from), to).replace(/\.md$/i, '')
  return relative.startsWith('.') ? relative : './' + relative
}
export function outsideCode(markdown: string, transform: (text: string) => string): string {
  return markdown.split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$|^~~~[^\n]*\n[\s\S]*?^~~~[^\n]*$|`[^`\n]+`)/gm).map((part, index) => index % 2 ? part : transform(part)).join('')
}
