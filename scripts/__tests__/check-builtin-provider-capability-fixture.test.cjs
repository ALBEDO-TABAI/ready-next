'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const { checkBuiltinProviderCapabilityFixture, PROVIDER_FILES, REQUIRED_FIELDS } = require('../check-builtin-provider-capability-fixture.cjs')

function makeFixture(perFileContent) {
  const root = mkdtempSync(join(tmpdir(), 'check-builtin-cap-fixture-'))
  const subDir = join(root, 'src/shared/ai-providers')
  mkdirSync(subDir, { recursive: true })
  for (const file of PROVIDER_FILES) {
    const content = perFileContent[file] ?? defaultGood()
    writeFileSync(join(subDir, file), content)
  }
  return root
}

function defaultGood() {
  return `
import type { AIProviderDef } from '../ai-providers'
import type { ProviderCapabilityClass } from './types'

export const def: AIProviderDef = { id: 'fake', label: '', labelEn: '', icon: '', baseUrl: '', authHeader: '', authPrefix: '', models: [], apiKeyPlaceholder: '', helpUrl: '' }

export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
  supportsLongContext: true,
}
`
}

test('passes when every provider declares all three boolean literal fields', () => {
  const root = makeFixture({})
  try {
    const result = checkBuiltinProviderCapabilityFixture({ root })
    assert.equal(result.ok, true, result.errors?.join('\n'))
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a provider is missing capabilityClass entirely', () => {
  const root = makeFixture({
    'fox.ts': `
import type { AIProviderDef } from '../ai-providers'
export const def: AIProviderDef = { id: 'fox', label: '', labelEn: '', icon: '', baseUrl: '', authHeader: '', authPrefix: '', models: [], apiKeyPlaceholder: '', helpUrl: '' }
`,
  })
  try {
    const result = checkBuiltinProviderCapabilityFixture({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /fox\.ts.*capabilityClass/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a field is omitted from a capabilityClass literal', () => {
  const root = makeFixture({
    'volcengine.ts': `
import type { ProviderCapabilityClass } from './types'
export const def = {} as any
export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: false,
  supportsThinking: false,
}
`,
  })
  try {
    const result = checkBuiltinProviderCapabilityFixture({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /volcengine\.ts.*supportsLongContext/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when a field is set to undefined or non-boolean expression', () => {
  const root = makeFixture({
    'openai.ts': `
import type { ProviderCapabilityClass } from './types'
export const def = {} as any
export const capabilityClass: ProviderCapabilityClass = {
  supportsVision: undefined,
  supportsThinking: maybe ? true : false,
  supportsLongContext: true,
}
`,
  })
  try {
    const result = checkBuiltinProviderCapabilityFixture({ root })
    assert.equal(result.ok, false)
    const blamed = result.errors.join('\n')
    assert.ok(/openai\.ts.*supportsVision/.test(blamed))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PROVIDER_FILES & REQUIRED_FIELDS are stable exports', () => {
  assert.deepEqual([...PROVIDER_FILES].sort(), [
    'anthropic.ts',
    'fox.ts',
    'gemini.ts',
    'moonshot.ts',
    'openai-compatible.ts',
    'openai.ts',
    'volcengine.ts',
  ])
  assert.deepEqual(REQUIRED_FIELDS, ['supportsVision', 'supportsThinking', 'supportsLongContext'])
})
