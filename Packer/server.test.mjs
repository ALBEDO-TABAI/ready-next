import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertPackagingInputs, derivePackagingContract, readPackagingContract, safeOutputName, validatePackageRequest } from './server.mjs'

test('packer derives its output contract from the project builder configuration', () => {
  const contract = derivePackagingContract({
    productName: 'Ready Next',
    directories: { output: 'release-output' },
    mac: {
      target: [{ target: 'dmg', arch: ['arm64'] }],
      artifactName: '${productName}-${version}-${arch}.${ext}',
    },
  }, { version: '9.8.7' })

  assert.deepEqual(contract, {
    productName: 'Ready Next',
    version: '9.8.7',
    arch: 'arm64',
    output: 'release-output',
    artifactName: 'Ready Next-9.8.7-arm64.dmg',
    appOutputDir: 'mac-arm64',
  })
  assert.equal(safeOutputName(contract, ''), contract.artifactName)
  assert.equal(safeOutputName(contract, '张三'), 'Ready Next-张三.dmg')
})

test('packer fails loudly when the project no longer has one deterministic DMG architecture', () => {
  assert.throws(
    () => derivePackagingContract({ productName: 'Ready', mac: { target: ['zip'] } }, { version: '1.0.0' }),
    /唯一的 macOS DMG 架构/,
  )
})

test('packer verifies the live project still exposes every required packaging input', () => {
  assert.doesNotThrow(() => readPackagingContract())
  assert.throws(
    () => assertPackagingInputs({ extraResources: [] }, { scripts: { 'build:dist': 'build' } }),
    /ai-settings\.seed\.json/,
  )
})

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
