#!/usr/bin/env node
/**
 * Stage R W1.6 gate (R8-D1).
 *
 * The string-literal `module` union appears in 4 independent places across
 * main, renderer, types, and renderer IPC mirrors. Each one must include
 * `'research'`. Without this gate, typecheck cannot catch the omission
 * because:
 *   - renderer `electron.d.ts` mirrors the main union but is independent
 *   - `toAgentModule()` is a type-guard function whose default branch
 *     silently returns null instead of producing a typecheck error
 *
 * Locations checked:
 *   1. src/main/modules/agent-control/contracts/types.ts      ScopeRunEventPayload.module
 *   2. src/renderer/types/electron.d.ts                       ScopeRunEventData.module/artifacts
 *   3. src/renderer/modules/agent/types.ts                    AgentModuleKind
 *   4. src/renderer/modules/agent/scopeRunState.ts            toAgentModule() switch
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    console.error(`[check-module-allowlist-completeness] FAIL: cannot read ${rel}: ${e.message}`)
    process.exit(1)
  }
}

const errors = []

/**
 * Verify that the substring `body` between `startMarker` and `endMarker`
 * (or the next 1500 chars after startMarker if no endMarker) contains
 * `'research'`.
 */
function verifyContainsResearch(label, body, startMarker, endMarker) {
  const startIdx = body.indexOf(startMarker)
  if (startIdx < 0) {
    errors.push(`${label}: anchor not found: ${startMarker}`)
    return
  }
  const tail = body.slice(startIdx)
  const endIdx = endMarker ? tail.indexOf(endMarker) : -1
  const window = endIdx > 0 ? tail.slice(0, endIdx) : tail.slice(0, 1500)
  if (!/['"]research['"]/.test(window)) {
    errors.push(`${label}: union after \`${startMarker}\` must include literal 'research'`)
  }
}

// 1: main types.ts
const mainTypes = readFile('src/main/modules/agent-control/contracts/types.ts')
verifyContainsResearch(
  'main/types.ts ScopeRunEventPayload.module',
  mainTypes,
  'export interface ScopeRunEventPayload',
  'export interface',
)

// 2: renderer electron.d.ts
const electronDts = readFile('src/renderer/types/electron.d.ts')
verifyContainsResearch(
  'electron.d.ts ScopeRunEventData.module',
  electronDts,
  'interface ScopeRunEventData',
  'artifactRefs',
)
// artifactRefs[].module is a nested union starting after `artifactRefs?:`
{
  const startIdx = electronDts.indexOf('interface ScopeRunEventData')
  if (startIdx < 0) {
    errors.push('electron.d.ts ScopeRunEventData: anchor not found')
  } else {
    const slice = electronDts.slice(startIdx)
    const artifactsIdx = slice.indexOf('artifactRefs')
    if (artifactsIdx < 0) {
      errors.push('electron.d.ts ScopeRunEventData.artifactRefs[].module: anchor not found')
    } else {
      const artifactsBlock = slice.slice(artifactsIdx, artifactsIdx + 1000)
      if (!/['"]research['"]/.test(artifactsBlock)) {
        errors.push('electron.d.ts ScopeRunEventData.artifactRefs[].module must include literal \'research\'')
      }
    }
  }
}

// 3: AgentModuleKind union
const rendererTypes = readFile('src/renderer/modules/agent/types.ts')
verifyContainsResearch(
  'renderer types.ts AgentModuleKind',
  rendererTypes,
  'export type AgentModuleKind',
  '\nexport',
)

// 4: toAgentModule() function body
const scopeRunState = readFile('src/renderer/modules/agent/scopeRunState.ts')
verifyContainsResearch(
  'scopeRunState.ts toAgentModule()',
  scopeRunState,
  'function toAgentModule',
  '\n}',
)

if (errors.length > 0) {
  console.error('[check-module-allowlist-completeness] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-module-allowlist-completeness] OK')
