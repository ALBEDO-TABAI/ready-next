#!/usr/bin/env node
/**
 * Stage M (M4+M5) — `skill_read_artifact` no longer falls back to
 * `resolveActiveSkillContext`.
 *
 * Plan §3.2: in the source region between the `skill_read_artifact` branch
 * and the next `tool.name === '...'` boundary, the substrings
 * `resolveActiveSkillContext` and `activeContextForRoots` MUST NOT appear.
 *
 * This is a hard CI gate. If a future refactor re-introduces the legacy
 * fallback, we surface it before code review.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const TARGET_FILE = path.resolve(__dirname, '..', 'src', 'main', 'modules', 'tools', 'skills-tools.ts')
const ENTRY_MARKER = "tool.name === 'skill_read_artifact'"
const FORBIDDEN = ['resolveActiveSkillContext', 'activeContextForRoots']

function main() {
  const src = fs.readFileSync(TARGET_FILE, 'utf8')
  const entryIndex = src.indexOf(ENTRY_MARKER)
  if (entryIndex === -1) {
    console.error(`[check-read-artifact-no-active-context] entry marker not found: ${ENTRY_MARKER}`)
    process.exit(2)
  }
  const after = src.slice(entryIndex)
  // Find the next tool.name === '...' boundary (any other tool branch).
  const boundaryRe = /tool\.name === '(?!skill_read_artifact')[^']+'/
  const boundaryMatch = boundaryRe.exec(after)
  const branchEnd = boundaryMatch ? boundaryMatch.index : after.length
  const branchSrc = after.slice(0, branchEnd)

  let failed = false
  for (const forbidden of FORBIDDEN) {
    if (branchSrc.includes(forbidden)) {
      const lineOffset = branchSrc.split('\n').findIndex((line) => line.includes(forbidden))
      const lineNumber = src.slice(0, entryIndex).split('\n').length + Math.max(0, lineOffset)
      console.error(
        `[check-read-artifact-no-active-context] FAIL: forbidden symbol "${forbidden}" appears in the skill_read_artifact branch.\n`
        + `  Location: ${path.relative(process.cwd(), TARGET_FILE)}:${lineNumber}\n`
        + `  Stage M (M4+M5) removed the legacy active-context fallback. The resolver (M0a) seeds\n`
        + `  frame.activeArtifactRoots from the same context paths, and contextModifier (M5a) gives\n`
        + `  same-batch reads fresh roots. Re-introducing the fallback is a regression — see plan §3.2.`,
      )
      failed = true
    }
  }
  if (failed) process.exit(1)
  console.log('[check-read-artifact-no-active-context] OK')
}

main()
