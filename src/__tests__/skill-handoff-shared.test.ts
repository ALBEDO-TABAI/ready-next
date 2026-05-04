import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  HANDOFF_TIMEOUT_USER_MESSAGE,
  isSafeRelativePath,
  numberValue,
  objectValue,
  readJson,
  stringValue,
} from '../main/modules/agent-control/skill-handoff-shared'

test('HANDOFF_TIMEOUT_USER_MESSAGE preserves the user-facing copy', () => {
  assert.equal(HANDOFF_TIMEOUT_USER_MESSAGE, '报告生成超时，可继续重试')
})

test('stringValue returns the trimmed string for non-empty input', () => {
  assert.equal(stringValue('abc'), 'abc')
  assert.equal(stringValue('  hello  '), 'hello')
})

test('stringValue returns null for empty / whitespace / non-string input', () => {
  assert.equal(stringValue(''), null)
  assert.equal(stringValue('   '), null)
  assert.equal(stringValue('\t\n'), null)
  assert.equal(stringValue(undefined), null)
  assert.equal(stringValue(null), null)
  assert.equal(stringValue(42), null)
  assert.equal(stringValue({}), null)
  assert.equal(stringValue([]), null)
  assert.equal(stringValue(true), null)
})

test('isSafeRelativePath rejects absolute paths (unix and windows)', () => {
  assert.equal(isSafeRelativePath('/foo'), false)
  assert.equal(isSafeRelativePath('/etc/passwd'), false)
  if (process.platform === 'win32') {
    assert.equal(isSafeRelativePath('C:\\foo'), false)
  }
})

test('isSafeRelativePath rejects paths containing traversal segments', () => {
  assert.equal(isSafeRelativePath('../foo'), false)
  assert.equal(isSafeRelativePath('foo/../bar'), false)
  assert.equal(isSafeRelativePath('./foo'), false)
  assert.equal(isSafeRelativePath('foo/./bar'), false)
  assert.equal(isSafeRelativePath('..'), false)
  assert.equal(isSafeRelativePath('.'), false)
})

test('isSafeRelativePath rejects empty input', () => {
  assert.equal(isSafeRelativePath(''), false)
})

test('isSafeRelativePath accepts safe relative paths', () => {
  assert.equal(isSafeRelativePath('foo'), true)
  assert.equal(isSafeRelativePath('foo/bar'), true)
  assert.equal(isSafeRelativePath('audiovisual_handoff/body/output.md'), true)
  assert.equal(isSafeRelativePath('foo\\bar'), true)
})

test('readJson returns parsed object for valid JSON object file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-handoff-shared-'))
  const path = join(dir, 'good.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ a: 1, b: 'two' }), 'utf8')
  assert.deepEqual(readJson(path), { a: 1, b: 'two' })
})

test('readJson returns null for JSON arrays (objectValue rejects arrays)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-handoff-shared-'))
  const path = join(dir, 'array.json')
  writeFileSync(path, JSON.stringify([1, 2, 3]), 'utf8')
  assert.equal(readJson(path), null)
})

test('readJson returns null for corrupt JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-handoff-shared-'))
  const path = join(dir, 'broken.json')
  writeFileSync(path, '{ not valid json', 'utf8')
  assert.equal(readJson(path), null)
})

test('readJson returns null for missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ready-handoff-shared-'))
  assert.equal(readJson(join(dir, 'does-not-exist.json')), null)
})

test('numberValue parses numbers, numeric strings, and rejects negatives / NaN / undefined', () => {
  assert.equal(numberValue(42), 42)
  assert.equal(numberValue(0), 0)
  assert.equal(numberValue(3.7), 3) // floored
  assert.equal(numberValue('5'), 5)
  assert.equal(numberValue(' 12 '), 12)
  assert.equal(numberValue(-3), 0) // negatives → 0
  assert.equal(numberValue('-3'), 0)
  assert.equal(numberValue(NaN), 0)
  assert.equal(numberValue(undefined), 0)
  assert.equal(numberValue(null), 0)
  assert.equal(numberValue('not-a-number'), 0)
  assert.equal(numberValue(''), 0)
})

test('objectValue returns plain objects only', () => {
  assert.deepEqual(objectValue({ a: 1 }), { a: 1 })
  assert.equal(objectValue([1, 2]), null)
  assert.equal(objectValue(null), null)
  assert.equal(objectValue(undefined), null)
  assert.equal(objectValue('string'), null)
  assert.equal(objectValue(42), null)
  assert.equal(objectValue(true), null)
})
