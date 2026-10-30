import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml'
import { readDocumentSource, setFrontmatterFields } from '../document-operations'
import { DatabaseDefinitionSchema, fieldEntry, fieldValue, type DatabaseDefinition } from './schema'

export function readDatabase(content: string): DatabaseDefinition {
  return DatabaseDefinitionSchema.parse(readDocumentSource(content).frontmatter.ready_database)
}

/** Edit only the database YAML node; retain comments on its existing nodes and all outside bytes. */
export function writeDatabase(content: string, input: DatabaseDefinition): string {
  const next = DatabaseDefinitionSchema.parse(input), source = readDocumentSource(content)
  if (JSON.stringify(source.frontmatter.ready_database) === JSON.stringify(next)) return content
  if (source.frontmatter.ready_database === undefined) return setFrontmatterFields(content, { set: { ready_database: next } })
  const opening = /^(?:\uFEFF)?---[^\n]*\n/.exec(content)!
  const doc = parseDocument(content.slice(opening[0].length, source.bodyStart))
  if (!isMap(doc.contents)) throw new Error('Frontmatter must be a map')
  const pair = doc.contents.items.find(p => isScalar(p.key) && p.key.value === 'ready_database')!
  if (!isScalar(pair.key) || !pair.key.range || !pair.value || !('range' in pair.value) || !pair.value.range) throw new Error('Database has no editable source range')
  const start = opening[0].length + pair.key.range[0], end = opening[0].length + pair.value.range[2]
  const fragment = parseDocument(content.slice(start, end))
  const update = (node: unknown, value: unknown): Node => {
    if (isMap(node) && value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value)
      for (const [key, child] of entries) {
        if (node.has(key) || !child || typeof child !== 'object' || !('id' in child)) continue
        const moved = node.items.find(item => isMap(item.value) && item.value.get('id') === child.id)
        if (moved && isScalar(moved.key)) moved.key.value = key
      }
      for (const item of [...node.items]) { const key = isScalar(item.key) ? item.key.value : undefined; if (key !== undefined && !entries.some(([name]) => name === key)) node.delete(key) }
      for (const [key, child] of entries) node.set(key, update(node.get(key, true), child))
      return node
    }
    if (isSeq(node) && Array.isArray(value)) {
      const old = [...node.items]
      node.items = value.map((child, i) => {
        const identity = child && typeof child === 'object' && 'id' in child ? child.id : undefined
        const previous = identity ? old.find(n => isMap(n) && n.get('id') === identity) : old[i]
        return update(previous, child)
      })
      return node
    }
    if (isScalar(node) && (value === null || typeof value !== 'object')) { node.value = value; return node }
    const created = fragment.createNode(value)
    if (node && typeof node === 'object') {
      if ('comment' in node && typeof node.comment === 'string') created.comment = node.comment
      if ('commentBefore' in node && typeof node.commentBefore === 'string') created.commentBefore = node.commentBefore
    }
    return created
  }
  fragment.set('ready_database', update(fragment.get('ready_database', true), next))
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const result = content.slice(0, start) + fragment.toString({ lineWidth: 0 }).replace(/\n/g, newline) + content.slice(end)
  readDatabase(result)
  return result
}

export function rowPatch(definition: DatabaseDefinition, set: Record<string, unknown>, remove: string[] = []) {
  const fields: Record<string, unknown> = {}, deleted: string[] = []
  for (const [id, value] of Object.entries(set)) {
    const [key, field] = fieldEntry(definition, id)
    if (['formula', 'rollup'].includes(field.type)) throw new Error(`computed field ${id} cannot be stored`)
    try { fields[key] = fieldValue(field, value) } catch (error) { throw new Error(`Field ${key} (${id}): ${String(error)}`) }
  }
  for (const id of remove) {
    const [key, field] = fieldEntry(definition, id)
    if (['formula', 'rollup'].includes(field.type)) throw new Error(`computed field ${id} cannot be stored`)
    deleted.push(key)
  }
  return { set: fields, remove: deleted }
}
export function patchRow(content: string, definition: DatabaseDefinition, set: Record<string, unknown>, remove: string[] = []): string {
  return setFrontmatterFields(content, rowPatch(definition, set, remove))
}
