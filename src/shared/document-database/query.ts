import { fieldValue, type Cell, type Calculation, type DatabaseDefinition, type DatabaseRow, type DatabaseView, type Relations } from './schema'
import { evaluateFormula, FormulaError, parseFormula } from './formula'

export function calculate(operation: Calculation, cells: Cell[]): Cell {
  const failed = cells.find(cell => cell.status !== 'value')
  if (failed) return { status: 'incomplete', reasons: [failed.status === 'error' ? failed.message : failed.status === 'incomplete' ? failed.reasons.join('; ') : ''] }
  const values = cells.flatMap(cell => cell.status === 'value' && cell.value !== null && cell.value !== undefined ? [cell.value] : [])
  if (operation === 'count') return { status: 'value', value: values.length }
  if (operation === 'unique') return { status: 'value', value: [...new Set(values.flatMap(v => Array.isArray(v) ? v : [v]))] }
  if (values.some(v => typeof v !== 'number' || !Number.isFinite(v))) return { status: 'error', code: 'type', message: 'Calculation requires finite numbers' }
  const numbers = values.filter((v): v is number => typeof v === 'number')
  const sum = numbers.reduce((a, b) => a + b, 0)
  const value = operation === 'sum' ? sum : !numbers.length ? null : operation === 'average' ? sum / numbers.length : operation === 'min' ? Math.min(...numbers) : Math.max(...numbers)
  return typeof value === 'number' && !Number.isFinite(value) ? { status: 'error', code: 'non_finite', message: 'Calculation overflow' } : { status: 'value', value }
}
function comparable(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 'start' in value) return comparable(value.start)
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toISOString()
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : JSON.stringify(value)
}
function compare(a: unknown, b: unknown): number {
  const x = comparable(a), y = comparable(b)
  if (x === y) return 0
  if (x === null) return 1
  if (y === null) return -1
  if (typeof x !== typeof y) return typeof x < typeof y ? -1 : 1
  return x < y ? -1 : 1
}
export function queryDatabase(def: DatabaseDefinition, rows: DatabaseRow[], view: DatabaseView, relations: Relations = {}, page: { offset: number; limit: number } = { offset: 0, limit: 1000 }) {
  if (!Number.isInteger(page.offset) || !Number.isInteger(page.limit) || page.offset < 0 || page.limit < 1 || page.limit > 1000) throw new Error('Invalid pagination')
  const fields = new Map(Object.entries(def.fields).map(([key, field]) => [field.id, { key, field }]))
  const formulae = new Map<string, ReturnType<typeof parseFormula> | Error>()
  for (const { field } of fields.values()) if (field.type === 'formula') {
    try { formulae.set(field.id, parseFormula(field.expression!)) } catch (error) { formulae.set(field.id, error instanceof Error ? error : new Error(String(error))) }
  }
  const issues: { rowId: string; fieldId: string; cell: Cell }[] = []
  const projected = rows.map(row => {
    const cells: Record<string, Cell> = Object.create(null), active = new Set<string>()
    cells.$id = { status: 'value', value: row.id }; cells.$title = { status: 'value', value: row.title }
    const cell = (id: string): Cell => {
      if (cells[id]) return cells[id]
      if (active.has(id)) return { status: 'error', code: 'cycle', message: `Formula cycle at ${id}` }
      const item = fields.get(id)
      if (!item) return { status: 'error', code: 'unknown_field', message: `Unknown field ${id}` }
      active.add(id)
      const { key, field } = item
      let result: Cell
      try {
        if (['formula', 'rollup'].includes(field.type) && Object.hasOwn(row.values, key)) throw new FormulaError('stored_computed', `Computed field ${key} has a stored value`)
        if (field.type === 'formula') {
          const tree = formulae.get(id)!
          if (tree instanceof Error) throw tree
          const value = evaluateFormula(tree, ref => {
            const dependency = cell(ref)
            if (dependency.status !== 'value') throw new FormulaError(dependency.status === 'error' ? dependency.code : 'incomplete', `Dependency ${ref}: ${JSON.stringify(dependency)}`)
            return dependency.value
          })
          result = { status: 'value', value }
        } else if (field.type === 'rollup') {
          const linked = relations[row.id]?.[field.relation!], source = cell(field.relation!)
          if (source.status !== 'value') result = source
          else if (!linked) result = source.value === undefined || source.value === null || Array.isArray(source.value) && !source.value.length ? calculate(field.operation!, []) : { status: 'incomplete', reasons: ['Relations were not resolved'] }
          else if (!linked.complete || linked.reasons.length) result = { status: 'incomplete', reasons: linked.reasons.length ? linked.reasons : ['Relation results truncated'] }
          else result = calculate(field.operation!, linked.rows.map(values => ({ status: 'value', value: field.operation === 'count' ? 1 : values[field.target!] })))
        } else result = { status: 'value', value: fieldValue(field, row.values[key]) }
      } catch (error) { result = { status: 'error', code: error instanceof FormulaError ? error.code : 'invalid_value', message: `${row.id}/${id}: ${String(error)}` } }
      active.delete(id); cells[id] = result; return result
    }
    for (const id of fields.keys()) { const value = cell(id); if (value.status !== 'value') issues.push({ rowId: row.id, fieldId: id, cell: value }) }
    return { ...row, cells }
  }).filter(row => (view.filters ?? []).every(filter => {
    const cell = row.cells[filter.field]
    if (!cell || cell.status !== 'value') return false
    const value = cell.value, empty = value === undefined || value === null || value === '' || Array.isArray(value) && !value.length
    switch (filter.operator) {
      case 'empty': return empty
      case 'not_empty': return !empty
      case 'eq': return JSON.stringify(value) === JSON.stringify(filter.value)
      case 'neq': return JSON.stringify(value) !== JSON.stringify(filter.value)
      case 'contains': return Array.isArray(value) ? value.includes(filter.value) : typeof value === 'string' && typeof filter.value === 'string' && value.includes(filter.value)
      default: { if (empty) return false; const order = compare(value, filter.value); return filter.operator === 'gt' ? order > 0 : filter.operator === 'gte' ? order >= 0 : filter.operator === 'lt' ? order < 0 : order <= 0 }
    }
  }))
  projected.sort((a, b) => {
    for (const sort of view.sorts ?? []) {
      const x = a.cells[sort.field], y = b.cells[sort.field]
      const order = compare(x?.status === 'value' ? x.value : null, y?.status === 'value' ? y.value : null)
      if (order) return sort.direction === 'desc' ? -order : order
    }
    return a.id < b.id ? -1 : a.id === b.id ? 0 : 1
  })
  const groups = new Map<string, { value: unknown; rowIds: string[] }>()
  if (view.groupBy) for (const row of projected) {
    const cell = row.cells[view.groupBy], value = cell?.status === 'value' ? cell.value : null
    for (const group of Array.isArray(value) ? value.length ? value : [null] : [value ?? null]) {
      const key = JSON.stringify(group), entry = groups.get(key) ?? { value: group, rowIds: new Array<string>() }
      entry.rowIds.push(row.id); groups.set(key, entry)
    }
  }
  const calculations: Record<string, Cell> = Object.create(null)
  for (const calculation of view.calculations ?? []) calculations[calculation.field] = calculate(calculation.operation, projected.map(row => row.cells[calculation.field] ?? { status: 'error', code: 'unknown_field', message: calculation.field }))
  return { rows: projected.slice(page.offset, page.offset + page.limit), total: projected.length, groups: [...groups.values()], calculations, issues }
}
export function projectView(def: DatabaseDefinition, rows: DatabaseRow[], view: DatabaseView, relations: Relations = {}, page?: { offset: number; limit: number }) {
  const eligible = view.type === 'bookshelf' ? rows.filter(row => row.values.类型 === '书') : rows
  const result = queryDatabase(def, eligible, view, relations, page)
  return { ...result, viewId: view.id, type: view.type, visibleFields: view.visibleFields ?? ['$title', ...Object.values(def.fields).map(f => f.id)], dateField: view.dateField ?? null }
}
export function resolveInlineView(databaseId: string, def: DatabaseDefinition, name: string, ancestors: { databaseId: string; viewId: string }[]): DatabaseView {
  const view = def.views.find(v => v.name === name)
  if (!view) throw new Error(`missing view: ${name}`)
  if (ancestors.some(parent => parent.databaseId === databaseId && parent.viewId === view.id)) throw new Error(`inline cycle: ${name}`)
  return view
}
