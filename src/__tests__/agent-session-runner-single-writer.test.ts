import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Agent,
  MemorySession,
  Runner,
  Usage,
  type AgentInputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from '@openai/agents'

import { AgentSessionInputController } from '../main/modules/agent-control/runtime-core/agent-session-input-controller'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { workflowDigest } from '../main/modules/repositories/agent-session-checkpoint-repository'

const item = (role: 'user' | 'system', content: string): AgentInputItem => ({ role, content }) as AgentInputItem

function deterministicProvider(requests: string[] = []): ModelProvider {
  let response = 0
  const model: Model = {
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
      requests.push(JSON.stringify(_request.input))
      response += 1
      return {
        usage: new Usage(),
        output: [{
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: `answer-${response}` }],
        } as never],
        responseId: `response-${response}`,
      }
    },
    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      const completed = await this.getResponse(request)
      yield { type: 'response_done', response: completed } as never
    },
  }
  return { getModel: () => model }
}

function controller(initial: AgentInputItem[]): AgentSessionInputController {
  const preparedSkill = { requestOrResourceAnchorDigest: 'request-digest' }
  let record = {
    finalInput: structuredClone(initial) as AgentInputItem[],
    finalInputDigest: workflowDigest(initial),
    sdkSourceItemCount: initial.length,
    sdkSourcePrefixDigest: workflowDigest(initial),
    preparedSkill,
    lastEffectiveBrowserActionSeq: 0,
    requiredOperationIds: [],
  }
  const repository = {
    current: () => record,
    hasPendingSteering: () => false,
    writeCleanBoundary: async (input: {
      sourceItems: AgentInputItem[]
      sdkSourceItems: AgentInputItem[]
      sdkSourceItemCount: number
      sdkSourcePrefixDigest: string
    }) => {
      record = {
        ...record,
        finalInput: structuredClone(input.sourceItems) as AgentInputItem[],
        finalInputDigest: workflowDigest(input.sourceItems),
        sdkSourceItemCount: input.sdkSourceItemCount,
        sdkSourcePrefixDigest: input.sdkSourcePrefixDigest,
      }
      return record
    },
  } as never
  return new AgentSessionInputController(repository, {
    taskId: 'task-single-writer',
    runId: 'run-single-writer',
    activatedCapabilityGroups: ['browser'],
    browserWorkflowRoute: { browserTaskId: 'browser-single-writer', requestAnchorSnapshotDigest: 'digest' },
    browserObservationGaps: [],
    browserSuspensionRequest: null,
    confirmedBrowserPowerRequestConsumed: true,
    confirmedBrowserPermissionRequestConsumed: false,
    preparedSkillTurn: preparedSkill,
    lastEffectiveBrowserActionSeq: 0,
    browserRequiredOperationIds: [],
  } as never, null)
}

test('real Runner persists filtered input once instead of duplicating the whole turn', async () => {
  const base = item('user', 'base request')
  const oneShot = {
    role: 'system',
    content: 'confirmed fact consumed before provider',
    providerData: { readyBrowserPowerConfirmation: { version: 1, decision: 'confirmed' } },
  } as unknown as AgentInputItem
  const staleObservation = {
    role: 'system',
    content: 'stale observation gap fact',
    providerData: { readyBrowserObservationFact: { actionSeq: 1 } },
  } as unknown as AgentInputItem
  const session = new MemorySession({ initialItems: [base, oneShot, staleObservation] })
  const inputController = controller([base, oneShot, staleObservation])
  const requests: string[] = []
  const runner = new Runner({ modelProvider: deterministicProvider(requests), tracingDisabled: true })
  const agent = new Agent({ name: 'single-writer', instructions: 'answer', model: 'deterministic' })
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))

  try {
    for (const content of ['first turn', 'second turn']) {
      await inputController.prepareRunnerSession(session)
      await runner.run(agent, content, {
        session,
        callModelInputFilter: async ({ modelData }) => ({
          ...modelData,
          input: await inputController.filter(
            modelData.input,
            { sourceItems: modelData.input, compacted: false },
          ),
        }),
      })
    }
  } finally {
    __setMetricSinkForTests(null)
  }

  const serialized = JSON.stringify(await session.getItems())
  assert.equal(serialized.match(/first turn/g)?.length, 1)
  assert.equal(serialized.match(/second turn/g)?.length, 1)
  assert.doesNotMatch(serialized, /confirmed fact consumed before provider/)
  assert.doesNotMatch(serialized, /stale observation gap fact/)
  assert.equal(metrics.some((event) => event.metric === 'owner_local_runner_session_rebased'), false, JSON.stringify(metrics))
  assert.equal(metrics.some((event) => event.metric === 'owner_local_session_source_cursor_mismatch'), false, JSON.stringify(metrics))
  assert.match(requests[1] || '', /answer-1/, JSON.stringify(requests))
  assert.equal(serialized.match(/answer-1/g)?.length, 1)
  assert.equal(serialized.match(/answer-2/g)?.length, 1)
})
