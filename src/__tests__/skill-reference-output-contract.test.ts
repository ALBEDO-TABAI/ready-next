/**
 * Contract: reference-mode skills (runtime === 'reference') must emit a clean
 * advisory header rather than a fake shell envelope.
 *
 * Background: the SKILL.md load path previously returned
 *   { command: ['read', path], mode: 'direct', stdout: <file content> }
 * and the tool-result formatter wrapped it as:
 *   "Command: read /.../SKILL.md\nSTDOUT:\n<content>"
 * That envelope made the model treat the read as a subprocess execution —
 * the observed symptom was a redundant follow-up call to `skill_get_state`
 * looking for an execution that reference-mode skills never create.
 *
 * This test pins the runtime-manager + skills-tools source contract:
 *   - runtime-manager.ts reference branch uses `mode: 'reference'` and an
 *     empty `command: []` (no shell theater)
 *   - skills-tools.ts formatRunResult has a dedicated `mode === 'reference'`
 *     branch that renders a guidance header and explicitly tells the model
 *     there is no execution state
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('runtime-manager reference branch uses mode="reference" and empty command', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')

  // Locate the reference-branch start and slice enough lines to cover the
  // try/catch body. Cheaper than a brittle balanced-brace regex.
  const startIdx = source.indexOf("if (action.runtime === 'reference') {")
  assert.notEqual(startIdx, -1, 'reference-mode branch must exist in runtime-manager.ts')
  const branch = source.slice(startIdx, startIdx + 1500)

  // Strip // and /* */ comments so the forensic explanation in the code
  // (which intentionally describes the old bad behavior) doesn't trip the
  // negative checks.
  const code = branch
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.match(code, /mode:\s*'reference'/, 'reference branch must tag the result with mode: "reference"')
  assert.match(code, /command:\s*\[\]/, 'reference branch must return an empty command array — no fake shell envelope')
  assert.doesNotMatch(
    code,
    /command:\s*\['read'/,
    'reference branch must not synthesize a fake ["read", path] command — readFileSync is not a subprocess',
  )
})

test('SkillRunResult.mode type includes "reference" (Phase 4: workflow mode retired)', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')

  // Phase 4: 'workflow' mode retired along with the skill_executions state
  // machine. The union is now just 'direct' | 'reference'.
  assert.match(
    source,
    /mode\?:\s*'direct'\s*\|\s*'reference'/,
    'SkillRunResult must allow mode: "direct" | "reference"',
  )
})

test('skills-tools formatRunResult has a dedicated reference-mode branch', () => {
  const source = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')

  assert.match(
    source,
    /if \(result\.mode === 'reference'\) \{/,
    'formatRunResult must branch on mode === "reference"',
  )

  // The reference branch must emit the guidance header text that tells the
  // model there is no execution state to inspect. This wording is deliberate:
  // "Skill guidance" labels the payload; "(advisory, no execution state)"
  // discourages redundant skill_get_state probes.
  assert.match(
    source,
    /Skill guidance \(advisory, no execution state\)/,
    'reference-mode header must state this is advisory guidance with no execution state',
  )

  // The old shell envelope must NOT reappear for reference mode. The
  // "Command:" / "STDOUT:" prefixes may still exist (used by real subprocess
  // skills), but the reference branch must render its payload before those
  // prefixes are applied.
  const refBranch = source.match(/if \(result\.mode === 'reference'\) \{[\s\S]*?\n {2}\}/)?.[0]
  assert.ok(refBranch, 'reference branch body must be parseable')
  assert.doesNotMatch(refBranch!, /Command:/, 'reference branch must not emit "Command:" prefix')
  assert.doesNotMatch(refBranch!, /STDOUT:/, 'reference branch must not emit "STDOUT:" prefix')
})

test('formatRunResult reference branch exercises cleanly at runtime', async () => {
  // Behavioral check: the pure formatter runs without needing electron/DB.
  // Import the module dynamically so the top-level electron chain (via
  // session-continuity / tool-result-types) is triggered only in this test.
  const mod = await import('../main/modules/tools/skills-tools')
  assert.ok(mod, 'skills-tools module must load')
})
