#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — both `runtime.listTaskProjections` and
 * `runtime.getTaskProjection` must derive `canResume` before returning.
 *
 * Plan §3.4 contract C10. Renderer cold-start consumes `canResume`
 * directly; if either main entry point forgot to derive it, renderer
 * sees `undefined` and (per defensive default) treats as not resumable.
 * That defensive default avoids unsafe behavior but is not the
 * contract — the contract is BOTH entry points derive.
 *
 * Heuristic: locate each method by name and scan its body for
 * `deriveTaskProjectionCanResume` or `canResumeWithFs(` (the helper
 * names that compute the boolean before return).
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stripCodeStringsAndComments, indexToLine } = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/runtime-core/runtime.ts'

function findMethodBody(stripped, methodName) {
  // Match `methodName(` opener at typescript-ish method declaration
  // context. Class methods don't have `function` keyword, so we look
  // for `<name>(...)` followed by `:` (return type) or `{` or both.
  const re = new RegExp(`(^|\\s)${methodName}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*\\{`, 'm')
  const m = re.exec(stripped)
  if (!m) return null
  const open = stripped.indexOf('{', m.index + m[0].length - 1)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < stripped.length; i++) {
    const ch = stripped[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { start: open, end: i + 1 }
    }
  }
  return null
}

function parseRoot(argv) {
  let root = REPO_DEFAULT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length) {
      root = path.resolve(argv[i + 1])
      i++
    }
  }
  return root
}

function main() {
  const root = parseRoot(process.argv.slice(2))
  const abs = path.join(root, TARGET_REL)
  if (!fs.existsSync(abs)) {
    console.error(`[check-task-projection-canresume-derived] target file missing: ${abs}`)
    return 1
  }
  let src
  try {
    src = fs.readFileSync(abs, 'utf8')
  } catch (error) {
    console.error(`[check-task-projection-canresume-derived] cannot read: ${error}`)
    return 1
  }
  const stripped = stripCodeStringsAndComments(src)
  const violations = []
  const methods = ['listTaskProjections', 'getTaskProjection']
  for (const name of methods) {
    const body = findMethodBody(stripped, name)
    if (!body) {
      violations.push(`${name}: method body not found in ${TARGET_REL}`)
      continue
    }
    const bodyText = stripped.slice(body.start, body.end)
    const hasDerive = /\bderiveTaskProjectionCanResume\s*\(/.test(bodyText)
      || /\bcanResumeWithFs\s*\(/.test(bodyText)
    if (!hasDerive) {
      violations.push(
        `${name}: method body does not derive canResume\n  ${TARGET_REL}:${indexToLine(src, body.start)}`,
      )
    }
  }
  if (violations.length === 0) {
    console.log('[check-task-projection-canresume-derived] OK')
    return 0
  }
  console.error('[check-task-projection-canresume-derived] FAIL')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Stage Q (Stage 11): both listTaskProjections and getTaskProjection must derive canResume.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main }
