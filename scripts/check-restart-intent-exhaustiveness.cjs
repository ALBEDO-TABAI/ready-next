#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — restart intent classifier exhaustiveness gate.
 *
 * Plan §3.6 contract C8: the `RestartIntentClass` union has exactly 3
 * mutually-exclusive members. Two structural conditions must hold:
 *
 *   (a) `restart-intent-classifier.ts` declares the union with
 *       exactly 3 string-literal members.
 *   (b) The exported `RESTART_INTENT_CLASSES` array has exactly 3
 *       elements that match the union members.
 *
 * Why a gate? Without it, a future refactor could add a fourth class
 * without updating both the union and the array, breaking the
 * exhaustiveness invariant on which downstream code relies (turn-engine
 * branching, frame liveness suppression, gate behaviors).
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { stripCodeStringsAndComments } = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/restart-intent-classifier.ts'

const EXPECTED = ['fresh', 'resume', 'restart_from_existing']

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
    console.error(`[check-restart-intent-exhaustiveness] target file missing: ${abs}`)
    return 1
  }
  let src
  try {
    src = fs.readFileSync(abs, 'utf8')
  } catch (error) {
    console.error(`[check-restart-intent-exhaustiveness] cannot read: ${error}`)
    return 1
  }
  // For union members + array literals we want string contents PRESERVED
  // so the literal `'fresh' | 'resume' | 'restart_from_existing'` is
  // visible to the regex. Use the source as-is but strip COMMENTS so
  // doc text doesn't false-positive.
  const { stripCommentsOnly } = require('./_lib_strip_code_strings_and_comments.cjs')
  void stripCodeStringsAndComments // kept for parity with sister gates
  const stripped = stripCommentsOnly(src)

  const violations = []

  // (a) Union declaration: `export type RestartIntentClass = 'X' | 'Y' | 'Z'`
  const unionMatch = /\bexport\s+type\s+RestartIntentClass\s*=\s*([^;\n]+)/m.exec(stripped)
  if (!unionMatch) {
    violations.push('RestartIntentClass union declaration not found')
  } else {
    const unionRhs = unionMatch[1]
    const unionMembers = (unionRhs.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
    if (unionMembers.length !== EXPECTED.length) {
      violations.push(
        `RestartIntentClass union has ${unionMembers.length} members; expected exactly ${EXPECTED.length} (${EXPECTED.join(', ')})`,
      )
    } else {
      const sorted = [...unionMembers].sort()
      const expectedSorted = [...EXPECTED].sort()
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i] !== expectedSorted[i]) {
          violations.push(
            `RestartIntentClass member mismatch: ${unionMembers.join(', ')} vs expected ${EXPECTED.join(', ')}`,
          )
          break
        }
      }
    }
  }

  // (b) Array literal: `export const RESTART_INTENT_CLASSES: ... = [ ... ]`
  // Use brace-balanced bracket scan to capture the array content even
  // across multiple lines.
  const arrayDeclMatch = /\bexport\s+const\s+RESTART_INTENT_CLASSES\s*:[^=]*=\s*\[/m.exec(stripped)
  if (!arrayDeclMatch) {
    violations.push('RESTART_INTENT_CLASSES array declaration not found')
  } else {
    const open = stripped.indexOf('[', arrayDeclMatch.index + arrayDeclMatch[0].length - 1)
    let depth = 0
    let close = -1
    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === '[') depth += 1
      else if (stripped[i] === ']') {
        depth -= 1
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) {
      violations.push('RESTART_INTENT_CLASSES array body did not close')
    } else {
      const body = stripped.slice(open + 1, close)
      const arrMembers = (body.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1))
      if (arrMembers.length !== EXPECTED.length) {
        violations.push(
          `RESTART_INTENT_CLASSES array length is ${arrMembers.length}; expected ${EXPECTED.length}`,
        )
      } else {
        const sorted = [...arrMembers].sort()
        const expectedSorted = [...EXPECTED].sort()
        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i] !== expectedSorted[i]) {
            violations.push(
              `RESTART_INTENT_CLASSES member mismatch: ${arrMembers.join(', ')} vs expected ${EXPECTED.join(', ')}`,
            )
            break
          }
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('[check-restart-intent-exhaustiveness] OK')
    return 0
  }
  console.error('[check-restart-intent-exhaustiveness] FAIL')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Stage Q (Stage 11): RestartIntentClass union and RESTART_INTENT_CLASSES array must agree on exactly 3 members.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main }
