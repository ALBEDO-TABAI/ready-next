import type { PageNode } from '../../../shared/document-pages'

/** The boards above this one: a sub-board lives in its parent's folder (灵感.canvas → 灵感/子画板.canvas). */
export function boardAncestors(trees: PageNode[], root: string, boardPath: string): PageNode[] {
  const boards = new Map<string, PageNode>()
  const walk = (node: PageNode) => { if (node.kind === 'canvas') boards.set(node.path, node); node.children.forEach(walk) }
  trees.forEach(walk)
  const parts = boardPath.replace(/\\/g, '/').split('/').slice(0, -1), chain: PageNode[] = []
  for (let depth = 1; depth <= parts.length; depth++) {
    const parent = boards.get(`${root}/${parts.slice(0, depth).join('/')}.canvas`)
    if (parent) chain.push(parent)
  }
  return chain
}
