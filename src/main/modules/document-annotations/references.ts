import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { checkedPath } from '../document-drafts/files'
import { isInside } from '../object-service/registry'

export function resolveWikiPage(root: string, from: string, page: string): string {
  const file = page ? (/\.(md|canvas)$/i.test(page) ? page : page + '.md') : from
  const allowed = [...new Set([resolve(dirname(from), file), resolve(root, file)])].filter(candidate => isInside(root, candidate))
  if (!allowed.length) throw new Error('path is outside vault')
  const candidates = allowed.map(candidate => checkedPath(root, candidate)).filter(existsSync)
  if (candidates.length !== 1) throw new Error(candidates.length ? '引用页面不明确' : '引用页面已删除或回收')
  return candidates[0]
}
