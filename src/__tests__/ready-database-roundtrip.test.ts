import assert from 'node:assert/strict'
import test from 'node:test'
import { readDocumentSource } from '../shared/document-operations'
import { DatabaseDefinitionSchema, readDatabase, writeDatabase, patchRow, queryDatabase, projectView, resolveInlineView, type DatabaseRow } from '../shared/document-database'

const definition = () => DatabaseDefinitionSchema.parse({ version: 1, source: '库', fields: {
  分数: { id: 'score', name: '评分', type: 'number' }, 标签: { id: 'tags', name: '标签', type: 'multi_select' },
  双倍: { id: 'double', name: '双倍', type: 'formula', expression: 'prop("score") * 2' },
}, views: [{ id: 'table', name: '全部', type: 'table', sorts: [{ field: 'score', direction: 'desc' }], groupBy: 'tags', calculations: [{ field: 'score', operation: 'sum' }] }] })
const rows: DatabaseRow[] = [
  { id: 'b', title: 'B', version: '1', values: { 分数: 2, 标签: ['甲', '乙'], other: { untouched: true } } },
  { id: 'a', title: 'A', version: '1', values: { 分数: 2, 标签: ['甲'] } },
  { id: 'c', title: 'C', version: '1', values: { 分数: 1, 标签: [] } },
]

test('DB1 definition and row roundtrip retain unknown content, comments and CRLF', () => {
  const raw = '\uFEFF---\r\n# outside\r\ncustom: { x: 1 } # keep\r\n---\r\nBody unchanged\r\n'
  const written = writeDatabase(raw, definition())
  assert.deepEqual(readDatabase(written), definition())
  assert.equal(writeDatabase(written, readDatabase(written)), written)
  const commented = written.replace('name: 评分', 'name: 评分 # field comment')
  const next = readDatabase(commented); next.fields.分数.name = '分数显示'
  const updated = writeDatabase(commented, next)
  assert.ok(updated.includes('# field comment')); assert.ok(updated.includes('custom: { x: 1 } # keep\r\n'))
  assert.equal(readDocumentSource(updated).body, 'Body unchanged\r\n')
  const moved = readDatabase(updated); moved.fields.新分数 = moved.fields.分数; delete moved.fields.分数
  assert.ok(writeDatabase(updated, moved).includes('# field comment'))
  const row = '---\r\n分数: 2 # score\r\nother: { x: 3 } # untouched\r\n---\r\n正文\r\n'
  const patched = patchRow(row, definition(), { score: 3 })
  assert.equal(patched, row.replace('分数: 2', '分数: 3'))
  assert.throws(() => patchRow(row, definition(), { double: 6 }), /computed|计算/)
  assert.throws(() => patchRow(row, definition(), { score: 'bad' }), /分数|score/)
  assert.deepEqual(readDocumentSource(patched).frontmatter.other, { x: 3 })
})

test('DB2 query filters before totals, stable sorting and multiselect groups precede pagination', () => {
  const def = definition(), view = def.views[0]
  view.filters = [{ field: 'double', operator: 'gte', value: 4 }]
  const result = queryDatabase(def, rows, view, {}, { offset: 0, limit: 1 })
  assert.equal(result.total, 2); assert.equal(result.rows[0].id, 'a')
  assert.deepEqual(result.calculations.score, { status: 'value', value: 4 })
  assert.deepEqual(result.groups.map(g => [g.value, g.rowIds]), [['甲', ['a', 'b']], ['乙', ['b']]])
  assert.deepEqual(result.rows[0].cells.double, { status: 'value', value: 4 })
  assert.equal('双倍' in rows[0].values, false)
})

test('DB2 formula syntax, cycles, division and truncated rollups remain explicit errors', () => {
  const def = definition()
  def.fields.双倍.expression = 'prop("double") + 1'
  assert.match(JSON.stringify(queryDatabase(def, rows, def.views[0]).rows[0].cells.double), /cycle/)
  def.fields.双倍.expression = '1 / 0'
  assert.match(JSON.stringify(queryDatabase(def, rows, def.views[0]).rows[0].cells.double), /division_by_zero/)
  def.fields.双倍.expression = 'globalThis.process.exit()'
  assert.match(JSON.stringify(queryDatabase(def, rows, def.views[0]).rows[0].cells.double), /syntax/)
  def.fields.关联 = { id: 'links', name: '关联', type: 'relation' }
  def.fields.合计 = { id: 'total', name: '合计', type: 'rollup', relation: 'links', target: '价格', operation: 'sum' }
  const linked = [{ ...rows[0], values: { ...rows[0].values, 关联: ['[[Other]]'] } }]
  assert.equal(queryDatabase(def, linked, def.views[0], { b: { links: { rows: [], complete: false, reasons: ['truncated'] } } }).rows[0].cells.total.status, 'incomplete')
  assert.deepEqual(queryDatabase(def, linked, def.views[0], { b: { links: { rows: [{ 价格: 7 }], complete: true, reasons: [] } } }).rows[0].cells.total, { status: 'value', value: 7 })
})

test('DB1 invalid declarations and stored values have specific diagnostics', () => {
  const def = definition()
  assert.throws(() => DatabaseDefinitionSchema.parse({ ...def, source: '../outside' }), /source/)
  assert.throws(() => DatabaseDefinitionSchema.parse({ ...def, views: [def.views[0], def.views[0]] }), /unique|重复/)
  assert.equal(queryDatabase(def, [{ ...rows[0], values: { 分数: 'bad' } }], def.views[0]).rows[0].cells.score.status, 'error')
  const filtered = queryDatabase(def, [{ ...rows[0], values: { 分数: 'bad' } }], { ...def.views[0], filters: [{ field: 'score', operator: 'gte', value: 0 }] })
  assert.equal(filtered.total, 0); assert.ok(filtered.issues.some(issue => issue.fieldId === 'score'))
  const original = writeDatabase('---\nextension: yes\n---\nbody', { ...def, extension: { preserved: true } })
  assert.deepEqual(readDatabase(original).extension, { preserved: true })
})

test('DB2 all seven projections share rows and inline views detect missing names and cycles', () => {
  const def = definition()
  for (const type of ['table', 'board', 'calendar', 'timeline', 'gallery', 'list', 'bookshelf'] as const) {
    const view = { ...def.views[0], type }
    assert.equal(projectView(def, rows, view).type, type)
  }
  assert.equal(resolveInlineView('db', def, '全部', []).id, 'table')
  assert.equal(resolveInlineView('db', def, '全部', [{ databaseId: 'other', viewId: 'table' }]).id, 'table')
  assert.throws(() => resolveInlineView('db', def, 'missing', []), /missing/)
  assert.throws(() => resolveInlineView('db', def, '全部', [{ databaseId: 'db', viewId: 'table' }]), /cycle/)
})

test('DB1 all stored field types retain false, zero, absent and null; date and relation errors are not coerced', () => {
  const def = DatabaseDefinitionSchema.parse({ version: 1, source: '库', fields: {
    文本: { id: 'text', name: '文本', type: 'text' }, 数字: { id: 'number', name: '数字', type: 'number' },
    选择: { id: 'select', name: '选择', type: 'select', options: ['甲', '乙'] }, 多选: { id: 'multi', name: '多选', type: 'multi_select', options: ['甲', '乙'] },
    日期: { id: 'date', name: '日期', type: 'date' }, 复选: { id: 'check', name: '复选', type: 'checkbox' },
    链接: { id: 'url', name: '链接', type: 'url' }, 关联: { id: 'relation', name: '关联', type: 'relation' },
  }, views: [{ id: 'v', name: '视图', type: 'table' }] })
  const values = { text: '', number: 0, select: '甲', multi: ['甲', '乙'], date: { start: '2026-10-30', end: '2026-10-31' }, check: false, url: 'https://example.com', relation: ['[[页面]]'] }
  const content = patchRow('body', def, values), frontmatter = readDocumentSource(content).frontmatter
  for (const [key, field] of Object.entries(def.fields)) assert.deepEqual(frontmatter[key], values[field.id as keyof typeof values])
  assert.throws(() => patchRow(content, def, { date: '2026-02-30' }), /date/)
  assert.throws(() => patchRow(content, def, { date: { start: '2026-10-31', end: '2026-10-30' } }), /date/)
  assert.throws(() => patchRow(content, def, { multi: ['甲', '甲'] }), /unique/)
  assert.throws(() => patchRow(content, def, { relation: ['not a link'] }), /page/)
  assert.throws(() => patchRow(content, def, { url: 'javascript:alert(1)' }), /http/)
  const missing = readDocumentSource(patchRow(content, def, { number: null }, ['check'])).frontmatter
  assert.equal(missing.数字, null); assert.equal(Object.hasOwn(missing, '复选'), false)
  const dates = ['2026-10-30T23:00:00-03:00', '2026-10-30', '2026-10-31T00:00:00Z'].map((date, index) => ({ id: String(index), title: 'date', version: '1', values: { 日期: date } }))
  assert.deepEqual(queryDatabase(def, dates, { ...def.views[0], sorts: [{ field: 'date', direction: 'asc' }] }).rows.map(row => row.id), ['1', '2', '0'])
})
