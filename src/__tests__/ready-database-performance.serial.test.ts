import assert from 'node:assert/strict'
import test from 'node:test'
import { performance } from 'node:perf_hooks'
import { DatabaseDefinitionSchema, queryDatabase } from '../shared/document-database'

test('DB4 1000 rows / 20 fields: hot filtering, sorting, grouping and calculations p95 <= 100ms', () => {
  const fields = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`f${i}`, { id: `f${i}`, name: `Field ${i}`, type: 'number' }]))
  const definition = DatabaseDefinitionSchema.parse({ version: 1, source: '库', fields: { ...fields, links: { id: 'links', name: '关系', type: 'relation' }, formula: { id: 'formula', name: '计算', type: 'formula', expression: 'prop("f0") * 2' } }, views: [{ id: 'v', name: '筛选', type: 'table', filters: [{ field: 'formula', operator: 'gte', value: 100 }], sorts: [{ field: 'f1', direction: 'desc' }], groupBy: 'f2', calculations: [{ field: 'f0', operation: 'sum' }] }] })
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i).padStart(4, '0'), title: `row${i}`, version: '1', values: { ...Object.fromEntries(Array.from({ length: 18 }, (_, j) => [`f${j}`, j === 2 ? i % 5 : i])), links: ['[[other/row]]'], cover: 'row.assets/cover.png', body: 'long body '.repeat(1000) } }))
  const relations = Object.fromEntries(rows.map(row => [row.id, { links: { rows: [{ amount: 10 }], complete: true, reasons: [] } }]))
  const timings: number[] = []
  for (let i = 0; i < 31; i++) {
    const start = performance.now(), result = queryDatabase(definition, rows, definition.views[0], relations, { offset: 0, limit: 50 })
    if (i) timings.push(performance.now() - start)
    assert.equal(result.total, 950); assert.equal(result.groups.length, 5); assert.equal(result.rows.length, 50)
    assert.equal(result.rows[0].id, '0999')
  }
  timings.sort((a, b) => a - b)
  const p95 = timings[Math.ceil(timings.length * .95) - 1]
  console.log(`M5 1000-row hot query: p95=${p95.toFixed(2)}ms, max=${timings.at(-1)!.toFixed(2)}ms`)
  assert.ok(p95 <= 100, `p95 ${p95}ms exceeds 100ms`)
})
