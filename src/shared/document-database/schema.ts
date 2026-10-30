import { z } from 'zod'

const id = z.string().min(1).max(200).refine(s => !s.startsWith('$') && ![...s].some(c => c.charCodeAt(0) < 32), 'Invalid identity')
export const StorageKeySchema = id.refine(s => !['__proto__', 'prototype', 'constructor', 'title', 'ready_id', 'ready_database'].includes(s), 'Reserved storage key')
const operation = z.enum(['count', 'sum', 'average', 'min', 'max', 'unique'])
export const FieldSchema = z.object({
  id, name: z.string().min(1), type: z.enum(['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'relation', 'rollup', 'formula']),
  options: z.array(z.string()).optional(), expression: z.string().min(1).max(4096).optional(),
  relation: id.optional(), target: z.string().min(1).optional(), operation: operation.optional(),
}).passthrough().superRefine((f, ctx) => {
  if (f.type === 'formula' && !f.expression) ctx.addIssue({ code: 'custom', path: ['expression'], message: 'Formula requires expression' })
  if (f.type === 'rollup' && (!f.relation || !f.target || !f.operation)) ctx.addIssue({ code: 'custom', message: 'Rollup requires relation, target and operation' })
  if (f.options && new Set(f.options).size !== f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' })
})
export const ViewSchema = z.object({
  id, name: z.string().min(1), type: z.enum(['table', 'board', 'calendar', 'timeline', 'gallery', 'list', 'bookshelf']),
  filters: z.array(z.object({ field: z.string().min(1), operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'empty', 'not_empty']), value: z.unknown().optional() }).passthrough()).optional(),
  sorts: z.array(z.object({ field: z.string().min(1), direction: z.enum(['asc', 'desc']) }).passthrough()).optional(),
  groupBy: z.string().optional(), dateField: z.string().optional(),
  calculations: z.array(z.object({ field: z.string().min(1), operation }).passthrough()).optional(),
  visibleFields: z.array(z.string()).optional(), cardFields: z.array(z.string()).optional(),
}).passthrough()
export const DatabaseDefinitionSchema = z.object({
  version: z.literal(1), source: z.string().min(1).refine(s => !/[\\/:]/.test(s) && ![...s].some(c => c.charCodeAt(0) < 32) && !s.startsWith('.') && !s.endsWith('.assets') && s !== '..', 'Source must be a sibling directory'),
  recursive: z.boolean().optional(), fields: z.record(StorageKeySchema, FieldSchema), views: z.array(ViewSchema).min(1),
}).passthrough().superRefine((d, ctx) => {
  const fields = Object.values(d.fields), ids = new Set(fields.map(f => f.id))
  if (ids.size !== fields.length) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Field ids must be unique' })
  if (new Set(d.views.map(v => v.id)).size !== d.views.length || new Set(d.views.map(v => v.name)).size !== d.views.length) ctx.addIssue({ code: 'custom', path: ['views'], message: 'View ids and names must be unique' })
  const check = (ref: string, path: (string | number)[]) => { if (!ids.has(ref) && !['$title', '$id'].includes(ref)) ctx.addIssue({ code: 'custom', path, message: `Unknown field: ${ref}` }) }
  fields.forEach(f => { if (f.type === 'rollup' && !fields.some(r => r.id === f.relation && r.type === 'relation')) ctx.addIssue({ code: 'custom', path: ['fields', f.id], message: 'Rollup relation must reference a relation field' }) })
  d.views.forEach((v, i) => {
    for (const ref of [...(v.filters ?? []).map(f => f.field), ...(v.sorts ?? []).map(f => f.field), ...(v.calculations ?? []).map(f => f.field), ...(v.visibleFields ?? []), ...(v.cardFields ?? []), ...(v.groupBy ? [v.groupBy] : []), ...(v.dateField ? [v.dateField] : [])]) check(ref, ['views', i])
    if (new Set((v.calculations ?? []).map(c => c.field)).size !== (v.calculations ?? []).length) ctx.addIssue({ code: 'custom', path: ['views', i, 'calculations'], message: 'Each field has one column calculation' })
    if (v.dateField && !fields.some(f => f.id === v.dateField && f.type === 'date')) ctx.addIssue({ code: 'custom', path: ['views', i, 'dateField'], message: 'Date field must have date type' })
  })
})
export type DatabaseDefinition = z.infer<typeof DatabaseDefinitionSchema>
export type DatabaseField = z.infer<typeof FieldSchema>
export type DatabaseView = z.infer<typeof ViewSchema>
export type Calculation = z.infer<typeof operation>
export interface DatabaseRow { id: string; title: string; version: string; values: Record<string, unknown> }
export type Cell = { status: 'value'; value: unknown } | { status: 'error'; code: string; message: string } | { status: 'incomplete'; reasons: string[] }
export interface RelationResult { rows: Record<string, unknown>[]; complete: boolean; reasons: string[] }
export type Relations = Record<string, Record<string, RelationResult>>

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(s); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s }, 'Invalid calendar date')
const instant = z.string().datetime({ offset: true })
const datePoint = z.union([day, instant])
const dateValue = z.union([datePoint, z.object({ start: datePoint, end: datePoint }).strict().refine(v => v.start.length === 10 === (v.end.length === 10) && (v.start.length === 10 ? v.start <= v.end : Date.parse(v.start) <= Date.parse(v.end)), 'Invalid date range')])
const list = z.array(z.string()).refine(v => new Set(v).size === v.length, 'Values must be unique')
export function fieldValue(field: DatabaseField, value: unknown): unknown {
  if (value === undefined || value === null) return value
  let parsed: unknown
  switch (field.type) {
    case 'text': case 'select': parsed = z.string().parse(value); break
    case 'number': parsed = z.number().finite().parse(value); break
    case 'checkbox': parsed = z.boolean().parse(value); break
    case 'url': parsed = z.string().url().refine(s => /^https?:\/\//i.test(s), 'Expected http(s) URL').parse(value); break
    case 'date': parsed = dateValue.parse(value); break
    case 'multi_select': parsed = list.parse(value); break
    case 'relation': parsed = list.refine(v => v.every(s => /^\[\[[^[\]\n|#]+\]\]$/.test(s)), 'Expected [[page]] list').parse(value); break
    default: throw new Error(`computed field ${field.id} cannot be stored`)
  }
  if (field.options && (field.type === 'select' || field.type === 'multi_select')) {
    for (const option of Array.isArray(parsed) ? parsed : [parsed]) if (!field.options.includes(String(option))) throw new Error(`Unknown option: ${String(option)}`)
  }
  return parsed
}
export function fieldEntry(def: DatabaseDefinition, fieldId: string): [string, DatabaseField] {
  const entry = Object.entries(def.fields).find(([, f]) => f.id === fieldId)
  if (!entry) throw new Error(`Unknown field ${fieldId}`)
  return entry
}
