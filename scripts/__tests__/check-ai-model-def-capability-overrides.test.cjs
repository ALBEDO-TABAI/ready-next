'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const { checkAIModelDefCapabilityOverrides } = require('../check-ai-model-def-capability-overrides.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-cap-overrides-'))
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  writeFileSync(join(root, 'src/shared/ai-providers.ts'), content)
  return root
}

test('passes when AIModelDef has capabilityOverrides with canonical fields', () => {
  const root = makeFixture(`
export interface AIModelDef {
  id: string
  capabilityOverrides?: {
    supportsVision?: boolean
    supportsThinking?: boolean
    supportsLongContext?: boolean
  }
}
`)
  try {
    const result = checkAIModelDefCapabilityOverrides({ root })
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when capabilityOverrides is missing', () => {
  const root = makeFixture(`
export interface AIModelDef {
  id: string
}
`)
  try {
    const result = checkAIModelDefCapabilityOverrides({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /capabilityOverrides\?:/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when only some canonical fields are present', () => {
  const root = makeFixture(`
export interface AIModelDef {
  id: string
  capabilityOverrides?: {
    supportsVision?: boolean
  }
}
`)
  try {
    const result = checkAIModelDefCapabilityOverrides({ root })
    assert.equal(result.ok, false)
    const blamed = result.errors.join('\n')
    assert.ok(/supportsThinking/.test(blamed))
    assert.ok(/supportsLongContext/.test(blamed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
