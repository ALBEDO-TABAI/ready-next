import type { Blockquote, Paragraph, Parent, PhrasingContent, Root } from 'mdast'

// Obsidian-style callouts: "> [!type|color]± title" followed by the body. The header line and the first body lines
// share one Markdown paragraph, so the plugin splits it at the first line break into a title and a body.
const HEADER = /^\[!([\w-]+)(?:\|([\w-]+))?\]([-+]?)[ \t]*/
const TITLES: Record<string, string> = {
  note: '笔记', tip: '提示', hint: '提示', warning: '注意', attention: '注意', caution: '小心', important: '重要', info: '信息',
  quote: '引用', cite: '引用', abstract: '摘要', summary: '摘要', todo: '待办', success: '完成', done: '完成', question: '问题',
  help: '问题', faq: '问题', failure: '失败', fail: '失败', missing: '缺失', danger: '危险', error: '错误', bug: '缺陷', example: '示例',
}

export function remarkCallouts() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      for (const child of parent.children) {
        if (child.type === 'blockquote') transform(child)
        if ('children' in child && Array.isArray(child.children)) visit(child as Parent)
      }
    }
    visit(tree)
  }
}

function transform(node: Blockquote) {
  const first = node.children[0]
  if (first?.type !== 'paragraph') return
  const lead = first.children[0]
  if (lead?.type !== 'text') return
  const match = HEADER.exec(lead.value)
  if (!match) return
  const [, rawType, color, fold] = match
  const type = rawType.toLowerCase()
  const title: PhrasingContent[] = [], body: PhrasingContent[] = []
  let inBody = false
  for (const child of [{ ...lead, value: lead.value.slice(match[0].length) }, ...first.children.slice(1)] as PhrasingContent[]) {
    if (inBody) { body.push(child); continue }
    if (child.type === 'break') { inBody = true; continue }
    if (child.type === 'text' && child.value.includes('\n')) {
      const index = child.value.indexOf('\n')
      if (index > 0) title.push({ ...child, value: child.value.slice(0, index) })
      const after = child.value.slice(index + 1)
      if (after) body.push({ ...child, value: after })
      inBody = true; continue
    }
    title.push(child)
  }
  const named = title.filter(item => item.type !== 'text' || item.value.trim())
  const header: Paragraph = { type: 'paragraph', children: named.length ? named : [{ type: 'text', value: TITLES[type] ?? rawType }],
    data: { hName: fold ? 'summary' : 'div', hProperties: { className: ['ready-callout-title'] } } }
  const rest = [...(body.length ? [{ type: 'paragraph', children: body } as Paragraph] : []), ...node.children.slice(1)]
  // A blockquote node renamed to a div keeps the body's block children together.
  const content: Blockquote = { type: 'blockquote', children: rest, data: { hName: 'div', hProperties: { className: ['ready-callout-body'] } } }
  node.children = rest.length ? [header, content] : [header]
  node.data = { hName: fold ? 'details' : 'aside', hProperties: {
    className: ['ready-callout'], dataCallout: type, dataCalloutColor: color?.toLowerCase(), open: fold === '+' ? true : undefined,
  } }
}
