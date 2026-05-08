'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const { checkAIProviderDefCapabilityClass } = require('../check-ai-provider-def-capability-class.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-cap-class-'))
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  writeFileSync(join(root, 'src/shared/ai-providers.ts'), content)
  return root
}

test('passes when AIProviderDef has capabilityClass with canonical fields', () => {
  const root = makeFixture(`
export interface AIProviderDef {
  id: string
  capabilityClass?: {
    supportsVision?: boolean
    supportsThinking?: boolean
    supportsLongContext?: boolean
  }
}
`)
  try {
    const result = checkAIProviderDefCapabilityClass({ root })
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when capabilityClass is missing', () => {
  const root = makeFixture(`
export interface AIProviderDef {
  id: string
}
`)
  try {
    const result = checkAIProviderDefCapabilityClass({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /capabilityClass\?:/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when shorthand `vision` is used instead of `supportsVision`', () => {
  const root = makeFixture(`
export interface AIProviderDef {
  id: string
  capabilityClass?: {
    vision?: boolean
    thinking?: boolean
    longContext?: boolean
  }
}
`)
  try {
    const result = checkAIProviderDefCapabilityClass({ root })
    assert.equal(result.ok, false)
    // Should flag all three canonical names missing.
    const blamed = result.errors.join('\n')
    assert.ok(/supportsVision/.test(blamed))
    assert.ok(/supportsThinking/.test(blamed))
    assert.ok(/supportsLongContext/.test(blamed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
