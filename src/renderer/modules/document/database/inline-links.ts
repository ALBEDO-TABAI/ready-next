import type { Root, Parent, Text, Link } from 'mdast'

/** Run on Markdown text nodes only: fenced code and inline code stay literal. */
export function remarkDatabaseViews() {
  return (tree: Root) => {
    const visit = (node: Parent) => {
      if (['link', 'linkReference', 'image', 'code', 'inlineCode', 'html'].includes(node.type)) return
      node.children = node.children.flatMap<Parent['children'][number]>(child => {
        if (child.type !== 'text') { if ('children' in child) visit(child); return [child] }
        const result: (Text | Link)[] = [], pattern = /!\[\[([^\]\n#|]+)#([^\]\n|]+)\]\]/g
        let start = 0
        for (const match of child.value.matchAll(pattern)) {
          if (match.index > start) result.push({ type: 'text', value: child.value.slice(start, match.index) })
          result.push({ type: 'link', url: `ready-db:${encodeURIComponent(match[1])}#${encodeURIComponent(match[2])}`, children: [{ type: 'text', value: match[0] }] })
          start = match.index + match[0].length
        }
        if (start < child.value.length) result.push({ type: 'text', value: child.value.slice(start) })
        return result
      })
    }
    visit(tree)
  }
}
export function parseDatabaseLink(href: string): { target: string; viewName: string } | null {
  const match = /^ready-db:([^#]+)#(.+)$/.exec(href)
  if (!match) return null
  try { return { target: decodeURIComponent(match[1]), viewName: decodeURIComponent(match[2]) } } catch { return null }
}
