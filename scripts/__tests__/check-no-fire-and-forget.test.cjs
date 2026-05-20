'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const test = require('node:test')
const { checkNoFireAndForget, isSilentHandler } = require('../check-no-fire-and-forget.cjs')

function withFixture(fn, allowlistEntries = []) {
  const root = mkdtempSync(join(tmpdir(), 'ready-fnf-check-'))
  for (const sub of ['src/main', 'src/preload', 'src/renderer', 'src/shared', 'scripts']) mkdirSync(join(root, sub), { recursive: true })
  writeFileSync(join(root, 'scripts/check-no-fire-and-forget.allowlist.json'),
    JSON.stringify({ version: 1, identity: 'fixture', entries: allowlistEntries }))
  const writeFile = (rel, body) => { const f = join(root, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body) }
  try { fn(root, writeFile) } finally { rmSync(root, { recursive: true, force: true }) }
}
const expectFlagged = (r, form) => { assert.equal(r.ok, false); assert.equal(r.violations[0].form, form) }
const expectOk = (r) => assert.equal(r.ok, true, JSON.stringify(r.violations))

test('Form 1: void <expr>.catch(() => undefined) flagged', () => withFixture((root, w) => {
  w('src/main/bad1.ts', 'export function f() { void doIt().catch(() => undefined) }\n')
  expectFlagged(checkNoFireAndForget({ root }), 'void-catch-swallow')
}))

test('Form 2: <expr>.catch(() => null) at statement position flagged', () => withFixture((root, w) => {
  w('src/main/bad2.ts', 'export function f() { doIt().catch(() => null) }\n')
  expectFlagged(checkNoFireAndForget({ root }), 'statement-catch-swallow')
}))

test('Form 3: <expr>.catch(() => {}) at statement position flagged', () => withFixture((root, w) => {
  w('src/main/bad3.ts', 'export function f() { doIt().catch(() => {}) }\n')
  expectFlagged(checkNoFireAndForget({ root }), 'statement-catch-swallow')
}))

test('Form 4: <expr>.finally(...).catch(() => undefined) flagged', () => withFixture((root, w) => {
  w('src/main/bad4.ts', 'export function f() { doIt().finally(() => clean()).catch(() => undefined) }\n')
  expectFlagged(checkNoFireAndForget({ root }), 'statement-catch-swallow')
}))

test('Form 5: void window.electronAPI.<x>() reused within 5 lines flagged', () => withFixture((root, w) => {
  w('src/renderer/bad5.tsx', [
    'export function Bad5() {',
    '  void window.electronAPI.foo.watchThing([]).catch(() => undefined)',
    '  void window.electronAPI.foo.watchThing([1]).catch(() => undefined)',
    '  return null',
    '}', '',
  ].join('\n'))
  const r = checkNoFireAndForget({ root })
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.form === 'void-electron-reuse'))
}))

test('Accept: handler with logAgentMetric / console.error NOT flagged', () => withFixture((root, w) => {
  w('src/main/good1.ts', [
    'export function f() {',
    '  void doIt().catch((err) => {',
    '    logAgentMetric("foo.failed", { reason: String(err) })',
    '    console.error("doIt failed:", err)',
    '  })',
    '}',
  ].join('\n'))
  expectOk(checkNoFireAndForget({ root }))
}))

test('Accept: `// fire-and-forget: <reason>` annotation suppresses', () => withFixture((root, w) => {
  w('src/main/good2.ts', [
    'export function f() {',
    '  // fire-and-forget: cleanup must run regardless of outcome',
    '  void doIt().catch(() => undefined)',
    '}',
  ].join('\n'))
  expectOk(checkNoFireAndForget({ root }))
}))

test('Accept: consumed positions (await / const / sub-expr) NOT flagged', () => withFixture((root, w) => {
  w('src/main/good3.ts', [
    'export async function f(p: string) {',
    '  const stat = await statPath(p).catch(() => null)',
    '  const result = doIt().catch(() => null)',
    '  await Promise.race([ready(), work().catch(() => undefined)])',
    '  return [stat, result]',
    '}',
  ].join('\n'))
  expectOk(checkNoFireAndForget({ root }))
}))

test('Accept: allowlist entry suppresses violation', () => withFixture(
  (root, w) => {
    w('src/main/allow1.ts', 'export function f() { void doIt().catch(() => undefined) }\n')
    expectOk(checkNoFireAndForget({ root }))
  },
  [{ file: 'src/main/allow1.ts', line: 1, reason: 'test fixture' }],
))

test('Allowlist rejects entries missing required fields', () => withFixture(
  (root) => { assert.throws(() => checkNoFireAndForget({ root }), /Invalid allowlist entry/) },
  [{ file: 'x.ts', line: 5 }],
))

test('isSilentHandler accepts canonical silent forms', () => {
  for (const f of ['() => undefined', '() => null', '() => {}', '() => { }', '_ => null', '(err) => undefined', 'noop']) {
    assert.equal(isSilentHandler(f), true, `expected silent: ${f}`)
  }
})

test('isSilentHandler rejects handlers with side effects', () => {
  for (const f of [
    '(err) => { console.error(err) }',
    '(err) => { logAgentMetric("x", { reason: err }) }',
    '(err) => { throw err }',
    '(err) => { setError(err) }',
    '(err) => { reject(err) }',
  ]) {
    assert.equal(isSilentHandler(f), false, `expected NOT silent: ${f}`)
  }
})

test('src/__tests__/ files are skipped', () => withFixture((root, w) => {
  w('src/__tests__/sample.test.ts', "test('x', () => { void doIt().catch(() => undefined) })\n")
  expectOk(checkNoFireAndForget({ root }))
}))
