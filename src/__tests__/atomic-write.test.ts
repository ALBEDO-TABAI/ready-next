import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { atomicWriteJson, atomicWriteText } from '../main/modules/agent-control/atomic-write'

test('atomicWriteJson creates parent directories and writes formatted JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-atomic-json-'))
  try {
    const target = join(root, 'nested', 'state.json')

    atomicWriteJson(target, { ok: true })

    assert.equal(readFileSync(target, 'utf8'), '{\n  "ok": true\n}\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('atomicWriteText creates parent directories and writes text', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-atomic-text-'))
  try {
    const target = join(root, 'nested', 'config.toml')

    atomicWriteText(target, 'value = true\n')

    assert.equal(readFileSync(target, 'utf8'), 'value = true\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('atomic writes fsync the temp file before rename', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed contract: helper must fsync the temp file before replacing the target
  const source = readFileSync(new URL('../main/modules/agent-control/atomic-write.ts', import.meta.url), 'utf8')
  const fsyncIndex = source.indexOf('fs.fsyncSync(fd)')
  const renameIndex = source.indexOf('fs.renameSync(tmp, path)')

  assert.notEqual(fsyncIndex, -1)
  assert.notEqual(renameIndex, -1)
  assert.ok(fsyncIndex < renameIndex)
})
