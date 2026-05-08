'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  checkAIResolvedCapabilitiesThinkingLongcontext,
} = require('../check-ai-resolved-capabilities-thinking-longcontext.cjs')

function makeFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'check-resolved-cap-'))
  mkdirSync(join(root, 'src/shared'), { recursive: true })
  writeFileSync(join(root, 'src/shared/ai-providers.ts'), content)
  return root
}

test('passes when both fields are required (non-optional)', () => {
  const root = makeFixture(`
export interface AIResolvedCapabilities {
  supportsVision: boolean
  supportsThinking: boolean
  supportsLongContext: boolean
}
`)
  try {
    const result = checkAIResolvedCapabilitiesThinkingLongcontext({ root })
    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when fields are absent', () => {
  const root = makeFixture(`
export interface AIResolvedCapabilities {
  supportsVision: boolean
}
`)
  try {
    const result = checkAIResolvedCapabilitiesThinkingLongcontext({ root })
    assert.equal(result.ok, false)
    const blamed = result.errors.join('\n')
    assert.ok(/supportsThinking/.test(blamed))
    assert.ok(/supportsLongContext/.test(blamed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when fields are declared optional (capabilityOverrides shape leaked through)', () => {
  const root = makeFixture(`
export interface AIResolvedCapabilities {
  supportsThinking?: boolean
  supportsLongContext?: boolean
}
`)
  try {
    const result = checkAIResolvedCapabilitiesThinkingLongcontext({ root })
    assert.equal(result.ok, false)
    const blamed = result.errors.join('\n')
    assert.ok(/must be required/.test(blamed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
