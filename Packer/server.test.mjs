import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validatePackageRequest } from './server.mjs'

test('packer defaults to a slim package without skill-runtime', () => {
  const request = validatePackageRequest({})

  assert.equal(request.allowSlim, true)
  assert.equal(request.runtimeRoot, '')
})

test('packer ignores runtimeRoot while slim package mode is enabled', () => {
  const request = validatePackageRequest({
    allowSlim: true,
    runtimeRoot: '/not/a/runtime',
  })

  assert.equal(request.allowSlim, true)
  assert.equal(request.runtimeRoot, '')
})

test('packer requires a valid runtimeRoot only for full packages', () => {
  assert.throws(
    () => validatePackageRequest({ allowSlim: false }),
    /未提供技能运行时目录/,
  )

  assert.throws(
    () => validatePackageRequest({ allowSlim: false, runtimeRoot: '/not/a/runtime' }),
    /技能运行时目录无效/,
  )

  const runtimeRoot = mkdtempSync(join(tmpdir(), 'ready-packer-runtime-'))
  try {
    writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), '{}\n')
    const request = validatePackageRequest({ allowSlim: false, runtimeRoot })

    assert.equal(request.allowSlim, false)
    assert.equal(request.runtimeRoot, runtimeRoot)
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true })
  }
})
