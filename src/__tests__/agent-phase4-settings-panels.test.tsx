import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('Agent Settings retirement gate preserves archives but rejects derivation and routing controls', () => {
  const result = spawnSync('node', ['scripts/check-specialist-studio-readonly.cjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /check-specialist-studio-readonly.*OK/)
})
