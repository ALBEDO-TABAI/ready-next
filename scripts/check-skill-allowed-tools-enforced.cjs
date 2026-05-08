#!/usr/bin/env node
/**
 * Stage S PR-S12 W11.1 — manifest `allowed_tools` field is wired.
 *
 * What this gate enforces (helper-only stage):
 *   1. SkillDefinition (shared type) declares optional `allowedTools?: string[]`.
 *   2. skill-compiler validates the manifest field at compile time and
 *      stores the normalised array on the definition.
 *   3. A validator helper (`validateAllowedTools`) is exported so future
 *      tool-gateway integration has one canonical entry point.
 *
 * Tool-gateway integration is a follow-up — this gate intentionally does
 * not require runtime enforcement yet; it just ensures the manifest
 * contract surface exists and is wired through compile.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const TYPES_FILE = 'src/shared/skill-execution-types.ts'
const COMPILER_FILE = 'src/main/modules/skills-runtime/skill-compiler.ts'

main()

function main() {
  const root = resolve(__dirname, '..')
  const violations = []

  const typesPath = resolve(root, TYPES_FILE)
  if (!existsSync(typesPath)) {
    violations.push({ file: TYPES_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(typesPath, 'utf8')
    if (!/allowedTools\s*\?\s*:\s*string\s*\[\s*\]/.test(source)) {
      violations.push({
        file: TYPES_FILE,
        reason: 'SkillDefinition must declare optional `allowedTools?: string[]`',
      })
    }
  }

  const compilerPath = resolve(root, COMPILER_FILE)
  if (!existsSync(compilerPath)) {
    violations.push({ file: COMPILER_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(compilerPath, 'utf8')
    // Validator helper exists and is exported.
    if (!/function\s+validateAllowedTools\s*\(/.test(source)) {
      violations.push({
        file: COMPILER_FILE,
        reason: 'must define a `validateAllowedTools(skillId, raw)` helper',
      })
    }
    if (!/export\s*\{[^}]*validateAllowedTools[^}]*\}/.test(source)) {
      violations.push({
        file: COMPILER_FILE,
        reason: 'must export `validateAllowedTools` (so future gateway integration can import it)',
      })
    }
    // ManifestValidationError exists & is thrown.
    if (!/class\s+ManifestValidationError\s+extends\s+Error/.test(source)) {
      violations.push({
        file: COMPILER_FILE,
        reason: 'must define `ManifestValidationError` class (shape rejection contract)',
      })
    }
    // compileSkillDefinition reads `allowed_tools` from the manifest and
    // attaches the normalised value to the returned definition.
    if (!/manifest\?\.allowed_tools/.test(source)) {
      violations.push({
        file: COMPILER_FILE,
        reason: 'compileSkillDefinition must read `manifest?.allowed_tools`',
      })
    }
    if (!/allowedTools\s*,?\s*\n\s*\}\s*\n*\}/.test(source) && !/allowedTools[ ,]/.test(source)) {
      violations.push({
        file: COMPILER_FILE,
        reason: 'compileSkillDefinition return must include `allowedTools`',
      })
    }
  }

  if (violations.length > 0) {
    console.error('skill allowed_tools enforcement check FAILED:')
    for (const v of violations) console.error('-', v)
    process.exit(1)
  }
  console.log('skill allowed_tools enforcement: ok (helper-only; gateway integration TODO)')
}

module.exports = { main }
