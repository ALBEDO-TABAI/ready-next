import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('skills-tools.ts exposes the tracker-sourced projection builder (B Phase 4 PR1+PR2 shape)', () => {
  // B Phase 4 PR2 retired the legacy workflow-sourced projection helpers
  // (`buildSkillProjectionPatch`, `createSkillExecutionOutput`,
  // `runSkillCoordinator`, `toSkillWaitingFor`, `toSkillInteractionHint`).
  // The tracker-driven replacement introduced in PR1 is the sole projection
  // source for primitive-driven skill work.
  const source = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')

  assert.match(source, /createToolExecutionOutput/)
  // Tracker-sourced projection builder.
  assert.match(source, /export function buildSkillTaskProjectionPatch\(/)
  // Tracker wrapper wires primitive dispatch to todo state transitions.
  assert.match(source, /async function trackPrimitive\b/)
  // Retired functions must be gone.
  assert.doesNotMatch(source, /function buildSkillProjectionPatch\(/)
  assert.doesNotMatch(source, /function createSkillExecutionOutput\(/)
  assert.doesNotMatch(source, /async function runSkillCoordinator\(/)
  assert.doesNotMatch(source, /function toSkillInteractionHint\(/)
  assert.doesNotMatch(source, /function toSkillWaitingFor\(/)
})
