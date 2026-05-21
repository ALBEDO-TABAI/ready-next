import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { TurnEngine } from '../main/modules/agent-control/turn-engine'
import { createScopedRunCollector } from '../main/modules/agent-control/task-projection/run-collector'
import type { TurnTerminalReason } from '../main/modules/agent-control/runtime-core/turn-frame'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function assertMatchesAll(
  content: string,
  expectations: Array<{ label: string; pattern: RegExp }>,
): void {
  for (const expectation of expectations) {
    assert.match(content, expectation.pattern, expectation.label)
  }
}

function createContractTurnRequest(userText: string) {
  const events: Array<Record<string, unknown>> = []
  return {
    events,
    request: {
      runId: 'run-contract',
      taskId: 'task-contract',
      agentName: 'agent-contract',
      sessionId: 'scope-contract',
      session: {
        messages: [{ role: 'user', content: userText }],
        abortController: null,
        systemPrompt: 'system',
        generation: 1,
        activeRunId: 'run-contract',
        preferTextToolBridge: false,
        lastDocumentContextInput: null,
      },
      content: userText,
      requestEnvelope: buildRequestEnvelope({ userText }),
      abortSignal: new AbortController().signal,
      ensureNotAborted: () => undefined,
      emitters: {
        emitOutput: (chunk: string, type: string) => {
          events.push({ kind: 'output', chunk, type })
        },
        emitStatus: (status: string, terminalReason?: TurnTerminalReason | null) => {
          events.push({ kind: 'status', status, terminalReason })
        },
        emitRuntimeError: (error: string) => {
          events.push({ kind: 'error', error })
        },
        emitToolAction: (tool: string, args: Record<string, unknown>) => {
          events.push({ kind: 'tool_action', tool, args })
        },
      },
      host: {
        log: () => undefined,
        maxToolIterations: 4,
        browserController: null,
        sidecarManager: null,
        runtime: {
          isChannelTypeAvailable: () => false,
          getConversationScope: () => null,
        },
        requestModuleToolAction: undefined,
        registerRunCleanup: () => undefined,
        providerContext: {
          config: {
            provider: 'openai',
            model: 'gpt-test',
            apiKey: 'test',
            baseUrl: 'https://api.openai.com/v1',
          },
          baseUrl: 'https://api.openai.com/v1',
          provider: undefined,
          isKimi: false,
          isKimiCoding: false,
          useAnthropicProtocol: false,
          supportsToolCalls: false,
          supportsVideoBlock: true,
          hasRawVideoInIncoming: false,
        },
        isBrowserAgentV3Enabled: () => false,
        resolveContinuationProjection: () => null,
        getIncomingAttachmentHints: () => ({ count: 0 }),
        collectRecentPureUserInputs: () => [],
        sessionHasMediaInputs: () => false,
        sessionHasVideoInputs: () => false,
        domainAdapters: [],
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          buildPreferredSkillToolNames: () => null,
          maybeInjectExplicitSkillContext: async () => undefined,
        },
        browserDomainOrchestrator: {
          prepareBrowserExecution: async () => ({
            browserDecision: { mode: 'free_tool_loop', reason: 'browser_disabled' },
            browserContinuityInstruction: null,
            clarifyText: null,
            canUseDeterministicBrowserRunner: false,
            shouldInspectAmbiguousModeEntry: false,
          }),
          resolveExecutionDispatch: () => ({
            kind: 'none',
            continuityInstruction: null,
            responseText: null,
            toolLoopMessage: null,
            fallbackLog: null,
          }),
          runDeterministicExecution: async () => ({
            handled: false,
            state: 'done',
            message: '',
          }),
          createToolLoopState: () => ({ isBrowserTask: false, steps: [], stepIndex: 0 }),
          recordToolLoopProgress: ({ state }: { state: unknown }) => ({
            state,
            advancedStepIndex: null,
            checkpointMessage: null,
          }),
          buildToolLoopLimitMessage: () => null,
          getBudgetHint: () => null,
          getRecommendedToolLoopIterations: (_userText: string, _decision: unknown, base: number) => base,
        },
        documentToolLoopOrchestrator: {
          createState: () => ({}),
          getBudgetHint: () => null,
          handleNoToolCall: ({ state }: { state: unknown }) => ({
            state,
            nextUserMessage: null,
            finalText: null,
            preserveAssistantText: false,
          }),
          applyToolInspection: (state: unknown) => state,
          handleIterationResult: ({ state }: { state: unknown }) => ({
            state,
            nextUserMessage: null,
            completionText: null,
          }),
          buildStructuredTaskPayload: (payload: Record<string, unknown>) => payload,
        },
        designToolLoopOrchestrator: {
          createState: () => ({ primaryArtifactProduced: false }),
          getBudgetHint: () => null,
          filterToolCalls: ({ toolCalls }: { toolCalls: unknown[] }) => ({
            toolCalls,
            droppedCount: 0,
            nextUserMessage: null,
          }),
          applySourceInput: (toolCall: unknown) => toolCall,
          recordToolResult: ({ state }: { state: Record<string, unknown> }) => ({
            state,
            isPrimaryArtifact: false,
          }),
          buildCompletionText: () => null,
          buildStructuredTaskPayload: (payload: Record<string, unknown>) => payload,
        },
        hostCapabilityDispatcher: {
          dispatch: async () => ({ handled: false }),
        },
        executeToolCall: async () => ({ text: 'ok' }),
        requestSimpleText: async () => ({ text: 'simple result' }),
        requestToolLoopResponse: async () => ({
          text: 'tool loop result',
          toolCalls: [],
          stopReason: 'stop',
        }),
        executeToolBatch: async () => ({
          results: [],
          budgetLimited: false,
          recoveryHistory: [],
        }),
      },
    } as any,
  }
}

test('phase3 shrinks DirectChatEngine.sendMessage into a TurnEngine host-shell entrypoint', () => {
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  assertMatchesAll(directChat, [
    {
      label: 'sendMessage should remain the single public turn entrypoint',
      pattern: /async sendMessage\(/,
    },
    {
      label: 'direct chat should keep the turn engine as a host-owned collaborator',
      pattern: /private readonly turnEngine: TurnEngine/,
    },
    {
      label: 'sendMessage should delegate the main turn execution to TurnEngine',
      pattern: /return await this\.turnEngine\.execute\(/,
    },
    {
      label: 'sendMessage should still own abort-controller wiring',
      pattern: /const abortController = new AbortController\(/,
    },
    {
      label: 'sendMessage should still emit working status before delegating',
      pattern: /emitStatus\('working'\)/,
    },
    {
      label: 'sendMessage should still normalize incoming multimodal messages into session history',
      pattern: /session\.messages\.push\(\{ role: 'user', content: blocks \}\)/,
    },
  ])

  assertMatchesAll(turnEngine, [
    {
      label: 'turn engine should now own execution intent resolution',
      pattern: /resolveExecutionIntentContext\(/,
    },
    {
      label: 'turn engine should now own route resolution',
      pattern: /resolveTaskExecutionRoute\(/,
    },
    {
      label: 'turn engine should now own domain prepare dispatch',
      pattern: /const selectedDomainPrepareResult: DomainAdapterPrepareResult/,
    },
    {
      label: 'turn engine should now own host shortcuts',
      pattern: /hostCapabilityDispatcher\.dispatch\(/,
    },
    {
      label: 'turn engine should now own tool-loop model requests',
      pattern: /requestToolLoopResponse\(/,
    },
    {
      label: 'turn engine should now own batched tool execution',
      pattern: /executeToolBatch\(/,
    },
  ])
})

test('scoped run collector preserves terminalReason from terminal status events', async () => {
  const collector = createScopedRunCollector({
    agent: 'agent-contract',
    sessionId: 'scope-contract',
    requestId: 'run-contract',
  })

  collector.handleOutput({
    agent: 'agent-contract',
    sessionId: 'scope-contract',
    runId: 'run-contract',
    chunk: 'partial',
    type: 'text',
  })
  collector.handleStatus({
    agent: 'agent-contract',
    sessionId: 'scope-contract',
    runId: 'run-contract',
    status: 'checkpoint',
    terminalReason: 'checkpoint_background',
  })

  const result = await collector.result
  assert.equal(result.success, true)
  assert.equal(result.finalText, 'partial')
  assert.equal(result.terminalReason, 'checkpoint_background')
})

test('phase0 freezes the future TurnEngine contract in roadmap and design docs', () => {
  const roadmap = readWorkspaceFile('docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md')
  const design = readWorkspaceFile('docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md')
  const gapAnalysis = readWorkspaceFile('docs/superpowers/specs/2026-04-17-claude-code-vs-ready-agent-gap-analysis.md')

  assertMatchesAll(roadmap, [
    {
      label: 'roadmap should freeze the extraction of sendMessage into TurnEngine',
      pattern: /把当前 `DirectChatEngine\.sendMessage\(\)` 中的单轮执行主链抽到 `TurnEngine`/,
    },
    {
      label: 'roadmap should freeze DirectChatEngine as a provider-facing host shell',
      pattern: /`DirectChatEngine` 缩为 provider-facing host shell/,
    },
    {
      label: 'roadmap should freeze TurnState fields before implementation lands',
      pattern: /`route \/ budget \/ toolPool \/ transcript \/ interaction \/ continuation \/ domainState`/,
    },
    {
      label: 'roadmap should freeze the need for a strict TurnEngine input and output contract',
      pattern: /明确 `TurnEngine` 的输入输出合同/,
    },
  ])

  assertMatchesAll(design, [
    {
      label: 'design should freeze TurnEngine as the new owner',
      pattern: /这一层是整个整改最核心的新 owner/,
    },
    {
      label: 'design should freeze TurnEngine as the single source of truth for one turn',
      pattern: /单轮执行唯一真相来源/,
    },
    {
      label: 'design should freeze the turn-level state that TurnEngine owns',
      pattern: /本轮消息、预算、route、tool results、interaction state 的统一宿主/,
    },
    {
      label: 'design should freeze the PreparedRunPayload input, ToolRuntime handoff, and ExecutionTurnResult output',
      pattern: /接收 `PreparedRunPayload`[\s\S]*调 `ToolRuntime`[\s\S]*产出结构化 `ExecutionTurnResult`/,
    },
    {
      label: 'design should freeze TurnEngine as the single main loop',
      pattern: /它相当于 Ready 版的“单一主循环”/,
    },
    {
      label: 'design should freeze the target execution chain around TurnEngine',
      pattern: /`Renderer \/ Channel \/ Cron -> AgentRuntimeFacade -> TurnEngine -> ToolRuntime \/ DomainAdapter -> Transcript \+ Projection`/,
    },
  ])

  assertMatchesAll(gapAnalysis, [
    {
      label: 'gap analysis should freeze DirectChatEngine as the current super host',
      pattern: /`DirectChatEngine` 仍然是超级宿主/,
    },
    {
      label: 'gap analysis should freeze TurnEngine as the future execution truth owner',
      pattern: /新的 `TurnEngine` 成为唯一 execution truth owner/,
    },
    {
      label: 'gap analysis should freeze DirectChatEngine as a provider client and host adapter',
      pattern: /`DirectChatEngine` 缩成 provider client \+ host adapter/,
    },
  ])
})

test('phase3 routes single-turn execution through TurnEngine and shrinks DirectChatEngine into a host shell', () => {
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const turnState = readWorkspaceFile('src/main/modules/agent-control/turn-state.ts')
  const turnTranscript = readWorkspaceFile('src/main/modules/agent-control/turn-transcript.ts')
  const contracts = readWorkspaceFile('src/main/modules/agent-control/run-contracts.ts')

  assertMatchesAll(contracts, [
    {
      label: 'run contracts should define the TurnEngine request contract',
      pattern: /export interface TurnEngineRequest/,
    },
    {
      label: 'run contracts should define the structured ExecutionTurnResult contract',
      pattern: /export interface ExecutionTurnResult/,
    },
    {
      label: 'run contracts should define transcript events for a single turn',
      pattern: /export interface TurnTranscriptEvent/,
    },
  ])

  assertMatchesAll(turnState, [
    {
      label: 'turn state should centralize turn-level runtime truth',
      pattern: /export class TurnState/,
    },
    {
      label: 'turn state should own execution diagnostics construction',
      pattern: /buildExecutionDiagnostics\(/,
    },
    {
      label: 'turn state should own the final turn result assembly',
      pattern: /buildResult\(/,
    },
  ])

  assertMatchesAll(turnTranscript, [
    {
      label: 'turn transcript should centralize event collection for one turn',
      pattern: /export class TurnTranscript/,
    },
    {
      label: 'turn transcript should emit structured payloads through tool_result events',
      pattern: /emitStructuredPayload\(/,
    },
    {
      label: 'turn transcript should expose final text aggregation',
      pattern: /getFinalText\(/,
    },
  ])

  assertMatchesAll(turnEngine, [
    {
      label: 'turn engine should be the new single-turn execution owner',
      pattern: /export class TurnEngine/,
    },
    {
      label: 'turn engine should expose one execute entrypoint',
      pattern: /async execute(?:<|\()/,
    },
    {
      label: 'turn engine should create turn state',
      pattern: /new TurnState\(/,
    },
    {
      label: 'turn engine should create turn transcript',
      pattern: /new TurnTranscript\(/,
    },
    {
      label: 'turn engine should resolve execution intent and route inside execute',
      pattern: /resolveExecutionIntentContext\(/,
    },
    {
      label: 'turn engine should resolve task execution routes inside execute',
      pattern: /resolveTaskExecutionRoute\(/,
    },
    {
      label: 'turn engine should own the tool loop request path',
      pattern: /requestToolLoopResponse\(/,
    },
    {
      label: 'turn engine should own tool batch execution',
      pattern: /executeToolBatch\(/,
    },
  ])

  assertMatchesAll(directChat, [
    {
      label: 'direct chat should import turn engine',
      pattern: /import \{ TurnEngine \} from '\.\.\/agent-control\/turn-engine'/,
    },
    {
      label: 'direct chat should keep a turn engine instance',
      pattern: /private readonly turnEngine: TurnEngine/,
    },
    {
      label: 'sendMessage should delegate the main turn execution to TurnEngine',
      pattern: /return await this\.turnEngine\.execute\(/,
    },
  ])

  assert.doesNotMatch(directChat, /const executionIntentContext = resolveExecutionIntentContext\(/)
  assert.doesNotMatch(directChat, /const initialTaskExecutionRoute = resolveTaskExecutionRoute\(/)
})

test('phase0 keeps a minimal executable TurnEngine contract in addition to source-level regex checks', async () => {
  const engine = new TurnEngine()
  const { request, events } = createContractTurnRequest('解释一下 ready agent runtime')

  const result = await engine.execute(request)

  assert.equal(result.success, true)
  assert.equal(result.finalText, 'simple result')
  assert.equal(result.interactionState, 'running')
  assert.ok(result.projectionTruth)
  assert.ok(Array.isArray(result.projectionTruth?.transcriptEvents))
  assert.ok(events.some((event) => event.kind === 'output'))
})
