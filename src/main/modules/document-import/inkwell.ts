import { z } from 'zod'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, basename, posix } from 'node:path'
import { checkedPath, hashBytes } from '../document-drafts/files'
import { DatabaseDefinitionSchema, fieldValue, type DatabaseField, type DatabaseView } from '../../../shared/document-database'
import { assignPaths, relativeLink, type ImportPlan, type ImportPage } from './model'
import { LIMITS, safeArchivePath } from './zip'
const marks = z.object({ b: z.number().optional(), i: z.number().optional(), s: z.number().optional(), code: z.number().optional(), link: z.string().optional(), mention: z.object({ kind: z.string(), id: z.string().optional(), value: z.string().optional() }).passthrough().optional() }).passthrough()
const richText = z.array(z.tuple([z.string(), marks.optional()]))
const blockSchema = z.object({ id: z.string().min(1), type: z.string(), title: richText.optional(), parent: z.string(), parentTable: z.enum(['block', 'space']), alive: z.boolean(), created: z.number(), content: z.array(z.string()).default([]), props: z.record(z.string(), z.unknown()).default({}), format: z.record(z.string(), z.unknown()).optional() }).passthrough()
const backupSchema = z.object({ format: z.literal('inkwell-backup'), version: z.literal(1), blocks: z.array(blockSchema).max(LIMITS.entries), space: z.object({ id: z.string() }).passthrough() }).passthrough()
const propSchema = z.object({ name: z.string(), type: z.string(), options: z.array(z.object({ v: z.string() }).passthrough()).optional() }).passthrough()
const sourceViewSchema = z.object({ id: z.string(), name: z.string(), type: z.enum(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']), sort: z.array(z.object({ prop: z.string(), dir: z.enum(['asc', 'desc']) })).optional(), filter: z.array(z.object({ prop: z.string(), op: z.string(), value: z.unknown().optional() })).optional(), group: z.string().optional(), dateProp: z.string().optional(), order: z.array(z.string()).optional(), hidden: z.array(z.string()).optional(), cardProps: z.array(z.string()).optional(), calcs: z.record(z.string(), z.string()).optional() }).passthrough()
type Block = z.infer<typeof blockSchema>
export function parseInkwell(bytes: Buffer, sourcePath: string): ImportPlan {
  const snapshot = backupSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), blocks = new Map(snapshot.blocks.map(block => [block.id, block]))
  if (blocks.size !== snapshot.blocks.length) throw new Error('Duplicate Inkwell block id')
  // A block tree has one owner per child; reject shared subtrees before recursive rendering.
  for (const block of blocks.values()) {
    if (new Set(block.content).size !== block.content.length) throw new Error('Duplicate Inkwell child reference')
    for (const id of block.content) { const child = blocks.get(id); if (child && (child.parent !== block.id || child.parentTable !== 'block')) throw new Error('Inkwell child ownership mismatch') }
  }
  const plan: ImportPlan = { pages: [], assets: [], issues: [] }, pageTypes = new Set(['page', 'collection_view_page', 'collection_view'])
  const issue = (item: string, message: string, kind: 'missing' | 'unsupported' = 'unsupported') => plan.issues.push({ kind, item, message })
  const plain = (block: Block) => block.title?.map(segment => segment[0]).join('') || '未命名'
  const schemaByPage = new Map<string, Record<string, z.infer<typeof propSchema>>>()
  for (const block of blocks.values()) if (block.alive && pageTypes.has(block.type)) {
    let parent = blocks.get(block.parent); const ancestors = new Set([block.id])
    while (parent && !pageTypes.has(parent.type)) { if (ancestors.has(parent.id)) throw new Error('Cyclic Inkwell parent'); ancestors.add(parent.id); parent = blocks.get(parent.parent) }
    if (block.parentTable === 'block' && !parent) issue(block.id, `缺失父块：${block.parent}`, 'missing')
    if (parent && !parent.alive) { issue(block.id, '父页面已删除，当前页面保留在导入根目录', 'missing'); parent = undefined }
    const page: ImportPage = { source: block.id, title: plain(block), parent: parent?.id ?? null, body: '', values: {}, row: !!parent && parent.type !== 'page', path: '' }
    if (block.type !== 'page') {
      const schema = z.record(z.string(), propSchema).parse(block.props.schema ?? {}); schemaByPage.set(block.id, schema)
      const fields: Record<string, DatabaseField> = {}, mapField = (id: string) => schema[id]?.type === 'title' ? '$title' : `import_${id}`
      for (const [id, prop] of Object.entries(schema)) {
        if (prop.type === 'title') continue
        const type = ({ status: 'select', email: 'text', phone_number: 'text', person: 'text', file: 'text', created_time: 'date', formula: 'text', rollup: 'text' } as Record<string, string>)[prop.type] ?? prop.type
        const field = z.enum(['text', 'number', 'checkbox', 'url', 'select', 'multi_select', 'date', 'relation']).safeParse(type)
        fields[mapField(id)] = { id: mapField(id), name: prop.name, type: field.success ? field.data : 'text', ...(prop.options ? { options: prop.options.map(option => option.v) } : {}) }
        if (['person', 'file', 'formula', 'rollup'].includes(prop.type) || !field.success) issue(`${block.id}/${id}`, `${prop.type} 以文本保留，未恢复其交互或计算行为`)
      }
      const views: DatabaseView[] = z.array(sourceViewSchema).parse(block.props.views ?? []).map(view => {
        const result: DatabaseView = { id: view.id, name: view.name, type: view.type, sorts: view.sort?.map(sort => ({ field: mapField(sort.prop), direction: sort.dir })), visibleFields: (view.order ?? Object.keys(schema)).filter(id => !view.hidden?.includes(id)).map(mapField), cardFields: view.cardProps?.map(mapField), groupBy: view.group ? mapField(view.group) : undefined, dateField: view.dateProp ? mapField(view.dateProp) : undefined, filters: [], calculations: [] }
        for (const filter of view.filter ?? []) {
          const operator = ({ is: 'eq', is_not: 'neq', before: 'lt', after: 'gt', checked: 'eq', unchecked: 'eq' } as Record<string, string>)[filter.op] ?? filter.op
          const parsed = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty']).safeParse(operator)
          if (parsed.success) {
            let value = filter.op === 'checked' ? true : filter.op === 'unchecked' ? false : filter.value
            if (schema[filter.prop]?.type === 'number' && typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) value = Number(value)
            result.filters!.push({ field: mapField(filter.prop), operator: parsed.data, value })
          }
          else issue(`${block.id}/${view.id}`, `未恢复筛选 ${filter.op}`)
        }
        for (const [id, calc] of Object.entries(view.calcs ?? {})) {
          if (calc === 'none') continue
          const parsed = z.enum(['count', 'sum', 'average', 'min', 'max', 'unique']).safeParse(calc === 'count_all' ? 'count' : calc)
          if (parsed.success) result.calculations!.push({ field: mapField(id), operation: parsed.data }); else issue(`${block.id}/${view.id}`, `未恢复汇总 ${calc}`)
        }
        for (const key of Object.keys(view)) if (!['id', 'name', 'type', 'sort', 'filter', 'group', 'dateProp', 'order', 'hidden', 'cardProps', 'calcs'].includes(key)) issue(`${block.id}/${view.id}`, `未恢复视图选项 ${key}`)
        return result
      })
      page.database = DatabaseDefinitionSchema.parse({ version: 1, source: 'pending', fields, views: views.length ? views : [{ id: 'table', name: '表格', type: 'table' }] })
    }
    plan.pages.push(page)
  }
  assignPaths(plan)
  const pages = new Map(plan.pages.map(page => [page.source, page]))
  let total = 0
  const media = (url: string, owner: ImportPage, name: string): string => {
    if (/^https?:/i.test(url)) { issue(owner.source, `远程附件未下载：${url}`, 'missing'); return url }
    let data: Buffer
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/)
      if (!match) { issue(owner.source, '不支持的内嵌附件格式'); return url }
      data = Buffer.from(match[2], 'base64')
      if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.' + (match[1].split('/')[1].replace('jpeg', 'jpg'))
    } else {
      if (/^[a-z]+:/i.test(url)) { issue(owner.source, `附件地址不可读取：${url}`, 'missing'); return url }
      const relative = safeArchivePath(decodeURIComponent(url)), path = checkedPath(dirname(sourcePath), join(dirname(sourcePath), relative))
      try { if (statSync(path).size > LIMITS.entry) throw new Error('Attachment size limit'); data = readFileSync(path) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; issue(owner.source, `缺失附件：${url}`, 'missing'); return url }
    }
    total += data.length
    if (data.length > LIMITS.entry || total > LIMITS.total) throw new Error('Attachment size limit')
    const source = `${owner.source}/${plan.assets.length}`, token = `READY_IMPORT_ASSET_${plan.assets.length}`
    plan.assets.push({ source, owner: owner.source, name, data: data.toString('base64'), hash: hashBytes(data), path: '' })
    return token
  }
  const inline = (text: z.infer<typeof richText> | undefined, owner: ImportPage): string => (text ?? []).map(([text, mark]) => {
    if (mark?.mention?.kind === 'page') { const target = pages.get(mark.mention.id ?? ''); if (target) return `[[${relativeLink(owner.path, target.path)}|${target.title}]]`; issue(owner.source, `页面提及缺失：${mark.mention.id}`, 'missing') }
    if (mark?.mention && !['page', 'date'].includes(mark.mention.kind)) issue(owner.source, `未恢复提及 ${mark.mention.kind}`)
    if (mark?.mention?.kind === 'date') text = mark.mention.value ?? text
    if (mark?.code) text = '`' + text + '`'; if (mark?.b) text = '**' + text + '**'; if (mark?.i) text = '*' + text + '*'; if (mark?.s) text = '~~' + text + '~~'
    if (mark?.link) {
      const id = mark.link.match(/^(?:inkwell:\/\/page\/|#\/p\/)([^#?]+)$/)?.[1]
      const target = id ? pages.get(id) : undefined
      if (target) text = `[[${relativeLink(owner.path, target.path)}|${text}]]`
      else { if (id) issue(owner.source, `内部链接缺失：${id}`, 'missing'); text = `[${text}](${mark.link})` }
    }
    for (const key of Object.keys(mark ?? {})) if (!['b', 'i', 's', 'code', 'link', 'mention'].includes(key)) issue(owner.source, `未恢复行内标记 ${key}`)
    return text
  }).join('')
  const visited = new Set<string>()
  const render = (id: string, owner: ImportPage, ancestors: Set<string>): string => {
    if (ancestors.has(id) || ancestors.size > 64) throw new Error('Cyclic or deep Inkwell block tree')
    const block = blocks.get(id)
    if (!block) { issue(owner.source, `缺失块：${id}`, 'missing'); return '' }
    if (!block.alive) return ''
    visited.add(id)
    if (pageTypes.has(block.type)) { const target = pages.get(id); return target ? `[[${relativeLink(owner.path, target.path)}|${target.title}]]` : '' }
    const stack = new Set(ancestors).add(id), text = inline(block.title, owner)
    const children = block.content.map(id => render(id, owner, stack)).join('\n\n')
    if (block.props.discussions) issue(id, '评论未迁移')
    for (const key of Object.keys(block.format ?? {})) issue(id, `未恢复块外观 ${key}`)
    const headings: Record<string, string> = { header: '#', sub_header: '##', sub_sub_header: '###', header_4: '####' }
    let body = text
    if (headings[block.type]) body = headings[block.type] + ' ' + text
    else switch (block.type) {
      case 'text': break
      case 'bulleted_list': case 'toggle': body = '- ' + text; break
      case 'numbered_list': body = '1. ' + text; break
      case 'to_do': body = `- [${block.props.checked ? 'x' : ' '}] ${text}`; break
      case 'quote': case 'callout': body = text.split('\n').map(line => '> ' + line).join('\n'); break
      case 'code': body = `\`\`\`\`${z.string().parse(block.props.language ?? '')}\n${block.title?.map(s => s[0]).join('') ?? ''}\n\`\`\`\``; break
      case 'divider': body = '---'; break
      case 'equation': body = `$$\n${z.string().parse(block.props.tex ?? text)}\n$$`; break
      case 'table': {
        const rows = block.content.map(id => { const row = blocks.get(id); if (!row) { issue(id, '缺失表格行', 'missing'); return [] } visited.add(id); return z.array(richText).parse(row.props.cells ?? []).map(cell => inline(cell, owner).replace(/\|/g, '\\|').replace(/\n/g, '<br>')) })
        return rows.map((row, i) => '| ' + row.join(' | ') + ' |' + (i === 0 ? '\n| ' + row.map(() => '---').join(' | ') + ' |' : '')).join('\n')
      }
      case 'table_row': return ''
      case 'image': case 'file': case 'audio': case 'video': case 'pdf': {
        const url = z.string().parse(block.props.src ?? block.props.url ?? ''), name = typeof block.props.fileName === 'string' ? block.props.fileName : url.startsWith('data:') ? block.id : basename(url.split('?')[0]) || block.id
        body = `${block.type === 'image' ? '!' : ''}[${text || block.type}](${media(url, owner, name.startsWith('data:') ? block.id : name)})`; break
      }
      default: issue(id, `未恢复块行为 ${block.type}，可读文字及子块保留`)
    }
    if (children) body += '\n\n' + (['toggle', 'bulleted_list', 'numbered_list', 'to_do'].includes(block.type) ? children.split('\n').map(line => '  ' + line).join('\n') : children)
    return body
  }
  for (const page of plan.pages) {
    const block = blocks.get(page.source)!; visited.add(block.id)
    page.body = '# ' + page.title + '\n\n' + block.content.map(id => render(id, page, new Set([block.id]))).join('\n\n') + '\n'
    if (block.props.discussions) issue(block.id, '页面评论未迁移')
    for (const key of Object.keys(block.format ?? {})) issue(block.id, `未恢复页面外观 ${key}`)
    const schema = page.parent ? schemaByPage.get(page.parent) : undefined
    if (schema) for (const [id, prop] of Object.entries(schema)) {
      if (prop.type === 'title') continue
      let value = block.props[id]
      if (prop.type === 'date' && Array.isArray(value)) {
        const dates = z.array(z.string()).max(2).parse(value); value = dates.length === 0 ? null : dates.length === 1 || !dates[1] ? dates[0] : { start: dates[0], end: dates[1] }
      }
      if (prop.type === 'created_time') value = new Date(block.created).toISOString()
      if (prop.type === 'formula' || prop.type === 'rollup') value = JSON.stringify(prop)
      if (value === undefined) continue
      if (prop.type === 'relation') value = z.array(z.string()).parse(value).map(id => { const target = pages.get(id); if (!target) { issue(page.source, `关联缺失：${id}`, 'missing'); return `[[missing-${id}]]` } return `[[${relativeLink(page.path, target.path)}]]` })
      if (['person', 'file'].includes(prop.type)) value = JSON.stringify(value)
      const field = pages.get(page.parent!)!.database!.fields[`import_${id}`]
      try { page.values[`import_${id}`] = fieldValue(field, value) }
      catch (error) { issue(`${page.source}/${id}`, `字段值不能映射：${String(error)}`); page.values[`import_raw_${id}`] = value }
    }
  }
  for (const block of blocks.values()) if (block.alive && !visited.has(block.id)) issue(block.id, '未被页面树引用的块', 'missing')
  assignPaths(plan)
  for (const page of plan.pages) page.body = page.body.replace(/READY_IMPORT_ASSET_(\d+)/g, (_, index: string) => {
    const asset = plan.assets[Number(index)]; return encodeURI(posix.relative(posix.dirname(page.path), asset.path))
  })
  if (!plan.pages.length) throw new Error('Inkwell backup contains no pages')
  return plan
}
