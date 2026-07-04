/**
 * Source-level lock confirming the `skill_executions` state machine +
 * its IPC / preload bindings are retired (B Phase 4 PR3).
 *
 * If a future change reintroduces any of these symbols — whether by
 * accident or for a deliberate revert — this test fires before the
 * behavioral regression surfaces in production.
 *
 * The DB tables + migration 028 TTL index are dropped in PR4; those are
 * locked separately by `migrations-drop-skill-executions.test.ts`.
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function workspaceFileExists(path: string): boolean {
  return existsSync(resolve(process.cwd(), path))
}

test('3 state-machine modules are deleted from skills-runtime/', () => {
  assert.equal(
    workspaceFileExists('src/main/modules/skills-runtime/execution-coordinator.ts'),
    false,
    'execution-coordinator.ts should be deleted',
  )
  assert.equal(
    workspaceFileExists('src/main/modules/skills-runtime/execution-state-store.ts'),
    false,
    'execution-state-store.ts should be deleted',
  )
  assert.equal(
    workspaceFileExists('src/main/modules/skills-runtime/next-action-resolver.ts'),
    false,
    'next-action-resolver.ts should be deleted',
  )
})

test('SkillsRuntimeManager class body does not declare the 7 retired execution methods', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager.ts')
  // Each of these was a public method on SkillsRuntimeManager. Match the
  // method-declaration signature (name followed by `(` and not inside a
  // comment — a simple substring check is sufficient since the file is
  // small and the comments referencing these names live in dedicated
  // "retired" comment blocks that never appear with the `(` suffix.
  for (const methodName of [
    'submitExecutionInput',
    'submitExecutionConfirmation',
    'submitExecutionAgentResult',
    'restartExecutionFromStep',
    'cancelExecution',
    'getExecution',
    'listExecutions',
  ]) {
    const declarationPattern = new RegExp(`^\\s{2,}(?:async\\s+)?${methodName}\\s*\\(`, 'm')
    assert.doesNotMatch(
      source,
      declarationPattern,
      `${methodName} should no longer be declared on SkillsRuntimeManager`,
    )
  }
})

test('main-side IPC handlers for skills:executions:* are deleted', () => {
  const source = readWorkspaceFile('src/main/modules/skills-runtime/ipc-handler.ts')
  assert.doesNotMatch(
    source,
    /ipcMain\.handle\(['"]skills:executions:/,
    'no ipcMain.handle(\'skills:executions:*\', …) should remain',
  )
})

test('preload bindings for skills.executions.* are deleted', () => {
  const source = readWorkspaceFile('src/preload/index.ts')
  assert.doesNotMatch(
    source,
    /ipcRenderer\.invoke\(['"]skills:executions:/,
    'no ipcRenderer.invoke(\'skills:executions:*\', …) should remain',
  )
  // The skillsAPI object should not declare method names that map to the
  // retired IPC surface.
  for (const methodName of [
    'listExecutions',
    'getExecution',
    'submitInput',
    'submitConfirmation',
    'submitAgentResult',
    'restartFromStep',
    'cancelExecution',
  ]) {
    const pattern = new RegExp(`^\\s+${methodName}\\s*:`, 'm')
    assert.doesNotMatch(
      source,
      pattern,
      `skillsAPI.${methodName} should no longer be declared in preload`,
    )
  }
})

test('renderer ElectronSkillsAPI interface drops the 7 execution methods', () => {
  const source = readWorkspaceFile('src/renderer/types/electron.d.ts')
  // ElectronSkillsAPI is scoped; we can scan the whole file since these
  // method names were unique to that interface.
  for (const methodName of [
    'listExecutions',
    'getExecution',
    'submitInput',
    'submitConfirmation',
    'submitAgentResult',
    'restartFromStep',
    'cancelExecution',
  ]) {
    const pattern = new RegExp(`^\\s+${methodName}\\s*:`, 'm')
    assert.doesNotMatch(
      source,
      pattern,
      `ElectronSkillsAPI.${methodName} should no longer be declared`,
    )
  }
})

test('shared skill-execution-types drops the workflow-only types', () => {
  const source = readWorkspaceFile('src/shared/skill-execution-types.ts')
  // These were exclusively consumed by the retired state machine +
  // renderer task-card shim. `SkillDefinition` / `SkillParamDefinition` /
  // `SkillActionDefinition` / etc MUST still exist (manifest + primitive
  // param schemas depend on them). If any of the retired names come back
  // without a concrete consumer, the type surface grows without purpose.
  for (const typeName of [
    'SkillExecutionDetail',
    'SkillExecutionState',
    'SkillExecutionStepRecord',
    'SkillExecutionError',
    'ExecutionBlocker',
    'ExecutionFrame',
  ]) {
    const pattern = new RegExp(`export\\s+interface\\s+${typeName}\\b`)
    assert.doesNotMatch(
      source,
      pattern,
      `${typeName} should no longer be exported from skill-execution-types.ts`,
    )
  }
})

test('SkillRunResult no longer exposes the workflow mode / execution / blocker fields', () => {
  // B8-P（2026-07-05）：SkillRunResult 类型声明随顶层纯块迁至
  // runtime-manager-types.ts，钉点跟随（不变量不变：禁 workflow/execution/blocker 字段）。
  const main = readWorkspaceFile('src/main/modules/skills-runtime/runtime-manager-types.ts')
  const renderer = readWorkspaceFile('src/renderer/types/electron.d.ts')

  // Strip `// …` comments before assertions so documentation of the
  // retirement ("`mode: 'workflow'` retired") doesn't trip the regex.
  function stripLineComments(block: string): string {
    return block
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
  }

  const mainResultBlock = main.match(/export interface SkillRunResult \{[\s\S]*?\n\}/)
  assert.ok(mainResultBlock, 'SkillRunResult declaration must be present in runtime-manager-types.ts')
  const mainStripped = stripLineComments(mainResultBlock![0])
  assert.doesNotMatch(mainStripped, /'workflow'/)
  assert.doesNotMatch(mainStripped, /\bexecution\?:\s*SkillExecutionDetail/)
  assert.doesNotMatch(mainStripped, /^\s*blocker\?:/m)

  const rendererResultBlock = renderer.match(/interface SkillRunResult \{[\s\S]*?\n\}/)
  assert.ok(rendererResultBlock, 'SkillRunResult declaration must be present in electron.d.ts')
  const rendererStripped = stripLineComments(rendererResultBlock![0])
  assert.doesNotMatch(rendererStripped, /'workflow'/)
  assert.doesNotMatch(rendererStripped, /\bexecution\?:/)
  assert.doesNotMatch(rendererStripped, /^\s*blocker\?:/m)
})
