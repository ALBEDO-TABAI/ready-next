import { readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ReadyCanvasSchema } from '../../../shared/ready-canvas'
import { readDocumentSource } from '../../../shared/document-operations'
import { PageRootSchema, type PageNode, type PageRoot } from '../../../shared/document-pages'
import { vaultRoot } from '../document-drafts/files'

export function readPageTree(input: PageRoot,
  identify: (path: string) => { objectId: string; revision: number },
  order: (parentObjectId: string) => string[],
): PageNode {
  const root = vaultRoot(PageRootSchema.parse(input).path)
  if (root.split(/[\\/]/).includes('.ready')) throw new Error('Internal metadata is not a page root')
  const node = (path: string, kind: PageNode['kind'], position: number): PageNode => {
    const name = basename(path), fields: Record<string, unknown> = kind === 'page' ? readDocumentSource(readFileSync(path, 'utf8')).frontmatter : kind === 'canvas' ? ReadyCanvasSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).ready : {}
    return { ...identify(path), path, name, kind, title: typeof fields.title === 'string' ? fields.title : kind === 'page' || kind === 'canvas' ? name.slice(0, -extname(name).length) : name,
      icon: typeof fields.icon === 'string' ? fields.icon : undefined, cover: typeof fields.cover === 'string' ? fields.cover : undefined,
      children: [], hasChildren: false, position }
  }
  const walk = (directory: string, parent: PageNode): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).filter(e => e.name !== '.ready' && !e.isSymbolicLink())
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const stems = new Map<string, string[]>()
    for (const e of entries) if (e.isFile() && ['.md', '.canvas'].includes(extname(e.name).toLowerCase())) {
      const stem = e.name.slice(0, -extname(e.name).length).toLowerCase(); stems.set(stem, [...(stems.get(stem) ?? []), e.name])
    }
    const merges = new Map<string, { directory?: string; assets?: string }>(), ambiguous = new Set<string>(), consumed = new Set<string>()
    for (const [stem, pages] of stems) {
      const dirs = entries.filter(e => e.isDirectory() && [stem, stem + '.assets'].includes(e.name.toLowerCase()))
      const exact = pages[0].slice(0, -extname(pages[0]).length)
      if (pages.length !== 1 || dirs.some(d => d.name !== exact && d.name !== exact + '.assets') || dirs.length > 2) {
        for (const name of [...pages, ...dirs.map(d => d.name)]) ambiguous.add(name)
      } else {
        merges.set(pages[0], { directory: dirs.find(d => d.name === exact)?.name, assets: dirs.find(d => d.name === exact + '.assets')?.name })
        for (const dir of dirs) consumed.add(dir.name)
      }
    }
    parent.children = entries.filter(e => !consumed.has(e.name)).map((e, position) => {
      const path = join(directory, e.name), ext = extname(e.name).toLowerCase()
      const child = node(path, e.isDirectory() ? 'folder' : ext === '.md' ? 'page' : ext === '.canvas' ? 'canvas' : 'file', position)
      if (ambiguous.has(e.name)) child.ambiguity = '文件名存在歧义，请在文件视角处理'
      const merge = merges.get(e.name)
      if (merge?.assets) child.assetsPath = join(directory, merge.assets)
      if (e.isDirectory()) walk(path, child)
      else if (merge?.directory) walk(join(directory, merge.directory), child)
      return child
    })
    const saved = order(parent.objectId)
    parent.children.sort((a, b) => {
      const ai = saved.indexOf(a.objectId), bi = saved.indexOf(b.objectId)
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.position - b.position
    }).forEach((child, position) => { child.position = position })
    parent.hasChildren = parent.children.length > 0
  }
  const result = node(root, input.kind === 'vault' ? 'vault' : 'folder', 0)
  walk(root, result)
  return result
}
