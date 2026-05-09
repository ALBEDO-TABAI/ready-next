'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  checkCapabilityGateConservativeDefault,
  CONSERVATIVE_PROVIDERS,
  REQUIRED_FALSE_FIELDS,
} = require('../check-capability-gate-conservative-default.cjs')

function makeFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-cap-conservative-'))
  const subDir = join(root, 'src/shared/ai-providers')
  mkdirSync(subDir, { recursive: true })

  // Default: write all 3 conservative providers in compliant form.
  for (const id of CONSERVATIVE_PROVIDERS) {
    const file = `${id}.ts`
    const content = overrides[file] ?? defaultGood()
    writeFileSync(join(subDir, file), content)
  }
  return root
}

function defaultGood() {
  return `
import type { ProviderCapabilityClass } from './types'
export const def = {} as any
export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
  supportsLongContext: false,
}
`
}

test('passes when fox/volcengine/openai-compatible all declare false for vision and thinking', () => {
  const root = makeFixture()
  try {
    const result = checkCapabilityGateConservativeDefault({ root })
    assert.equal(result.ok, true, result.errors?.join('\n'))
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when fox declares supportsVision: true', () => {
  const root = makeFixture({
    'fox.ts': `
import type { ProviderCapabilityClass } from './types'
export const def = {} as any
export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: true,
  supportsThinking: false,
  supportsLongContext: false,
}
`,
  })
  try {
    const result = checkCapabilityGateConservativeDefault({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /fox\.ts.*supportsVision/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when openai-compatible omits supportsThinking', () => {
  const root = makeFixture({
    'openai-compatible.ts': `
import type { ProviderCapabilityClass } from './types'
export const def = {} as any
export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsLongContext: false,
}
`,
  })
  try {
    const result = checkCapabilityGateConservativeDefault({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /openai-compatible.*supportsThinking/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when volcengine sub-module is missing', () => {
  const root = makeFixture()
  // Remove volcengine.ts after default fixture was written.
  rmSync(join(root, 'src/shared/ai-providers/volcengine.ts'))
  try {
    const result = checkCapabilityGateConservativeDefault({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /volcengine\.ts.*missing/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CONSERVATIVE_PROVIDERS & REQUIRED_FALSE_FIELDS are stable exports', () => {
  assert.deepEqual([...CONSERVATIVE_PROVIDERS].sort(), ['fox', 'openai-compatible', 'volcengine'])
  assert.deepEqual(REQUIRED_FALSE_FIELDS, ['supportsVision', 'supportsThinking'])
})
