import { posix } from 'node:path'
import { hashBytes } from '../document-drafts/files'
import { readZip } from './zip'
import { assignPaths, outsideCode, relativeLink, type ImportPlan, type ImportPage } from './model'

export function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) { if (char === '"' && text[i + 1] === '"') { value += '"'; i++ } else if (char === '"') { quoted = false; closed = true } else value += char; continue }
    if (char === '"') { if (value || closed) throw new Error('Invalid CSV quote'); quoted = true }
    else if (char === ',' || char === '\n' || char === '\r') {
      row.push(value); value = ''; closed = false
      if (char !== ',') { if (char === '\r' && text[i + 1] === '\n') i++; rows.push(row); row = [] }
    } else { if (closed) throw new Error('Invalid CSV text after quote'); value += char }
  }
  if (quoted) throw new Error('Unclosed CSV quote')
  if (value || row.length || closed) { row.push(value); rows.push(row) }
  if (rows.some(row => row.length !== rows[0].length)) throw new Error('CSV column count mismatch')
  return rows
}
const title = (path: string) => posix.basename(path).replace(/\.(md|csv)$/i, '').replace(/ [0-9a-f]{32}$/i, '')
const sourceId = (path: string) => path.match(/ ([0-9a-f]{32})\.(?:md|csv)$/i)?.[1]?.toLowerCase()
export function parseNotion(bytes: Buffer): ImportPlan {
  const files = readZip(bytes), plan: ImportPlan = { pages: [], assets: [], issues: [] }
  const byPath = new Map<string, ImportPage>(), idPaths = new Map<string, ImportPage>()
  for (const [path, data] of files) if (/\.(md|csv)$/i.test(path)) {
    const page: ImportPage = { source: path, title: title(path), parent: null, body: /\.md$/i.test(path) ? new TextDecoder('utf-8', { fatal: true }).decode(data) : `# ${title(path)}\n`, values: {}, row: false, path: '' }
    const id = sourceId(path)
    // A database may have an accompanying Markdown page with the same export identity.
    const existing = id ? idPaths.get(id) : undefined
    if (existing) {
      if (posix.extname(existing.source) === posix.extname(path)) throw new Error(`Duplicate Notion id: ${id}`)
      if (/\.md$/i.test(path)) existing.body = page.body
      byPath.set(path, existing); continue
    }
    plan.pages.push(page); byPath.set(path, page); if (id) idPaths.set(id, page)
  }
  // Preserve directory-only ancestors too (some exports omit their parent Markdown).
  for (const page of [...plan.pages]) {
    let directory = posix.dirname(page.source)
    while (directory !== '.') {
      if (!byPath.has(directory + '.md') && !byPath.has(directory + '.csv')) {
        const parent: ImportPage = { source: directory + '/', title: title(directory), parent: null, body: '', values: {}, row: false, path: '' }
        plan.pages.push(parent); byPath.set(directory + '.md', parent)
        plan.issues.push({ kind: 'missing', item: directory, message: '导出目录没有父页面正文，以目录名保留层级' })
      }
      directory = posix.dirname(directory)
    }
  }
  for (const page of plan.pages) {
    let directory = posix.dirname(page.source.replace(/\/$/, ''))
    while (directory !== '.') {
      const parent = byPath.get(directory + '.md') ?? byPath.get(directory + '.csv')
      if (parent && parent !== page) { page.parent = parent.source; break }
      directory = posix.dirname(directory)
    }
  }
  for (const [path, data] of files) if (/\.csv$/i.test(path)) {
    const page = byPath.get(path)!, rows = parseCSV(new TextDecoder('utf-8', { fatal: true }).decode(data)), headers = rows.shift()
    if (!headers?.length) { plan.issues.push({ kind: 'missing', item: path, message: 'CSV 没有表头' }); continue }
    page.database = { version: 1, source: 'pending', fields: Object.fromEntries(headers.slice(1).map((name, i) => [`import_${i + 1}`, { id: `import_${i + 1}`, name: name || `列 ${i + 2}`, type: 'text' as const }])), views: [{ id: 'table', name: '表格', type: 'table' }] }
    plan.issues.push({ kind: 'missing', item: path, message: 'Notion CSV 未提供字段类型、原视图、公式及评论；非标题列按原始文本保留' })
    const claimed = new Set<string>()
    for (const [index, values] of rows.entries()) {
      const match = values[0].match(/^\[(.*)\]\((.*)\)$/), rowTitle = match?.[1] ?? values[0]
      const candidates = plan.pages.filter(child => child.parent === page.source && child.title === rowTitle && !claimed.has(child.source))
      let child = match ? byPath.get(posix.normalize(posix.join(posix.dirname(path), decodeURIComponent(match[2])))) : candidates.length === 1 ? candidates[0] : undefined
      if (child && (child.parent !== page.source || claimed.has(child.source))) child = undefined
      if (!child) {
        child = { source: `${path}#row-${index}`, parent: page.source, title: rowTitle || `行 ${index + 1}`, body: '', values: {}, row: true, path: '' }
        plan.pages.push(child)
        if (candidates.length > 1 || match) plan.issues.push({ kind: 'missing', item: child.source, message: 'CSV 行页面未唯一匹配；原页面保留，行数据另存' })
      }
      claimed.add(child.source); child.row = true
      child.values = Object.fromEntries(values.slice(1).map((value, i) => [`import_${i + 1}`, value]))
    }
  }
  for (const page of plan.pages) if (!page.row && plan.pages.some(parent => parent.source === page.parent && parent.database)) {
    page.row = true; plan.issues.push({ kind: 'missing', item: page.source, message: '数据库子页未唯一对应 CSV 行，正文保留，字段未猜测' })
  }
  for (const [path, data] of files) if (!byPath.has(path)) {
    let directory = posix.dirname(path), owner: ImportPage | undefined
    while (directory !== '.') { owner = byPath.get(directory + '.md') ?? byPath.get(directory + '.csv'); if (owner) break; directory = posix.dirname(directory) }
    plan.assets.push({ source: path, owner: owner?.source ?? null, name: posix.basename(path), data: data.toString('base64'), hash: hashBytes(data), path: '' })
  }
  assignPaths(plan)
  for (const page of plan.pages) page.body = outsideCode(page.body, text => text
    .replace(/<aside(?:\s[^>]*)?>([\s\S]*?)<\/aside>/gi, (_, body: string) => body.trim().split('\n').map(line => `> ${line}`).join('\n'))
    .replace(/<details(?:\s[^>]*)?>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_, heading: string, body: string) => `- **${heading.trim()}**\n${body.trim().split('\n').map(line => `  ${line}`).join('\n')}`)
    .replace(/(!?)\[([^\]\n]*)\]\((<[^>]+>|[^)\n]+)\)/g, (original, image: string, label: string, raw: string) => {
      const href = raw.replace(/^<|>$/g, '')
      if (/^(?:https?:|mailto:|data:|#)/i.test(href)) return original
      let decoded: string
      try { decoded = decodeURIComponent(href) } catch { plan.issues.push({ kind: 'missing', item: page.source, message: `无效链接编码：${href}` }); return original }
      const [file, fragment] = decoded.split('#'), target = posix.normalize(posix.join(posix.dirname(page.source), file))
      const linked = byPath.get(target)
      if (linked && !image) return `[[${relativeLink(page.path, linked.path)}${fragment ? '#' + fragment : ''}|${label}]]`
      const asset = plan.assets.find(asset => asset.source === target)
      if (asset) return `${image}[${label}](${encodeURI(posix.relative(posix.dirname(page.path), asset.path))})`
      plan.issues.push({ kind: 'missing', item: page.source, message: `缺失链接或附件：${href}` }); return original
    }))
  for (const page of plan.pages) if (outsideCode(page.body, text => text.replace(/<(?:aside|details|summary)\b[^>]*>/gi, 'UNCONVERTED_NOTION_BLOCK')).includes('UNCONVERTED_NOTION_BLOCK')) plan.issues.push({ kind: 'unsupported', item: page.source, message: '嵌套或未闭合的 callout/toggle 保留原文，未完整转换' })
  if (!plan.pages.length) throw new Error('ZIP contains no Markdown or CSV pages')
  return plan
}
