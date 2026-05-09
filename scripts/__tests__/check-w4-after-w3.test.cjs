'use strict'

const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const { checkW4AfterW3 } = require('../check-w4-after-w3.cjs')

const PROVIDER_FILES = [
  'moonshot.ts',
  'anthropic.ts',
  'fox.ts',
  'openai.ts',
  'gemini.ts',
  'volcengine.ts',
  'openai-compatible.ts',
]

function makeFixture({ providerFilesPresent = true, sharedAiProviders }) {
  const root = mkdtempSync(join(tmpdir(), 'check-w4-after-w3-'))
  const subDir = join(root, 'src/shared/ai-providers')
  if (providerFilesPresent) {
    mkdirSync(subDir, { recursive: true })
    for (const file of PROVIDER_FILES) {
      writeFileSync(join(subDir, file), `export const def = {} as any\nexport const capabilityClass = { supportsVision: false, supportsThinking: false, supportsLongContext: false }\n`)
    }
  } else {
    mkdirSync(join(root, 'src/shared'), { recursive: true })
  }
  writeFileSync(join(root, 'src/shared/ai-providers.ts'), sharedAiProviders)
  return root
}

const GOOD_AI_PROVIDERS = `
export interface AIProviderDef {
  id: string
  capabilityClass?: {
    supportsVision?: boolean
    supportsThinking?: boolean
    supportsLongContext?: boolean
  }
}

export interface AIModelDef {
  id: string
  capabilityOverrides?: {
    supportsVision?: boolean
    supportsThinking?: boolean
    supportsLongContext?: boolean
  }
}

export interface AIResolvedCapabilities {
  supportsThinking: boolean
  supportsLongContext: boolean
}

export function resolveAIConfigCapabilities(config) {
  const providerCap = provider?.capabilityClass ?? {}
  const modelCap = modelDef?.capabilityOverrides ?? {}
  const visionDefault = modelCap.supportsVision ?? providerCap.supportsVision ?? true
  const thinkingDefault = modelCap.supportsThinking ?? providerCap.supportsThinking ?? false
  const longContextDefault = modelCap.supportsLongContext ?? providerCap.supportsLongContext ?? false
  return { supportsVision: visionDefault, supportsThinking: thinkingDefault, supportsLongContext: longContextDefault }
}
`

test('passes when all preconditions and merge body present', () => {
  const root = makeFixture({ sharedAiProviders: GOOD_AI_PROVIDERS })
  try {
    const result = checkW4AfterW3({ root })
    assert.equal(result.ok, true, result.errors?.join('\n'))
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when sub-directory is missing (W3 not landed)', () => {
  const root = makeFixture({ providerFilesPresent: false, sharedAiProviders: GOOD_AI_PROVIDERS })
  try {
    const result = checkW4AfterW3({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /PR-S3 precondition/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when capabilityClass interface field is removed', () => {
  const broken = GOOD_AI_PROVIDERS.replace(/capabilityClass\?\s*:\s*\{[\s\S]*?\}\s*/, '')
  const root = makeFixture({ sharedAiProviders: broken })
  try {
    const result = checkW4AfterW3({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /AIProviderDef\.capabilityClass/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when AIResolvedCapabilities makes supportsThinking optional', () => {
  const broken = GOOD_AI_PROVIDERS.replace(/supportsThinking\s*:\s*boolean/, 'supportsThinking?: boolean')
  const root = makeFixture({ sharedAiProviders: broken })
  try {
    const result = checkW4AfterW3({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /supportsThinking.*required/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails when resolver body has no capabilityClass / capabilityOverrides chain', () => {
  const broken = GOOD_AI_PROVIDERS.replace(
    /export function resolveAIConfigCapabilities[\s\S]*$/,
    `export function resolveAIConfigCapabilities(config) { return { supportsThinking: false, supportsLongContext: false } }\n`,
  )
  const root = makeFixture({ sharedAiProviders: broken })
  try {
    const result = checkW4AfterW3({ root })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((e) => /capabilityClass/.test(e)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
