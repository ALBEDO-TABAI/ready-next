import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyFollowupIntent } from '../shared/agent-followup-intent'
import { buildTurnFrameResumableCandidates } from '../main/modules/agent-control/runtime-core/turn-frame-resolver'
import { armDynamicDeliveryDeadline } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-deadline'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { createEmptyActiveFrameContext } from '../main/modules/agent-control/tools-runtime/tool-runtime'
import { getAgentInteractionOpenAITools } from '../main/modules/tools/agent-interaction-tool-defs'

test('natural-language continuation is never code-routed to the newest task', () => {
  const refs = [
    {
      taskId: 'task-a',
      status: 'blocked',
      summary: 'first task',
      continuationCheckpointId: 'checkpoint-a',
      canResume: true,
    },
    {
      taskId: 'task-b',
      status: 'blocked',
      summary: 'second task',
      continuationCheckpointId: 'checkpoint-b',
      canResume: true,
    },
  ]
  assert.equal(classifyFollowupIntent('继续', {
    hasActiveTaskContext: true,
    taskRefs: refs,
  }).kind, 'new_task')
  assert.deepEqual(buildTurnFrameResumableCandidates(refs).map((item) => item.taskId), ['task-a', 'task-b'])
  const resumeTool = getAgentInteractionOpenAITools().find((item) => (
    (item.function as { name?: string } | undefined)?.name === 'resume_task'
  ))
  assert.ok(resumeTool)
  assert.match(JSON.stringify(resumeTool), /ask_user_questions/)
})

test('typed resume accepts only an exact TurnFrame candidate', async () => {
  const calls: Array<Record<string, unknown>> = []
  const runtime = {
    resumeRun: async (input: Record<string, unknown>) => {
      calls.push(input)
      return { success: true }
    },
  }
  const activeFrame = createEmptyActiveFrameContext()
  activeFrame.resumableCandidates = [{
    taskId: 'task-a',
    ownerAgentId: 'butler',
    summary: 'first task',
    blockerCategory: 'provider_failure',
    checkpointId: 'checkpoint-a',
    browserTaskId: 'browser-a',
  }]
  const context = {
    runtime,
    scopeId: 'scope-a',
    activeFrame,
    allowedToolNames: ['resume_task'],
    authorization: { mode: 'none', reason: 'no_skill_signal' },
  } as unknown as Parameters<typeof executeToolCall>[2]

  const stale = await executeToolCall('resume_task', {
    task_id: 'task-a',
    checkpoint_id: 'wrong-checkpoint',
  }, context)
  assert.equal((stale.data as { errorKind?: string }).errorKind, 'stale_resume_candidate')
  assert.equal(calls.length, 0)

  const accepted = await executeToolCall('resume_task', {
    task_id: 'task-a',
    checkpoint_id: 'checkpoint-a',
  }, context)
  assert.equal((accepted.data as { success?: boolean }).success, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.taskId, 'task-a')
})

test('a real wait longer than 120 seconds does not consume the post-answer window', { timeout: 130_000 }, async () => {
  const abortController = new AbortController()
  const runHandle = { abortInitiator: null } as Parameters<typeof armDynamicDeliveryDeadline>[0]['runHandle']
  const deadline = armDynamicDeliveryDeadline({
    mode: 'adaptive',
    runId: 'run-real-long-wait',
    abortController,
    runHandle,
  })
  deadline.suspend('ask-real-long-wait')
  await new Promise((resolve) => setTimeout(resolve, 120_100))
  assert.equal(abortController.signal.aborted, false)
  deadline.resume('ask-real-long-wait')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(abortController.signal.aborted, false)
  deadline.dispose()
})
