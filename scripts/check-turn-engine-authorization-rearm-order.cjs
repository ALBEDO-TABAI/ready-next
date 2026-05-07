#!/usr/bin/env node
/**
 * Stage 10 (P) — turn-engine authorization rearm-order gate.
 *
 * Plan §3.8.4. The Stage 10 invariant in `turn-engine.ts` is:
 *
 *   1. `let __authorization: SkillToolAuthorization | null = null` is the
 *      sole declaration shape (no `SKILL_TOOL_AUTHORIZATION_NOT_SET`
 *      placeholder).
 *   2. The closure `buildHostToolContext` opens with
 *      `if (!__authorization) throw new Error(...)`, so any pre-rearm
 *      invocation crashes with an explicit invariant message.
 *   3. The first `__authorization = buildAuthorizationFromIdentity(...)`
 *      assignment must happen before the first non-definition call to
 *      `buildHostToolContext(...)`.
 *
 * The gate strips line + block comments and string literals before
 * scanning so that talking about the invariant in a comment is not the
 * same as violating it.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/turn-engine.ts'

function stripCommentsAndStrings(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, '')
  out = out.replace(/'(?:\\.|[^'\\\n])*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
  out = out.replace(/"(?:\\.|[^"\\\n])*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
  out = out.replace(/`(?:\\.|[^`\\])*`/g, (m) => '`' + ' '.repeat(Math.max(0, m.length - 2)) + '`')
  return out
}

const RE_DECL = /\blet\s+__authorization\s*:\s*SkillToolAuthorization\s*\|\s*null\s*=\s*null\b/
const RE_NULL_CHECK = /\bif\s*\(\s*!__authorization\s*\)/
const RE_THROW = /\bthrow\s+new\s+Error\b/
const RE_REARM = /\b__authorization\s*=\s*buildAuthorizationFromIdentity\s*\(/
const RE_CALL_OR_DEF = /\bbuildHostToolContext\s*[(=]/
const RE_DEFINITION = /\bbuildHostToolContext\s*=\s*\(/

function checkTurnEngineAuthorizationRearmOrder({ root = REPO } = {}) {
  const file = path.join(root, TARGET_REL)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return {
      violations: [],
      error: `cannot read ${file}: ${error.message}`,
    }
  }
  const stripped = stripCommentsAndStrings(raw)
  const lines = stripped.split('\n')

  const violations = []

  // Check 1: declaration shape.
  const declLine = lines.findIndex((line) => RE_DECL.test(line))
  if (declLine === -1) {
    violations.push({
      file,
      line: 0,
      message: 'missing `let __authorization: SkillToolAuthorization | null = null` declaration',
    })
  }

  // Check 2: null-check + throw.
  const nullCheckLine = lines.findIndex((line) => RE_NULL_CHECK.test(line))
  if (nullCheckLine === -1) {
    violations.push({
      file,
      line: 0,
      message: 'missing `if (!__authorization)` invariant check inside buildHostToolContext',
    })
  } else {
    // Look for `throw new Error` within ~5 lines of the check.
    let foundThrow = false
    for (let i = nullCheckLine; i < Math.min(nullCheckLine + 6, lines.length); i++) {
      if (RE_THROW.test(lines[i])) {
        foundThrow = true
        break
      }
    }
    if (!foundThrow) {
      violations.push({
        file,
        line: nullCheckLine + 1,
        message: 'invariant check `if (!__authorization)` is not followed by `throw new Error` within 5 lines',
      })
    }
  }

  // Check 3: rearm-order.
  const rearmLines = []
  const callLines = []
  for (let i = 0; i < lines.length; i++) {
    if (RE_REARM.test(lines[i])) {
      rearmLines.push(i + 1)
    }
    if (RE_CALL_OR_DEF.test(lines[i]) && !RE_DEFINITION.test(lines[i])) {
      callLines.push(i + 1)
    }
  }
  if (rearmLines.length === 0) {
    violations.push({
      file,
      line: 0,
      message: 'no `__authorization = buildAuthorizationFromIdentity(...)` rearm site found',
    })
  }
  if (callLines.length === 0) {
    violations.push({
      file,
      line: 0,
      message: 'no `buildHostToolContext(...)` call sites found — closure may have been inlined; rewrite this gate',
    })
  }
  if (rearmLines.length > 0 && callLines.length > 0) {
    const minRearm = Math.min(...rearmLines)
    const minCall = Math.min(...callLines)
    if (minCall <= minRearm) {
      violations.push({
        file,
        line: minCall,
        message: `first buildHostToolContext call (line ${minCall}) precedes or equals first rearm (line ${minRearm}) — invariant order broken`,
      })
    }
  }

  return { violations, declLine: declLine + 1, rearmLines, callLines }
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

  const { violations, error } = checkTurnEngineAuthorizationRearmOrder({ root })
  if (error) {
    console.error(`[check-turn-engine-authorization-rearm-order] FAIL: ${error}`)
    return 1
  }
  if (violations.length === 0) {
    console.log('[check-turn-engine-authorization-rearm-order] OK')
    return 0
  }

  console.error('[check-turn-engine-authorization-rearm-order] FAIL')
  for (const v of violations) {
    console.error(`  ${path.relative(root, v.file)}:${v.line || '-'} — ${v.message}`)
  }
  console.error('')
  console.error('Stage 10 (P): __authorization is declared `| null = null`, guarded by an')
  console.error('invariant null-check + throw inside `buildHostToolContext`, and rearmed')
  console.error('via `buildAuthorizationFromIdentity` before the first call site.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { checkTurnEngineAuthorizationRearmOrder }
