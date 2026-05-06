import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('skills-tools.ts exposes the tracker-sourced projection builder (B Phase 4 PR1+PR2 shape)', () => {
  // B Phase 4 PR2 retired the legacy workflow-sourced projection helpers
  // (`createSkillExecutionOutput`, `runSkillCoordinator`,
  // `toSkillWaitingFor`, `toSkillInteractionHint`). The tracker-driven
  // projection builder remains under its original name
  // (`buildSkillProjectionPatch`) but its body now sources state from the
  // `SkillTaskTracker` rather than the retired workflow coordinator —
  // pin the body shape rather than the function name to assert the
  // tracker-driven contract.
  const source = readWorkspaceFile('src/main/modules/tools/skills-tools.ts')

  assert.match(source, /createToolExecutionOutput/)
  // Tracker-sourced projection builder body — the function name was kept
  // (`buildSkillProjectionPatch`) but the body now reads tracker state.
  assert.match(source, /function buildSkillProjectionPatch\(/)
  // skills-tools wires the projection builder to the SkillTaskTracker via
  // the projection helpers (`readSkillTaskProjection`, `isSkillTaskProjectionLive`,
  // `recordSkillTaskEvent`) imported from `agent-control/skill-task-tracker`.
  // Pin one of those imports so a regression that re-introduces a workflow
  // coordinator path still trips here.
  assert.match(source, /from\s+['"][^'"]*skill-task-tracker['"]/)
  assert.match(source, /readSkillTaskProjection|recordSkillTaskEvent/)
  // Primitive dispatch records tracker state inline via recordSkillTaskEvent
  // calls (the original `trackPrimitive` wrapper was removed; the calls are
  // now expressed at each emission site).
  assert.match(source, /recordSkillTaskEvent\(\{/)
  // Retired workflow-coordinator helpers must be gone.
  assert.doesNotMatch(source, /function createSkillExecutionOutput\(/)
  assert.doesNotMatch(source, /async function runSkillCoordinator\(/)
  assert.doesNotMatch(source, /function toSkillInteractionHint\(/)
  assert.doesNotMatch(source, /function toSkillWaitingFor\(/)
})
