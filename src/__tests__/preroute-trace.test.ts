import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('preroute retirement gate keeps all production and renderer entrypoints absent', () => {
  const result = spawnSync('node', ['scripts/check-preroute-status-single-source.cjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /preroute and fake persona\/knowledge controls are retired/)
})
