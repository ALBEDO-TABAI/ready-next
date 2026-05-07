#!/usr/bin/env node
/**
 * Stage 10 (P) — `resolvePrimitiveSkillId` shape gate.
 *
 * Plan §3.8.2. Once `'not_set'` is retired, the W3a-era cascade fallback
 * (active-skill-context → reference-skill hint → latest-active-task-run
 * → choosePrimitiveSkillId tiebreaker) inside `resolvePrimitiveSkillId`
 * is unreachable. The Stage 10 contract is: the function consults
 * `runtimeContext.authorization` and nothing else.
 *
 * This gate scans the body of `resolvePrimitiveSkillId` in
 * `src/main/modules/tools/skills-tools.ts` and forbids the four legacy
 * resolver names — including in comments and string literals, so the
 * cascade vocabulary cannot creep back in via "we used to call X".
 *
 * Body boundary: from the line matching `function resolvePrimitiveSkillId(`
 * up to the next top-level `function ` / `export ` / `class ` / `interface `
 * / `type ` declaration.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const TARGET_FILE = path.join(
  REPO,
  'src/main/modules/tools/skills-tools.ts',
)

const FORBIDDEN_SYMBOLS = [
  'resolveActiveSkillContext',
  'getLastReferenceSkill',
  'getLatestActiveSkillTaskRun',
  'choosePrimitiveSkillId',
]

function locateFunctionBody(src) {
  const lines = src.split('\n')
  const startIdx = lines.findIndex((line) =>
    /^\s*function\s+resolvePrimitiveSkillId\s*\(/.test(line),
  )
  if (startIdx === -1) {
    return { found: false }
  }
  // Body ends at the next top-level declaration or EOF.
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (
      /^(export\s+)?(function|class|interface|type)\s/.test(lines[i])
      || /^(export|import)\s/.test(lines[i])
    ) {
      endIdx = i
      break
    }
  }
  return { found: true, startIdx, endIdx, lines }
}

function checkResolvePrimitiveSkillIdShape({ root = REPO } = {}) {
  const target = path.join(root, 'src/main/modules/tools/skills-tools.ts')
  let src
  try {
    src = fs.readFileSync(target, 'utf8')
  } catch (error) {
    return {
      violations: [],
      error: `cannot read ${target}: ${error.message}`,
    }
  }
  const located = locateFunctionBody(src)
  if (!located.found) {
    return {
      violations: [],
      error: 'resolvePrimitiveSkillId function not found in skills-tools.ts',
    }
  }
  const { startIdx, endIdx, lines } = located
  const violations = []
  for (let i = startIdx; i < endIdx; i++) {
    const line = lines[i]
    for (const sym of FORBIDDEN_SYMBOLS) {
      if (line.includes(sym)) {
        violations.push({
          file: target,
          line: i + 1,
          symbol: sym,
          code: line.trim(),
        })
      }
    }
  }
  return { violations }
}

function main() {
  const args = process.argv.slice(2)
  let root = REPO
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      root = path.resolve(args[i + 1])
      i++
    }
  }

  const { violations, error } = checkResolvePrimitiveSkillIdShape({ root })
  if (error) {
    console.error(`[check-resolve-primitive-skill-id-shape] FAIL: ${error}`)
    return 1
  }
  if (violations.length === 0) {
    console.log('[check-resolve-primitive-skill-id-shape] OK')
    return 0
  }

  console.error('[check-resolve-primitive-skill-id-shape] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line} — ${v.symbol}`)
    console.error(`    code: ${v.code}`)
  }
  console.error('')
  console.error('Stage 10 (P): resolvePrimitiveSkillId only consults `runtimeContext.authorization`.')
  console.error('The W3a cascade (active-context / reference-hint / task-run / chooser) is retired.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { checkResolvePrimitiveSkillIdShape }
