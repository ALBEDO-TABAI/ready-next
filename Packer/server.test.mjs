import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_NOVACODE_BASE_URL,
  DEFAULT_NOVACODE_MODEL,
  assertPackagedApp,
  assertPackagingInputs,
  buildAIConfig,
  buildSeed,
  cleanReadyPackOutputs,
  derivePackagingContract,
  ensurePrivateDir,
  readPackagingContract,
  recoverInterruptedReadyPackSeed,
  replaceFileSecure,
  safeOutputName,
  validatePackageRequest,
} from './server.mjs'

test('packer keeps sensitive working directories private and removes every keyed build byproduct', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-packer-private-outputs-'))
  const contract = {
    appOutputDir: 'mac-arm64',
    artifactName: 'Ready-9.9.9-arm64.dmg',
  }
  try {
    const output = join(root, 'output')
    ensurePrivateDir(output)
    assert.equal(statSync(output).mode & 0o777, 0o700)

    mkdirSync(join(output, contract.appOutputDir), { recursive: true })
    for (const name of [
      'Ready-9.9.9-arm64.dmg',
      'Ready-9.9.9-arm64.dmg.receipt.json',
      'Ready-9.9.9-arm64.dmg.blockmap',
      'Ready-9.9.9-arm64.zip',
      'Ready-9.9.9-arm64.zip.blockmap',
      'latest-mac.yml',
      'builder-effective-config.yaml',
      'builder-debug.yml',
      'clean-package-manifest.json',
    ]) {
      writeFileSync(join(output, name), 'sensitive build output')
    }
    writeFileSync(join(output, 'unrelated.txt'), 'keep')

    cleanReadyPackOutputs(contract, output)

    assert.deepEqual(readdirSync(output), ['unrelated.txt'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packer keeps sensitive seed copies owner-readable only', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-packer-secure-seed-'))
  try {
    const source = join(root, 'source.json')
    const destination = join(root, 'nested', 'destination.json')
    writeFileSync(source, '{"secret":"value"}\n', { mode: 0o644 })

    replaceFileSecure(source, destination)

    assert.equal(readFileSync(destination, 'utf8'), '{"secret":"value"}\n')
    assert.equal(statSync(destination).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packer startup restores the oldest interrupted seed and removes sensitive leftovers', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-packer-seed-recovery-'))
  try {
    const staging = join(root, 'staging')
    const target = join(root, 'build', 'ai-settings.seed.json')
    mkdirSync(staging, { recursive: true })
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(target, 'temporary second package\n')
    const originalBackup = join(staging, 'ready-pack-seed-backup-first.json')
    const chainedBackup = join(staging, 'ready-pack-seed-backup-second.json')
    writeFileSync(originalBackup, 'developer seed\n', { mode: 0o644 })
    writeFileSync(chainedBackup, 'temporary first package\n', { mode: 0o644 })
    writeFileSync(join(staging, 'packer-seed-first.json'), 'package one\n', { mode: 0o600 })
    writeFileSync(join(staging, 'packer-seed-second.json'), 'package two\n', { mode: 0o600 })
    utimesSync(originalBackup, new Date(1_000), new Date(1_000))
    utimesSync(chainedBackup, new Date(2_000), new Date(2_000))

    const result = recoverInterruptedReadyPackSeed(staging, target)

    assert.deepEqual(result, { restored: true, removedBackups: 2, removedTransientSeeds: 2 })
    assert.equal(readFileSync(target, 'utf8'), 'developer seed\n')
    assert.equal(statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(staging), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test('packer writes an OpenAI-compatible API prefix instead of a website origin', () => {
  assert.equal(DEFAULT_NOVACODE_BASE_URL, 'https://cn-novacode.i0yu.cn/v1')
  assert.equal(DEFAULT_NOVACODE_MODEL, 'gpt-5.6-terra')

  const request = validatePackageRequest({
    baseUrl: 'https://relay.example.com/',
    model: 'gpt-test',
    displayName: 'Relay',
  })
  const explicitPrefix = validatePackageRequest({
    baseUrl: 'https://relay.example.com/openai/v1/',
    model: 'gpt-test',
  })
  const privateRelay = validatePackageRequest({
    baseUrl: 'http://10.10.10.45:3000/',
    model: 'gpt-test',
  })
  const loopbackRelay = validatePackageRequest({
    baseUrl: 'http://127.0.0.1:3000/',
    model: 'gpt-test',
  })

  assert.equal(request.baseUrl, 'https://relay.example.com/v1')
  assert.equal(buildSeed(request).ai_model_config.baseUrl, 'https://relay.example.com/v1')
  assert.equal(explicitPrefix.baseUrl, 'https://relay.example.com/openai/v1')
  assert.equal(privateRelay.baseUrl, 'http://10.10.10.45:3000/v1')
  assert.equal(loopbackRelay.baseUrl, 'http://127.0.0.1:3000/v1')
  assert.throws(
    () => validatePackageRequest({ baseUrl: 'http://127.attacker.example', model: 'gpt-test' }),
    /HTTPS|https/,
  )
  assert.throws(
    () => validatePackageRequest({ baseUrl: 'http://localhost.attacker.example', model: 'gpt-test' }),
    /HTTPS|https/,
  )
  assert.throws(
    () => validatePackageRequest({ baseUrl: 'http://public.example.com', model: 'gpt-test' }),
    /HTTPS|https/,
  )
  assert.throws(
    () => validatePackageRequest({ baseUrl: 'https://user:pass@relay.example.com', model: 'gpt-test' }),
    /用户名或密码/,
  )
  assert.throws(
    () => validatePackageRequest({ baseUrl: 'https://relay.example.com?token=secret', model: 'gpt-test' }),
    /查询参数或锚点/,
  )
  assert.throws(
    () => validatePackageRequest({ baseUrl: 'https://relay.example.com/#fragment', model: 'gpt-test' }),
    /查询参数或锚点/,
  )
})

test('packer enables only the NovaCode capability that was verified against the real endpoint', () => {
  const nova = validatePackageRequest({
    baseUrl: DEFAULT_NOVACODE_BASE_URL,
    model: DEFAULT_NOVACODE_MODEL,
  })
  const unknownRelay = validatePackageRequest({
    baseUrl: 'https://relay.example.com',
    model: DEFAULT_NOVACODE_MODEL,
  })

  assert.equal(buildAIConfig(nova).toolUseMode, 'on')
  assert.equal(buildAIConfig(unknownRelay).toolUseMode, 'off')
  assert.equal(buildAIConfig(nova).visionMode, 'off')
  assert.equal(buildAIConfig(nova).nativeVideoMode, 'off')
})

test('packer verifies the app seed and runtime shape before publishing a DMG', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-packer-app-check-'))
  const appPath = join(root, 'Ready.app')
  const frameworkPath = join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A')
  const resourcesPath = join(appPath, 'Contents', 'Resources')
  const contract = { productName: 'Ready' }
  const request = validatePackageRequest({
    baseUrl: DEFAULT_NOVACODE_BASE_URL,
    model: DEFAULT_NOVACODE_MODEL,
  })
  const seed = buildSeed(request)

  try {
    mkdirSync(frameworkPath, { recursive: true })
    mkdirSync(resourcesPath, { recursive: true })
    writeFileSync(join(frameworkPath, 'Electron Framework'), 'framework')
    writeFileSync(join(resourcesPath, 'ai-settings.seed.json'), JSON.stringify(seed))

    assert.doesNotThrow(() => assertPackagedApp(appPath, contract, seed, false))
    assert.throws(
      () => assertPackagedApp(appPath, contract, { unexpected: true }, false),
      /配置与本次打包请求不一致/,
    )
    assert.throws(
      () => assertPackagedApp(appPath, contract, seed, true),
      /完整包缺少技能运行时/,
    )
    mkdirSync(join(resourcesPath, 'skill-runtime'))
    assert.doesNotThrow(() => assertPackagedApp(appPath, contract, seed, true))
    assert.throws(
      () => assertPackagedApp(appPath, contract, seed, false),
      /精简包不应内置技能运行时/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
