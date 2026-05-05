#!/usr/bin/env node
/**
 * Stage 4 W2 — block the rearm decision from re-scattering across
 * turn-engine.ts. Post-W2 the only places allowed to make rearm
 * decisions are:
 *
 *   - `applySkillTurnIdentity` in skill-turn-identity.ts (single mutator
 *     entry for all skill rearm sources)
 *   - Point F's explicit-hint registration line in turn-engine.ts (one
 *     specific call to `rememberExplicitReferenceSkillHint`)
 *
 * This script forbids the patterns the W2 cutover removed, even if a
 * future refactor renames or rewrites the surrounding strings (the
 * existing W0 source-grep test only counts one specific Chinese
 * sentence; this script catches the broader rearm-mutation shape).
 *
 * If a legitimate new use case requires direct rearm in turn-engine,
 * extend this script with a precise allowlist entry and document why.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const TURN_ENGINE = 'src/main/modules/agent-control/turn-engine.ts'

// Mutators that previously lived inline in legacy Points B/C/D/E.
// Post-W2, all five must originate ONLY from inside `applySkillTurnIdentity`
// in skill-turn-identity.ts. The interface declarations on
// `SkillContextOrchestratorLike` (turn-engine.ts:~600) are NOT invocations
// — they're typed as `?:` followed by a parameter list, distinguishable
// from the call form `name(` / `name?.(`.
const FORBIDDEN_MUTATORS = [
  'rememberReferenceSkillFromRunStateResource',
  'rememberReferenceSkillFromPriorToolUses',
]

// Allow exactly one Point F invocation of `rememberExplicitReferenceSkillHint`
// in turn-engine.ts (legacy lines 1651-1665). More than one means rearm
// is being re-injected somewhere new.
const POINT_F_MUTATOR = 'rememberExplicitReferenceSkillHint'
const POINT_F_ALLOWED_INVOCATIONS = 1

// Direct construction of rearm result objects in turn-engine — these
// belong inside `applySkillTurnIdentity`. Post-W2, turn-engine should
// only RECEIVE these via `__applied.lookbackRearmedSkill` etc.
const FORBIDDEN_DIRECT_PATTERNS = [
  {
    name: 'lookbackRearmedSkill literal construction',
    re: /lookbackRearmedSkill\s*=\s*\{/g,
    note: 'turn-engine must consume `__applied.lookbackRearmedSkill`; literal construction belongs in applySkillTurnIdentity',
  },
  {
    name: 'skillContextInjectionText with rearm template literal',
    re: /skillContextInjectionText\s*=\s*`用户希望继续使用 skill/g,
    note: 'turn-engine must consume `__applied.skillContextInjectionText`; rearm-template assignment belongs in applySkillTurnIdentity',
  },
  {
    name: 'referenceSkillHintVia direct rearm assignment',
    re: /referenceSkillHintVia\s*=\s*['"](?:resource(?:_history)?|lookback|current|history)['"]/g,
    note: 'turn-engine must consume `__applied.referenceSkillHintVia`; rearm-source assignment belongs in applySkillTurnIdentity (Point F may set "explicit" — that case is excluded by the regex)',
  },
]

main()

function main() {
  const root = resolve(__dirname, '..')
  const filePath = resolve(root, TURN_ENGINE)
  if (!existsSync(filePath)) {
    console.error(`skill rearm locality: missing ${TURN_ENGINE}`)
    process.exit(1)
  }
  const source = readFileSync(filePath, 'utf8')
  // Strip block + line comments so doc references like
  // "// rememberReferenceSkillFromPriorToolUses" don't false-positive.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  const violations = []

  for (const mutator of FORBIDDEN_MUTATORS) {
    const re = new RegExp(`\\b${mutator}\\s*\\?\\s*\\.?\\s*\\(|\\b${mutator}\\s*\\(`, 'g')
    const matches = stripped.match(re) || []
    if (matches.length > 0) {
      violations.push({
        kind: 'forbidden-mutator',
        symbol: mutator,
        count: matches.length,
        note: 'must only be invoked from `applySkillTurnIdentity` (skill-turn-identity.ts) — post-W2 turn-engine has no rearm-mutator call sites',
      })
    }
  }

  // Point F's `rememberExplicitReferenceSkillHint` — exactly one invocation.
  const pointFRe = new RegExp(
    `\\b${POINT_F_MUTATOR}\\s*\\?\\s*\\.?\\s*\\(|\\b${POINT_F_MUTATOR}\\s*\\(`,
    'g',
  )
  const pointFMatches = stripped.match(pointFRe) || []
  if (pointFMatches.length !== POINT_F_ALLOWED_INVOCATIONS) {
    violations.push({
      kind: 'point-f-call-count',
      symbol: POINT_F_MUTATOR,
      count: pointFMatches.length,
      expected: POINT_F_ALLOWED_INVOCATIONS,
      note: `expected exactly ${POINT_F_ALLOWED_INVOCATIONS} invocation (Point F explicit-hint registration); found ${pointFMatches.length}`,
    })
  }

  for (const pattern of FORBIDDEN_DIRECT_PATTERNS) {
    const matches = stripped.match(pattern.re) || []
    if (matches.length > 0) {
      violations.push({
        kind: 'forbidden-pattern',
        pattern: pattern.name,
        count: matches.length,
        note: pattern.note,
        sample: matches[0],
      })
    }
  }

  if (violations.length > 0) {
    console.error('skill rearm locality check FAILED:')
    for (const v of violations) {
      console.error('-', v)
    }
    console.error('')
    console.error(
      'Post-W2 contract: rearm decisions live ONLY in `applySkillTurnIdentity`',
    )
    console.error(
      '(skill-turn-identity.ts) plus the single Point F invocation. If a',
    )
    console.error(
      'legitimate new use case requires direct rearm in turn-engine.ts,',
    )
    console.error('extend this script\'s allowlist with a precise rule and rationale.')
    process.exit(1)
  }
  console.log('skill rearm locality: ok')
}

module.exports = { main }
