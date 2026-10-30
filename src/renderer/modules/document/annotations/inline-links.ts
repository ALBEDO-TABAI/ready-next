import type { Root, Parent, Text, Link } from 'mdast'
export function remarkSyncedBlocks() {
  return (tree: Root) => {
    const visit = (node: Parent) => {
      if (['link', 'linkReference', 'code', 'inlineCode', 'html'].includes(node.type)) return
      node.children = node.children.flatMap<Parent['children'][number]>(child => {
        if (child.type !== 'text') { if ('children' in child) visit(child); return [child] }
        const result: (Text | Link)[] = []; let start = 0
        for (const match of child.value.matchAll(/!\[\[([^[\]|\r\n]*?)#\^([\w-]+)\]\]/g)) {
          if (match.index > start) result.push({ type: 'text', value: child.value.slice(start, match.index) })
          result.push({ type: 'link', url: `ready-sync:${encodeURIComponent(match[1])}#${match[2]}`, children: [{ type: 'text', value: match[0] }] })
          start = match.index + match[0].length
        }
        if (start < child.value.length) result.push({ type: 'text', value: child.value.slice(start) })
        return result
      })
    }
    visit(tree)
  }
}
