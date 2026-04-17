import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserDomainAdapter } from '../main/modules/agent-control/browser-domain-adapter'
import { DocumentDomainAdapter } from '../main/modules/agent-control/document-domain-adapter'
import { SkillDomainAdapter } from '../main/modules/agent-control/skill-domain-adapter'
import { RSSDomainAdapter } from '../main/modules/agent-control/rss-domain-adapter'
import { CalendarDomainAdapter } from '../main/modules/agent-control/calendar-domain-adapter'
import { FeishuDomainAdapter } from '../main/modules/agent-control/feishu-domain-adapter'
import { selectDomainAdapter, type DomainAdapter } from '../main/modules/agent-control/domain-adapter'

function createRoute(executor: 'browser' | 'document' | 'skill' | 'rss' | 'calendar' | 'feishu') {
  return {
    taskId: 'task-1',
    taskType: 'short_task' as const,
    chain: executor === 'browser' || executor === 'document' || executor === 'skill' ? 'domain_executor' as const : 'tool_loop' as const,
    executor,
    steps: [],
    continuation: null,
  }
}

test('every phase4 domain adapter implements the unified lifecycle contract', () => {
  const adapters: DomainAdapter[] = [
    new BrowserDomainAdapter({} as never),
    new DocumentDomainAdapter({
      orchestrator: {} as never,
      toolLoopOrchestrator: {} as never,
    }),
    new SkillDomainAdapter(),
    new RSSDomainAdapter(),
    new CalendarDomainAdapter(),
    new FeishuDomainAdapter(),
  ]

  for (const adapter of adapters) {
    assert.equal(typeof adapter.shouldHandle, 'function')
    assert.equal(typeof adapter.prepare, 'function')
    assert.equal(typeof adapter.dispatch, 'function')
    assert.equal(typeof adapter.applyResult, 'function')
    assert.equal(typeof adapter.buildProjectionPatch, 'function')
  }
})

test('domain adapter selector picks the matching adapter for the resolved executor', () => {
  const adapters: DomainAdapter[] = [
    new SkillDomainAdapter(),
    new RSSDomainAdapter(),
    new CalendarDomainAdapter(),
    new FeishuDomainAdapter(),
  ]

  const selected = selectDomainAdapter(adapters, {
    route: createRoute('calendar'),
    userText: '安排今天下午的日程',
    hasTools: true,
    executionIntentContext: {} as never,
  })

  assert.equal(selected?.id, 'calendar')
})

test('browser domain adapter preserves upload prompt refinement before building browser state', async () => {
  const adapter = new BrowserDomainAdapter({
    async prepareBrowserExecution(params: Record<string, unknown>) {
      return {
        browserDecision: (params.decision as { mode: string; promptIntent?: { refined?: string } } | undefined) || {
          mode: 'browser_upload_workflow',
          promptIntent: { refined: '初始提示词' },
        },
        browserContinuity: null,
        browserContinuityInstruction: null,
        clarifyText: null,
        shouldInspectAmbiguousModeEntry: false,
        canUseDeterministicBrowserRunner: false,
      }
    },
    async refineUploadDecision(params: {
      decision: { mode: string; promptIntent?: { refined?: string } }
      requestPromptDraft: (planningPrompt: string) => Promise<string>
    }) {
      const draft = await params.requestPromptDraft('请补全提示词')
      return {
        ...params.decision,
        promptIntent: {
          refined: draft,
        },
      }
    },
    resolveExecutionDispatch() {
      return {
        kind: 'none' as const,
        continuityInstruction: null,
        responseText: null,
        toolLoopMessage: null,
        fallbackLog: null,
      }
    },
    async runDeterministicExecution() {
      return { handled: false, state: 'done' as const, message: '' }
    },
    createToolLoopState(decision: unknown) {
      return {
        isBrowserTask: true,
        steps: [],
        stepIndex: 0,
        browserToolCallCount: Number((decision as { promptIntent?: { refined?: string } }).promptIntent?.refined === '更具体的提示词'),
      }
    },
    recordToolLoopProgress() {
      return {
        state: { isBrowserTask: true, steps: [], stepIndex: 0, browserToolCallCount: 0 },
        advancedStepIndex: null,
        checkpointMessage: null,
      }
    },
    buildToolLoopLimitMessage() {
      return null
    },
    getBudgetHint() {
      return null
    },
  } as never)

  const result = await adapter.prepare({
    route: createRoute('browser'),
    request: {
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
    } as never,
    host: {
      browserController: {} as never,
      providerContext: {} as never,
      skillContextOrchestrator: {
        findExplicitlyRequestedSkills: () => [],
      },
      isBrowserAgentV3Enabled: () => true,
      requestSimpleText: async () => ({ text: '更具体的提示词' }),
      log: () => undefined,
    } as never,
    session: {
      messages: [],
    } as never,
    userText: '上传图片并生成',
    pureUserInput: '上传图片并生成',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['browser_open'],
  })

  assert.equal(
    (result.domainState as { preparedBrowserExecution: { browserDecision: { promptIntent?: { refined?: string } } } })
      .preparedBrowserExecution.browserDecision.promptIntent?.refined,
    '更具体的提示词',
  )
})
