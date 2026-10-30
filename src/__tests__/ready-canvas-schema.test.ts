import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ReadyCanvasSchema, readCanvas, validateCanvasCollection } from '../shared/ready-canvas/schema'
import { serializeCanvas } from '../shared/ready-canvas/serialization'

const fixtureRoot = fileURLToPath(new URL('./fixtures/ready-canvas/', import.meta.url))
const load = (name: string) => JSON.parse(readFileSync(`${fixtureRoot}${name}`, 'utf8'))
const all = () => ReadyCanvasSchema.parse(load('valid/all-types.canvas'))

test('all standard/Ready types, third-party extensions and drawing order survive stable serialization', () => {
  const canvas = all(), text = serializeCanvas(canvas)
  assert.equal(text, serializeCanvas(ReadyCanvasSchema.parse(JSON.parse(text))))
  assert.deepEqual(JSON.parse(text), load('valid/all-types.canvas'))
  assert.deepEqual(JSON.parse(text).nodes.map((n: { id: string }) => n.id), canvas.nodes.map(n => n.id))
  const reversed = Object.fromEntries(Object.entries(canvas).reverse())
  assert.equal(serializeCanvas(ReadyCanvasSchema.parse(reversed)), text)
  validateCanvasCollection([{ path: 'Board.canvas', canvas }, { path: 'Board/child.canvas', canvas: ReadyCanvasSchema.parse(load('valid/child.canvas')) }], new Map([['page_1', 'Page.md']]))
})
for (const name of readdirSync(`${fixtureRoot}invalid`)) test(`reject fixture ${name}`, () => assert.throws(() => ReadyCanvasSchema.parse(load(`invalid/${name}`))))

test('path attacks, unsafe numbers, Ready mismatches and mixed membership cycles are rejected', () => {
  for (const path of ['/etc/passwd', 'C:/a', 'a\\b', './a', 'a//b', 'a/../b', '%2e%2e/a', 'a/%252e%252e/b', 'file:///a', 'a\u0000b']) {
    const raw = load('valid/all-types.canvas'); raw.nodes[2].file = path
    assert.throws(() => ReadyCanvasSchema.parse(raw), path)
  }
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = load('valid/all-types.canvas'); raw.nodes[0].x = value
    assert.throws(() => ReadyCanvasSchema.parse(raw))
  }
  const bad = [
    (c: ReturnType<typeof all>) => { c.nodes[0].ready.groupId = 'note' },
    (c: ReturnType<typeof all>) => { c.nodes[7].ready.dock = { top: 'note' } },
    (c: ReturnType<typeof all>) => { c.nodes[0].ready.dock = { left: 'absent' } },
    (c: ReturnType<typeof all>) => { c.nodes[0].ready.graphic = { type: 'rect', fill: 'url(http://bad)', stroke: '#000', strokeWidth: 1 } },
    (c: ReturnType<typeof all>) => { c.nodes[2].ready.appearance = { crop: { mode: 'rect', x: 0.9, y: 0, w: 0.5, h: 1 } } },
    (c: ReturnType<typeof all>) => { c.nodes[0].ready.sources = [{ uri: 'javascript:alert(1)', method: 'clip' }] },
  ]
  for (const mutate of bad) { const canvas = all(); mutate(canvas); assert.throws(() => ReadyCanvasSchema.parse(canvas)) }
})

test('unknown versions are unchanged read-only data and cannot be passed to the writer', () => {
  const raw = load('valid/all-types.canvas'); raw.ready.schemaVersion = 9; raw.ready.future = { untouched: true }; raw.nodes[0].ready = { future: 7 }
  const result = readCanvas(raw)
  assert.equal(result.mode, 'readonly')
  if (result.mode !== 'readonly') assert.fail('expected readonly')
  assert.deepEqual(result.raw, raw)
  assert.equal(result.schemaVersion, 9)
  assert.throws(() => serializeCanvas(raw))
})

test('collection checks unresolved identity, wrong paths, duplicate owners and cross-board cycles', () => {
  const canvas = all()
  assert.throws(() => validateCanvasCollection([{ path: 'Board.canvas', canvas }]), /Unresolved/)
  const child = ReadyCanvasSchema.parse(load('valid/child.canvas'))
  child.nodes.push({ id: 'back', type: 'file', x: 0, y: 0, width: 20, height: 20, file: 'Board.canvas', ready: { kind: 'subcanvas', ref: { kind: 'canvas', id: 'cv_board' } } })
  assert.throws(() => validateCanvasCollection([{ path: 'Board.canvas', canvas }, { path: 'Board/child.canvas', canvas: child }], new Map([['page_1', 'Page.md']])), /cycle/)
  canvas.nodes.push({ ...canvas.nodes[8], id: 'duplicate-child' })
  assert.throws(() => validateCanvasCollection([{ path: 'Board.canvas', canvas }, { path: 'Board/child.canvas', canvas: ReadyCanvasSchema.parse(load('valid/child.canvas')) }], new Map([['page_1', 'Page.md']])), /Multiple/)
})

test('CLI handles positive, negative, mismatched expectations and empty input', () => {
  for (const [args, status, expected] of [
    [[`${fixtureRoot}valid`], 0, '2/2 valid'],
    [['--expect-invalid', `${fixtureRoot}invalid`], 0, '13/13 rejected'],
    [[`${fixtureRoot}invalid/path.canvas`], 1, 'safe library-relative'],
    [['--expect-invalid', `${fixtureRoot}valid`], 1, '0/2 rejected'],
    [[], 1, 'Usage:'],
  ] as const) {
    const run = spawnSync(process.execPath, ['scripts/check-ready-canvas-schema.cjs', ...args], { encoding: 'utf8' })
    assert.equal(run.status, status, run.stderr + run.stdout)
    assert.ok((run.stdout + run.stderr).includes(expected), run.stdout + run.stderr)
  }
})

test('standard payload fields cannot masquerade as third-party extensions of another node type', () => {
  for (const [index, field, value] of [[0, 'file', 'Page.md'], [2, 'text', 'wrong'], [6, 'subpath', '#wrong'], [7, 'url', 'https://example.test']] as const) {
    const raw = load('valid/all-types.canvas'); raw.nodes[index][field] = value
    assert.throws(() => ReadyCanvasSchema.parse(raw), /Standard field/)
  }
})
