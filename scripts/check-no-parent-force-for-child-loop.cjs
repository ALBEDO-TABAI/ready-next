#!/usr/bin/env node
/**
 * Stage N (Phase 2) — source-level gate that locks down the runtime
 * invariants Phase 1.2/1.3 install.
 *
 * Three regex-lite checks (Stage M precedent at
 * `scripts/check-frame-write-single-source.cjs:7-11`):
 *
 *   #1 No child-loop action in `DEFAULT_RESUME_ACTION_BY_SKILL_ID`.
 *      Parses the literal in `turn-frame-steering.ts`; cross-references
 *      every entry against embedded manifests. Today the literal is empty
 *      so the check passes trivially; locks against future regression.
 *
 *   #2 turn-engine.ts synthesis site has both fences (contract +
 *      manifest). Looks for `childOwnedByContract` and asserts the
 *      surrounding 30 lines reference both `shouldParentForceLongSkillTool`
 *      and `isParentForceForbiddenByManifest`.
 *
 *   #3 turn-engine.ts forceLoopGuard write site has the invariant belt.
 *      The literal `guardPatch:` is unique in turn-engine.ts; the
 *      preceding 100 lines must reference `isParentForceForbiddenByManifest`.
 *
 * Limitations (documented):
 *   - Regex doesn't follow renamed identifiers, indirect import aliases,
 *     or multi-line/multi-file refactors. Stage N.1 may upgrade to AST.
 *
 * Exits:
 *   0  — all three checks pass
 *   1  — at least one check fails (with explicit reason)
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

const DEFAULT_TURN_ENGINE_FILE = path.join(REPO, 'src/main/modules/agent-control/turn-engine.ts')
const DEFAULT_TURN_FRAME_STEERING_FILE = path.join(REPO, 'src/main/modules/agent-control/runtime-core/turn-frame-steering.ts')
const DEFAULT_EMBEDDED_DIR = path.join(REPO, 'assets/embedded-skills')

function loadEmbeddedChildLoopActions(rootDir) {
  if (!fs.existsSync(rootDir)) return new Map()
  const result = new Map() // skillId -> Set<action>
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(rootDir, entry.name, 'ready-skill.json')
    if (!fs.existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const id = typeof manifest.id === 'string' && manifest.id.trim()
      ? manifest.id.trim()
      : entry.name
    const childLoop = manifest.child_loop ?? manifest.childLoop ?? null
    const actions = Array.isArray(childLoop?.actions)
      ? childLoop.actions.filter((a) => typeof a === 'string' && a)
      : []
    if (actions.length > 0) {
      result.set(id, new Set(actions))
    }
  }
  return result
}

function checkDefaultResumeTable(steeringFile, childLoopActionsBySkill) {
  const text = fs.readFileSync(steeringFile, 'utf8')
  const startMarker = 'const DEFAULT_RESUME_ACTION_BY_SKILL_ID'
  const startIdx = text.indexOf(startMarker)
  if (startIdx < 0) {
    return { ok: false, reason: `cannot find DEFAULT_RESUME_ACTION_BY_SKILL_ID at ${steeringFile}` }
  }
  const openBrace = text.indexOf('{', startIdx)
  if (openBrace < 0) {
    return { ok: false, reason: 'unterminated DEFAULT_RESUME_ACTION_BY_SKILL_ID literal' }
  }
  const closeBrace = text.indexOf('}', openBrace)
  if (closeBrace < 0) {
    return { ok: false, reason: 'unterminated DEFAULT_RESUME_ACTION_BY_SKILL_ID literal' }
  }
  const body = text.slice(openBrace + 1, closeBrace)
  const re = /['"]([\w-]+)['"]\s*:\s*['"]([\w_]+)['"]/g
  let match
  const violations = []
  while ((match = re.exec(body)) !== null) {
    const skillId = match[1]
    const action = match[2]
    const childActions = childLoopActionsBySkill.get(skillId)
    if (childActions && childActions.has(action)) {
      violations.push(`${skillId}:${action}`)
    }
  }
  if (violations.length > 0) {
    return {
      ok: false,
      reason: `child-loop action in default-resume table: ${violations.join(', ')}`,
    }
  }
  return { ok: true }
}

function checkSynthesisFence(turnEngineFile) {
  const text = fs.readFileSync(turnEngineFile, 'utf8')
  const lines = text.split('\n')
  const anchor = lines.findIndex((line) => /\bchildOwnedByContract\b/.test(line))
  if (anchor < 0) {
    return {
      ok: false,
      reason: 'synthesis fence missing manifest predicate (childOwnedByContract anchor not found)',
    }
  }
  const start = Math.max(0, anchor - 5)
  const end = Math.min(lines.length, anchor + 30)
  const window = lines.slice(start, end).join('\n')
  if (!window.includes('shouldParentForceLongSkillTool')) {
    return {
      ok: false,
      reason: 'synthesis fence missing contract predicate (shouldParentForceLongSkillTool not in surrounding window)',
    }
  }
  if (!window.includes('isParentForceForbiddenByManifest')) {
    return {
      ok: false,
      reason: 'synthesis fence missing manifest predicate (isParentForceForbiddenByManifest not in surrounding window)',
    }
  }
  return { ok: true }
}

function checkGuardWriteBelt(turnEngineFile) {
  const text = fs.readFileSync(turnEngineFile, 'utf8')
  const lines = text.split('\n')
  const guardLines = lines.reduce((acc, line, idx) => {
    if (/\bguardPatch:\s*TurnFramePatch\b/.test(line) || /\bconst\s+guardPatch:\s*TurnFramePatch\b/.test(line)) {
      acc.push(idx)
    }
    return acc
  }, [])
  if (guardLines.length === 0) {
    return { ok: false, reason: 'guardPatch write site not found in turn-engine.ts' }
  }
  if (guardLines.length > 1) {
    return {
      ok: false,
      reason: `guardPatch write site is ambiguous (${guardLines.length} matches); regex assumes uniqueness`,
    }
  }
  const guardLine = guardLines[0]
  const start = Math.max(0, guardLine - 100)
  const window = lines.slice(start, guardLine).join('\n')
  if (!window.includes('isParentForceForbiddenByManifest')) {
    return {
      ok: false,
      reason: 'guardPatch write site missing invariant belt (isParentForceForbiddenByManifest not in preceding 100 lines)',
    }
  }
  return { ok: true }
}

function checkNoParentForceForChildLoop(options = {}) {
  const turnEngineFile = options.turnEngineFile || DEFAULT_TURN_ENGINE_FILE
  const turnFrameSteeringFile = options.turnFrameSteeringFile || DEFAULT_TURN_FRAME_STEERING_FILE
  const embeddedDir = options.embeddedDir || DEFAULT_EMBEDDED_DIR
  const childLoopActionsBySkill = loadEmbeddedChildLoopActions(embeddedDir)

  const errors = []

  const r1 = checkDefaultResumeTable(turnFrameSteeringFile, childLoopActionsBySkill)
  if (!r1.ok) errors.push(`#1: ${r1.reason}`)
  const r2 = checkSynthesisFence(turnEngineFile)
  if (!r2.ok) errors.push(`#2: ${r2.reason}`)
  const r3 = checkGuardWriteBelt(turnEngineFile)
  if (!r3.ok) errors.push(`#3: ${r3.reason}`)

  return { ok: errors.length === 0, errors }
}

function main() {
  const result = checkNoParentForceForChildLoop()
  if (!result.ok) {
    console.error('[Stage N: check-no-parent-force-for-child-loop] FAIL')
    for (const e of result.errors) console.error(`  ${e}`)
    process.exit(1)
  }
  console.log('[Stage N: check-no-parent-force-for-child-loop] OK')
}

if (require.main === module) {
  main()
}

module.exports = {
  checkNoParentForceForChildLoop,
  checkDefaultResumeTable,
  checkSynthesisFence,
  checkGuardWriteBelt,
}
