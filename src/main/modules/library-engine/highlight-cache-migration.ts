import { existsSync, readFileSync, realpathSync, readdirSync, linkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isInside } from '../object-service/registry'
import { anchorFileSchema } from './highlight-anchors'

/** One-time file migration, shared by reader startup and the document-comment admission boundary. */
export function migrateHighlightCache(root: string, id: string): void {
  const previous = join(root, '.ready', 'anchors', `${id}.json`), target = join(root, '.ready', 'anchors', `${id}.highlights.json`)
  if (!existsSync(previous)) return
  for (const path of [previous, target]) if (existsSync(path) && !isInside(realpathSync(root), realpathSync(path))) throw new Error('定位文件超出资料库范围')
  const content = readFileSync(previous, 'utf8')
  let value: unknown
  try { value = JSON.parse(content) } catch (error) { if (error instanceof SyntaxError) return; throw error }
  if (!anchorFileSchema.safeParse(value).success) return // This file belongs to document comments, not reading highlights.
  if (!existsSync(target)) linkSync(previous, target)
  else if (readFileSync(target, 'utf8') !== content) throw new Error('旧划线定位缓存与新文件冲突，请先检查')
  unlinkSync(previous)
}

export function migrateHighlightCaches(root: string): void {
  const folder = join(root, '.ready', 'anchors')
  if (!existsSync(folder)) return
  if (!isInside(realpathSync(root), realpathSync(folder))) throw new Error('定位文件超出资料库范围')
  for (const name of readdirSync(folder)) {
    const match = /^([\w-]+)\.json$/.exec(name)
    if (match) migrateHighlightCache(root, match[1])
  }
}
