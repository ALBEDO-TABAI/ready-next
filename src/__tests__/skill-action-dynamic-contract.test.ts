/**
 * Phase 2.5 PR 12 — dynamic skill-action Zod schema wiring contract.
 *
 * Source-level regex asserts on skills-tools.ts + tool-executor.ts because the
 * runtime path pulls skills-runtime-manager which imports electron.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('skills-tools exposes getSkillActionSchemas with a signature-based cache', () => {
  const source = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')

  assert.match(source, /from ['"]\.\/paramList-to-zod['"]/)
  assert.match(source, /export function getSkillActionSchemas/)
  assert.match(source, /skillActionSchemaCache/)
  assert.match(source, /skillActionSchemaSignature/)
  assert.match(source, /computeSkillActionSignature/)

  // Cache is rebuilt only when the signature changes.
  assert.match(source, /if \(sig !== skillActionSchemaSignature\)/)

  // Manifests that fail derivation must not crash the whole registry.
  assert.match(source, /catch \{\s*\/\/[^\n]*malformed manifest/i)
})

test('tool-executor merges dynamic skill-action schemas with static-wins precedence', () => {
  const source = readWorkspaceFile('src/main/modules/tools/tool-executor.ts')

  assert.match(source, /getSkillActionSchemas/)
  // Dynamic first, static second so spread order lets the 6 control schemas
  // override any hypothetical user-action collision.
  assert.match(
    source,
    /\{\s*\.\.\.getSkillActionSchemas\(\)\s*,\s*\.\.\.getToolInputSchemas\(\)\s*\}/,
  )
})

test('STATIC_TOOL_NAMES table only aliases embedded skills, never reserved control-tool names', () => {
  // skills-tools.ts's buildToolName prefixes sanitized skill IDs as
  // `skill_<skillId>_<action>`. The STATIC_TOOL_NAMES lookup table currently
  // aliases video-expert + lets-go-rss action names; any future entry must
  // NOT map onto a reserved control-tool name. We check the keys explicitly
  // under the STATIC_TOOL_NAMES object literal, not switch-case labels.
  const source = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')
  const tableMatch = source.match(/const STATIC_TOOL_NAMES:[^=]*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(tableMatch, 'could not locate STATIC_TOOL_NAMES literal')
  const tableBody = tableMatch[1]
  for (const reserved of [
    'skill_get_state',
    'skill_submit_input',
    'skill_submit_confirmation',
    'skill_submit_agent_result',
    'skill_restart_from_step',
    'skill_cancel_execution',
  ]) {
    assert.doesNotMatch(
      tableBody,
      new RegExp(`:\\s*['"]${reserved}['"]`),
      `STATIC_TOOL_NAMES must not alias to reserved control-tool name ${reserved}`,
    )
  }
})
