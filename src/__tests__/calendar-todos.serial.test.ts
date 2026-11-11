import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { join } from 'node:path'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// Serial Electron SQLite benchmark: 1000 real Markdown files, cold <= 3000 ms,
// warm and one-file refresh <= 250 ms each. Diagnostics print actual timings.
test('1000-file todo list caches reads/parses, shares them with layers and reparses only the changed file', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar todo performance')) return
  const parserUrl = new URL('../shared/calendar-layers.ts', import.meta.url).href
  const counted = 'data:text/javascript,' + encodeURIComponent(`
    export * from ${JSON.stringify(parserUrl)};
    import { parseTodos as realParse } from ${JSON.stringify(parserUrl)};
    export let calls = 0;
    export function parseTodos(content) { calls++; return realParse(content); }
  `)
  const hook = registerHooks({ resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    return resolved.url === parserUrl && context.parentURL !== counted ? { url: counted, shortCircuit: true } : resolved
  } })
  t.after(() => hook.deregister())
  const parser = await import(counted)
  const { todoFixture } = await import('./utils/calendar-todos-fixture')
  const f = todoFixture(); t.after(() => f.close())
  for (let i = 0; i < 1000; i++) fs.writeFileSync(join(f.root, `${i}.md`), `# 分组 ${i}\n- [ ] 待办 ${i} [日期](ready://calendar/day/2026-11-12)\n- [x] 已完成\n`)
  f.registry.scan(f.root)
  const read = t.mock.method(fs, 'readFileSync')
  syncBuiltinESMExports()
  t.after(() => { read.mock.restore(); syncBuiltinESMExports() })
  let parseBefore = parser.calls
  const began = performance.now(), cold = f.service.listTodos(), coldMs = performance.now() - began
  assert.equal(cold.length, 1000); assert.equal(read.mock.callCount(), 1000); assert.equal((parser.calls - parseBefore), 1000)
  read.mock.resetCalls(); parseBefore = parser.calls
  const hotBegan = performance.now(); assert.deepEqual(f.service.listTodos(), cold); const hotMs = performance.now() - hotBegan
  assert.equal(read.mock.callCount(), 0); assert.equal((parser.calls - parseBefore), 0)
  assert.equal(f.service.query({ from: '2026-11-01', to: '2026-12-01', timeZone: 'UTC' }).filter(e => e.layer === 'tasks').length, 1000)
  assert.equal(read.mock.callCount(), 0); assert.equal((parser.calls - parseBefore), 0)
  const path = join(f.root, '500.md'); fs.writeFileSync(path, '# 改过\n- [ ] 新待办\n'); f.registry.register(path)
  read.mock.resetCalls(); parseBefore = parser.calls
  const changeBegan = performance.now(), changed = f.service.listTodos(), changeMs = performance.now() - changeBegan
  assert.equal(read.mock.callCount(), 1); assert.equal((parser.calls - parseBefore), 1)
  assert.equal(read.mock.calls[0].arguments[0], path)
  assert.equal(changed.find(item => item.page.title === '500')?.title, '新待办')
  assert.equal(changed.filter(item => item.date === '2026-11-12').length, 999)
  t.diagnostic(`1000 files: cold ${coldMs.toFixed(1)}ms / 3000ms; warm ${hotMs.toFixed(1)}ms / 250ms; one changed ${changeMs.toFixed(1)}ms / 250ms; reads/parses 1000 -> 0 -> 1`)
  assert.ok(coldMs <= 3000); assert.ok(hotMs <= 250); assert.ok(changeMs <= 250)
  fs.unlinkSync(path); f.registry.reconcile([path]); assert.equal(f.service.listTodos().length, 999)
})
