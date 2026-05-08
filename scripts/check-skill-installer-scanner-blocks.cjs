#!/usr/bin/env node
/**
 * Stage S PR-S12 W11.2 — installer security scanner is wired.
 *
 * What this gate enforces:
 *   1. `skill-security-scanner.ts` exists, exports `scanSkillDirectory`
 *      and `HIGH_RISK_PATTERNS`.
 *   2. The pattern table covers the core deer-flow exploits we ported
 *      (rm -rf root, curl|sh, base64 eval, fetch-and-exec).
 *   3. `runtime-manager.ts` imports the scanner and invokes it from
 *      `importCustomSkill` BEFORE the skill folder is copied into the
 *      managed customSkillsRoot — install must hard-block on critical
 *      issues.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const SCANNER_FILE = 'src/main/modules/skills-runtime/skill-security-scanner.ts'
const RUNTIME_MANAGER_FILE = 'src/main/modules/skills-runtime/runtime-manager.ts'

const REQUIRED_PATTERN_DESCRIPTIONS = [
  'rm -rf root',
  'curl pipe shell',
  'eval base64',
  'fetch and exec',
]

main()

function main() {
  const root = resolve(__dirname, '..')
  const violations = []

  const scannerPath = resolve(root, SCANNER_FILE)
  if (!existsSync(scannerPath)) {
    violations.push({ file: SCANNER_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(scannerPath, 'utf8')
    if (!/export\s+function\s+scanSkillDirectory\s*\(/.test(source)) {
      violations.push({
        file: SCANNER_FILE,
        reason: 'must export function `scanSkillDirectory(skillDir): ScanResult`',
      })
    }
    if (!/export\s+const\s+HIGH_RISK_PATTERNS\b/.test(source)) {
      violations.push({
        file: SCANNER_FILE,
        reason: 'must export `HIGH_RISK_PATTERNS` table',
      })
    }
    for (const desc of REQUIRED_PATTERN_DESCRIPTIONS) {
      if (!source.includes(`'${desc}'`) && !source.includes(`"${desc}"`)) {
        violations.push({
          file: SCANNER_FILE,
          reason: `HIGH_RISK_PATTERNS must include description literal "${desc}"`,
        })
      }
    }
    if (!/path-traversal/.test(source)) {
      violations.push({
        file: SCANNER_FILE,
        reason: 'scanner must surface a `path-traversal` issue (defence-in-depth)',
      })
    }
  }

  const runtimePath = resolve(root, RUNTIME_MANAGER_FILE)
  if (!existsSync(runtimePath)) {
    violations.push({ file: RUNTIME_MANAGER_FILE, reason: 'missing file' })
  } else {
    const source = readFileSync(runtimePath, 'utf8')
    if (!/from\s+['"]\.\/skill-security-scanner['"]/.test(source)) {
      violations.push({
        file: RUNTIME_MANAGER_FILE,
        reason: "must import from './skill-security-scanner'",
      })
    }
    if (!/scanSkillDirectory\s*\(/.test(source)) {
      violations.push({
        file: RUNTIME_MANAGER_FILE,
        reason: 'must invoke `scanSkillDirectory(...)`',
      })
    }
    // The invocation must happen INSIDE importCustomSkill, BEFORE the
    // importCustomSkillFolder copy. We assert the order textually.
    const importIdx = source.search(/importCustomSkill\s*\(\s*sourcePath\s*:\s*string\s*\)\s*:\s*SkillState\s*\{/)
    const scanIdx = source.indexOf('scanSkillDirectory(')
    const copyIdx = source.indexOf('importCustomSkillFolder(')
    if (importIdx < 0 || scanIdx < 0 || copyIdx < 0) {
      violations.push({
        file: RUNTIME_MANAGER_FILE,
        reason: 'expected importCustomSkill { ... scanSkillDirectory(...) ... importCustomSkillFolder(...) ... }',
      })
    } else if (!(importIdx < scanIdx && scanIdx < copyIdx)) {
      violations.push({
        file: RUNTIME_MANAGER_FILE,
        reason: 'scanSkillDirectory must run BEFORE importCustomSkillFolder inside importCustomSkill',
      })
    }
  }

  if (violations.length > 0) {
    console.error('skill installer scanner blocks check FAILED:')
    for (const v of violations) console.error('-', v)
    process.exit(1)
  }
  console.log('skill installer scanner blocks: ok')
}

module.exports = { main }
