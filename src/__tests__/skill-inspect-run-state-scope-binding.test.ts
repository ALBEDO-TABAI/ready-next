import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerDetachedSkillTaskTracker, type DetachedSkillTaskRecord } from '../main/modules/agent-control/detached-skill-task-tracker'
import { executeInspectRunState } from '../main/modules/tools/skill-primitives/inspect-run-state'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('skill-inspect-run-state-scope-binding declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'skill-inspect-run-state-scope-binding transitive sqlite load')
})

function makeOutputDir(prefix: string) {
  const outputDir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify({
    task_id: 'task-a',
    status: 'running',
    current_step: 'collect',
  }), 'utf-8')
  return {
    outputDir,
    runStatePath,
    cleanup: () => rmSync(outputDir, { recursive: true, force: true }),
  }
}

function registerFakeTracker(record: DetachedSkillTaskRecord) {
  registerDetachedSkillTaskTracker({
    inspect: (taskId: string) => taskId === record.id ? record : null,
  } as never)
}

test('skill_inspect_run_state hides detached taskId from another session', async () => {
  const fx = makeOutputDir('skill-inspect-scope-other-')
  try {
    registerFakeTracker({
      id: 'detached-other',
      sessionId: 'session-other',
      scopeId: 'scope-other',
      skillId: 'skill-a',
      action: 'run',
      params: {},
      status: 'running',
      outputDir: fx.outputDir,
      runStatePath: fx.runStatePath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    await assert.rejects(
      executeInspectRunState({
        taskId: 'detached-other',
        scopeBinding: {
          sessionId: 'session-current',
          scopeId: 'scope-current',
          activeRoots: [fx.outputDir],
        },
      }),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'not_found',
    )
  } finally {
    fx.cleanup()
  }
})

test('skill_inspect_run_state allows same-session detached taskId', async () => {
  const fx = makeOutputDir('skill-inspect-scope-same-')
  try {
    registerFakeTracker({
      id: 'detached-current',
      sessionId: 'session-current',
      scopeId: 'scope-current',
      skillId: 'skill-a',
      action: 'run',
      params: {},
      status: 'running',
      outputDir: fx.outputDir,
      runStatePath: fx.runStatePath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const output = await executeInspectRunState({
      taskId: 'detached-current',
      expectedTaskId: 'task-a',
      scopeBinding: {
        sessionId: 'session-current',
        scopeId: 'scope-current',
        activeRoots: [],
      },
    })
    const data = output.data as { found?: boolean; outputDir?: string }
    assert.equal(data.found, true)
    assert.equal(data.outputDir, fx.outputDir)
  } finally {
    fx.cleanup()
  }
})

test('skill_inspect_run_state fails closed when scope binding lacks both sessionId and scopeId', async () => {
  const fx = makeOutputDir('skill-inspect-scope-empty-binding-')
  try {
    registerFakeTracker({
      id: 'detached-current',
      sessionId: 'session-current',
      scopeId: 'scope-current',
      skillId: 'skill-a',
      action: 'run',
      params: {},
      status: 'running',
      outputDir: fx.outputDir,
      runStatePath: fx.runStatePath,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    await assert.rejects(
      executeInspectRunState({
        taskId: 'detached-current',
        scopeBinding: {
          sessionId: null,
          scopeId: null,
          activeRoots: [],
        },
      }),
      (error: unknown) => (error as { errorKind?: string })?.errorKind === 'not_found',
    )
  } finally {
    fx.cleanup()
  }
})

test('skill_inspect_run_state rejects explicit runStatePath outside active roots', async () => {
  const allowed = makeOutputDir('skill-inspect-allowed-')
  const outside = makeOutputDir('skill-inspect-outside-')
  try {
    await assert.rejects(
      executeInspectRunState({
        runStatePath: outside.runStatePath,
        scopeBinding: {
          sessionId: 'session-current',
          scopeId: 'scope-current',
          activeRoots: [allowed.outputDir],
        },
      }),
      (error: unknown) => ['path_escape', 'no_root_match'].includes(String((error as { errorKind?: string })?.errorKind)),
    )
  } finally {
    allowed.cleanup()
    outside.cleanup()
  }
})

test('skill_inspect_run_state allows explicit runStatePath inside active roots', async () => {
  const fx = makeOutputDir('skill-inspect-active-root-')
  try {
    mkdirSync(join(fx.outputDir, 'nested'), { recursive: true })
    const output = await executeInspectRunState({
      runStatePath: fx.runStatePath,
      scopeBinding: {
        sessionId: 'session-current',
        scopeId: 'scope-current',
        activeRoots: [fx.outputDir],
      },
    })
    const data = output.data as { found?: boolean; runStatePath?: string }
    assert.equal(data.found, true)
    assert.equal(data.runStatePath, fx.runStatePath)
  } finally {
    fx.cleanup()
  }
})
