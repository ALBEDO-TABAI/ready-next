#!/usr/bin/env node
/**
 * Stage S PR-S12 W11.1 — manifest `allowed_tools` field is wired.
 *
 * Round 1 (helper-only) only required the manifest contract surface:
 *   1. SkillDefinition declares optional `allowedTools?: string[]`.
 *   2. skill-compiler validates and attaches the normalised array.
 *   3. A `validateAllowedTools` helper is exported.
 *
 * Round 2 strengthens to runtime enforcement:
 *   4. `tool-gateway.ts` exposes a `filterToolsByAllowedTools` helper.
 *   5. `execution-tool-config.ts` (the model-visible bundle path)
 *      actually CALLS `filterToolsByAllowedTools` in both the anthropic
 *      and openai bundle paths.
 *   6. `run-capability-controller.ts` resolves the active skill's
 *      manifest allowlist onto the policy so the bundle path has data.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const TYPES_FILE = 'src/shared/skill-execution-types.ts'
const COMPILER_FILE = 'src/main/modules/skills-runtime/skill-compiler.ts'
const GATEWAY_FILE = 'src/main/modules/agent-control/tool-gateway.ts'
const BUNDLE_FILE = 'src/main/modules/agent-control/execution-tool-config.ts'
const CONTROLLER_FILE = 'src/main/modules/agent-control/run-capability-controller.ts'

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

  // Round 2 — gateway helper present.
  const gatewayPath = resolve(root, GATEWAY_FILE)
  if (!existsSync(gatewayPath)) {
    violations.push({ file: GATEWAY_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(gatewayPath, 'utf8')
    if (!/\bfilterToolsByAllowedTools\b/.test(source)) {
      violations.push({
        file: GATEWAY_FILE,
        reason: 'must export `filterToolsByAllowedTools` helper',
      })
    }
  }

  // Round 2 — bundle path actually consumes the helper in BOTH paths.
  const bundlePath = resolve(root, BUNDLE_FILE)
  if (!existsSync(bundlePath)) {
    violations.push({ file: BUNDLE_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(bundlePath, 'utf8')
    const importsHelper = /import\s*\{[^}]*\bfilterToolsByAllowedTools\b[^}]*\}\s*from\s*['"]\.\/tool-gateway['"]/.test(source)
    if (!importsHelper) {
      violations.push({
        file: BUNDLE_FILE,
        reason: 'must import `filterToolsByAllowedTools` from `./tool-gateway`',
      })
    }
    const callCount = (source.match(/\bfilterToolsByAllowedTools\s*\(/g) || []).length
    if (callCount < 2) {
      violations.push({
        file: BUNDLE_FILE,
        reason: `filterToolsByAllowedTools called ${callCount} time(s); expected ≥ 2 (anthropic path + openai bundle path)`,
      })
    }
  }

  // Round 2 — controller resolves the active-skill allowlist onto the policy.
  const controllerPath = resolve(root, CONTROLLER_FILE)
  if (!existsSync(controllerPath)) {
    violations.push({ file: CONTROLLER_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(controllerPath, 'utf8')
    if (!/toolPolicy\.activeSkillAllowedTools\s*=/.test(source)) {
      violations.push({
        file: CONTROLLER_FILE,
        reason: 'must assign `toolPolicy.activeSkillAllowedTools` so the bundle path can filter',
      })
    }
    if (!/resolveActiveSkillAllowedTools\s*\(/.test(source)) {
      violations.push({
        file: CONTROLLER_FILE,
        reason: 'must call `resolveActiveSkillAllowedTools(...)` to derive the allowlist from runtime',
      })
    }
  }

  if (violations.length > 0) {
    console.error('skill allowed_tools enforcement check FAILED:')
    for (const v of violations) console.error('-', v)
    process.exit(1)
  }
  console.log('skill allowed_tools enforcement: ok (helper + bundle integration + controller threading)')
}

module.exports = { main }
