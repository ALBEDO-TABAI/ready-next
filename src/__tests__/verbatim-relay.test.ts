import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { buildChildRunPayload } from '../main/modules/repositories/skill-task-run-repository'
import { createSkillChildSubAgentFromPersisted } from '../main/modules/agent-control/skills/skill-child-sub-agent-factory'
import type { SkillChildLaunchParams } from '../main/modules/agent-control/skills/skill-child-run-types'

const repoRoot = resolve(import.meta.dirname, '../..')
const VERBATIM = '  帮我盯三个平台行情📈，明早九点前出对比！！\n（小红书优先）  '

test('retired handoff relay cannot return to the live Codex graph', () => {
  assert.equal(
    existsSync(resolve(repoRoot, 'src/main/modules/agent-control/agents/handoff-proposal.ts')),
    false,
  )
  const liveComposition = readFileSync(resolve(
    repoRoot,
    'src/main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts',
  ), 'utf8')
  assert.doesNotMatch(liveComposition, /runHandoffProposal|HANDOFF_NEW_SESSION_OPTION/)
})

test('skill child artifact handoff still preserves the user text exactly', async () => {
  const payload = buildChildRunPayload({
    childRunId: 'sk-child-1',
    scopeId: 's1',
    sessionId: 'sess1',
    skillId: 'skill-x',
    skillName: null,
    action: 'run',
    requestedInput: { topic: 'x' },
    singleFlightKey: 'k',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
    eventLogPath: '/tmp/out/events.jsonl',
    status: 'running',
    userRequestVerbatim: VERBATIM,
  })
  assert.equal(payload.userRequestVerbatim, VERBATIM)

  let capturedLaunch: SkillChildLaunchParams | null = null
  await createSkillChildSubAgentFromPersisted({
    payload,
    driver: {
      canResume: () => true,
      createInitialState: async (launch: SkillChildLaunchParams) => {
        capturedLaunch = launch
        return {} as never
      },
    } as never,
    executeAction: (() => { throw new Error('not executed') }) as never,
  })
  assert.equal(capturedLaunch!.userRequestVerbatim, VERBATIM)
})

test('missing historical text stays null instead of synthesizing a relay message', () => {
  const payload = buildChildRunPayload({
    childRunId: 'sk-legacy',
    scopeId: null,
    sessionId: null,
    skillId: 's',
    skillName: null,
    action: 'run',
    requestedInput: {},
    singleFlightKey: 'k2',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/o',
    runStatePath: '/tmp/o/r.json',
    eventLogPath: '/tmp/o/e.jsonl',
  })
  assert.equal(payload.userRequestVerbatim, null)
})
