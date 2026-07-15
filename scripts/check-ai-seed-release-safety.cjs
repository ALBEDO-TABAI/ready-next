#!/usr/bin/env node

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_SEED_PATH = path.resolve(
  process.cwd(),
  'build/runtime-seeds/ai-settings.seed.json',
)

function verifyAiSeedReleaseSafety(raw, { allowBakedSeed = false } = {}) {
  let seed
  try {
    seed = JSON.parse(raw)
  } catch {
    throw new Error('AI settings seed is not valid JSON')
  }

  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new Error('AI settings seed must be a JSON object')
  }

  const entryCount = Object.keys(seed).length
  if (entryCount > 0 && !allowBakedSeed) {
    throw new Error(
      'AI settings seed is non-empty; normal release builds must use an empty seed. '
      + 'Use the controlled Packer flow for an intentionally seeded package.',
    )
  }

  return {
    entryCount,
    overrideUsed: entryCount > 0 && allowBakedSeed,
  }
}

function verifyAiSeedReleaseSafetyFile(
  seedPath = DEFAULT_SEED_PATH,
  { allowBakedSeed = false } = {},
) {
  let raw
  try {
    raw = fs.readFileSync(seedPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`AI settings seed is missing: ${seedPath}`)
    }
    throw error
  }
  return verifyAiSeedReleaseSafety(raw, { allowBakedSeed })
}

function main() {
  const seedPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_SEED_PATH

  try {
    const result = verifyAiSeedReleaseSafetyFile(seedPath, {
      allowBakedSeed: process.env.READY_ALLOW_BAKED_AI_SEED === '1',
    })
    const mode = result.overrideUsed ? 'controlled seeded build' : 'empty seed'
    console.log(`[ai-seed-safety] ok (${mode})`)
    return 0
  } catch (error) {
    console.error(`[ai-seed-safety] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (require.main === module) {
  process.exit(main())
}

module.exports = {
  DEFAULT_SEED_PATH,
  verifyAiSeedReleaseSafety,
  verifyAiSeedReleaseSafetyFile,
}
