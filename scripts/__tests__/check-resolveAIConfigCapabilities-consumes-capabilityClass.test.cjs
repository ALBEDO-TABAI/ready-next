'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const { checkResolveConsumesCapabilityClass } = require('../check-resolveAIConfigCapabilities-consumes-capabilityClass.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-resolve-consume-'))
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  writeFileSync(join(root, 'src/shared/ai-providers.ts'), content)
  return root
}

test('passes when resolver body references both capabilityClass and capabilityOverrides', () => {
  const root = makeFixture(`
export function resolveAIConfigCapabilities(config) {
  const provider = getProviderDef(config?.provider)
  const providerCap = provider?.capabilityClass ?? {}
  const modelDef = provider?.models.find(m => m.id === config?.model)
  const modelCap = modelDef?.capabilityOverrides ?? {}
  return { supportsVision: modelCap.supportsVision ?? providerCap.supportsVision ?? false }
}
`)
  try {
    const result = checkResolveConsumesCapabilityClass({ root })
    assert.equal(result.ok, true, result.errors?.join('\n'))
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when resolver does not reference capabilityClass', () => {
  const root = makeFixture(`
export function resolveAIConfigCapabilities(config) {
  const modelDef = {}
  const modelCap = modelDef?.capabilityOverrides ?? {}
  return { supportsVision: modelCap.supportsVision ?? false }
}
`)
  try {
    const result = checkResolveConsumesCapabilityClass({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /capabilityClass/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when resolver does not reference capabilityOverrides', () => {
  const root = makeFixture(`
export function resolveAIConfigCapabilities(config) {
  const provider = getProviderDef(config?.provider)
  const providerCap = provider?.capabilityClass ?? {}
  return { supportsVision: providerCap.supportsVision ?? false }
}
`)
  try {
    const result = checkResolveConsumesCapabilityClass({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /capabilityOverrides/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when resolver function is missing entirely', () => {
  const root = makeFixture(`
export function somethingElse() { return null }
`)
  try {
    const result = checkResolveConsumesCapabilityClass({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /resolveAIConfigCapabilities/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
