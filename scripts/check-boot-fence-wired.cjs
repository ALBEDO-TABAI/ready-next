#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — boot fence wiring gate.
 *
 * PR-3 (Q.3a) shipped the `assertSkillTaskRunInvariantConsistency()`
 * helper body. PR-5 (Q.3b) wires it into the runtime constructor so
 * the incompatible combination (`READY_SKILL_TASK_RUN_INVARIANT_ENFORCED=0`
 * AND migrated CHECK present) throws at startup. This gate ensures the
 * wiring is in place — the helper is imported AND called from
 * `runtime.ts` constructor (or a method invoked from constructor).
 *
 * Why a gate? Without it, a refactor could accidentally drop the call
 * site and downgrade to silent inconsistency.
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  stripCodeStringsAndComments,
  stripCommentsOnly,
  buildIsInsideStringMask,
} = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const TARGET_REL = 'src/main/modules/agent-control/runtime.ts'

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
    console.error(`[check-boot-fence-wired] target file missing: ${abs}`)
    return 1
  }
  let src
  try {
    src = fs.readFileSync(abs, 'utf8')
  } catch (error) {
    console.error(`[check-boot-fence-wired] cannot read: ${error}`)
    return 1
  }
  const stripped = stripCodeStringsAndComments(src)
  const violations = []

  // 1. Must import the helper via a real import statement, sourced
  //    from `skill-task-tracker` (Codex round 2 ❌#2 + round 3 ⚠️#2):
  //
  //      Round 2 fix: require actual `import { X } from '...'`.
  //      Round 3 found two evasion paths:
  //        (a) `stripCommentsOnly` preserves string contents, so a string
  //            literal containing the import text passes.
  //        (b) `from '...'` source wasn't constrained.
  //
  //    Final design (two-pass like check-renderer-no-canresume-import):
  //    PASS A — `stripCommentsOnly` projection (strings preserved) so
  //    we can validate the path string contains `skill-task-tracker`.
  //    PASS A's match position is then validated against the original-
  //    source `buildIsInsideStringMask` so the keyword `import` cannot
  //    itself be inside a string literal (closing evasion path (a)).
  //
  //    Round 4 tightenings:
  //      (i) Reject inline `type` specifier (`import { type X } ...`)
  //          — that's a type-only import; runtime value not bound.
  //      (ii) Require the path to END with `/skill-task-tracker` (with
  //           optional `.ts`/`.js`/`.mjs` extension).
  //
  //    Round 5 tightenings:
  //      (iii) Reject `as alias` rebinding — the imported value MUST be
  //            bound to the original name `assertSkillTaskRunInvariantConsistency`
  //            so the wrapper's call resolves to the real import (not a
  //            local stub of the same name).
  //      (iv) Path must be EXACTLY `./skill-task-tracker(.ext)?` (sibling
  //            module). Sub-directory or parent-directory paths like
  //            `./shim/skill-task-tracker` or `../skill-task-tracker`
  //            are rejected. runtime.ts and skill-task-tracker.ts live
  //            in the same `agent-control/` directory; any other shape
  //            is suspicious.
  const importStripped = stripCommentsOnly(src)
  const insideString = buildIsInsideStringMask(src)
  // Specifier may be `assertSkillTaskRunInvariantConsistency` ONLY
  // (NOT `type X`, NOT `X as alias`).
  // Path must be EXACTLY `./skill-task-tracker(\.[a-zA-Z]+)?` between quotes.
  const importRe = /\bimport\s*\{(?:[^}]*?,)?\s*(?!type\s+)assertSkillTaskRunInvariantConsistency\b(?!\s+as\b)[^}]*\}\s*from\s*(['"])\.\/skill-task-tracker(?:\.[a-zA-Z]+)?\1/gs
  let importOk = false
  let m
  while ((m = importRe.exec(importStripped)) !== null) {
    if (insideString[m.index]) continue // keyword inside a string → not real
    importOk = true
    break
  }
  if (!importOk) {
    violations.push('runtime.ts does not import assertSkillTaskRunInvariantConsistency from skill-task-tracker via a real import statement')
  }

  // Helper to extract a brace-balanced body starting from a regex match
  // (the regex must end with `{` of the body opener).
  const extractBody = (regex) => {
    const m = regex.exec(stripped)
    if (!m) return null
    const open = stripped.indexOf('{', m.index + m[0].length - 1)
    if (open < 0) return null
    let depth = 0
    for (let i = open; i < stripped.length; i++) {
      if (stripped[i] === '{') depth += 1
      else if (stripped[i] === '}') {
        depth -= 1
        if (depth === 0) return { start: open, end: i + 1, headerStart: m.index }
      }
    }
    return null
  }

  // 2. The helper invocation MUST live inside the
  //    `maybeAssertSkillTaskRunInvariant` method body. Codex round 1 ⚠️#4:
  //    earlier draft only checked file-wide presence, so a future refactor
  //    that moves the call to an unrelated helper would silently pass.
  //    Require leading `private` to disambiguate from `this.<name>()` call
  //    sites (which don't carry the modifier).
  const wrapperBody = extractBody(/\bprivate\s+maybeAssertSkillTaskRunInvariant\s*\([^)]*\)\s*[^{]*\{/)
  if (!wrapperBody) {
    violations.push('maybeAssertSkillTaskRunInvariant method body not located')
  } else {
    const body = stripped.slice(wrapperBody.start, wrapperBody.end)
    if (!/\bassertSkillTaskRunInvariantConsistency\s*\(/.test(body)) {
      violations.push(
        'maybeAssertSkillTaskRunInvariant body does not invoke assertSkillTaskRunInvariantConsistency',
      )
    }
  }

  // 3. Constructor must call the boot-fence wrapper. Belt-and-braces:
  //    even if the helper invocation is correctly placed inside the
  //    wrapper, the constructor must actually call the wrapper at boot.
  const ctorBody = extractBody(/\bconstructor\s*\([^)]*\)\s*\{/)
  if (!ctorBody) {
    violations.push('runtime.ts constructor not located')
  } else {
    const body = stripped.slice(ctorBody.start, ctorBody.end)
    if (!/\bthis\.maybeAssertSkillTaskRunInvariant\s*\(/.test(body)) {
      violations.push(
        'constructor body does not call this.maybeAssertSkillTaskRunInvariant() — boot fence not wired',
      )
    }
  }

  if (violations.length === 0) {
    console.log('[check-boot-fence-wired] OK')
    return 0
  }
  console.error('[check-boot-fence-wired] FAIL')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Stage Q (Stage 11): boot fence must be wired into runtime constructor.')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main }
