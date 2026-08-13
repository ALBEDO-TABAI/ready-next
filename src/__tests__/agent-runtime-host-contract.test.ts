import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

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

test('runtime host keeps projection contracts while the production sender is Codex-native', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const orchestrator = readWorkspaceFile('src/main/modules/agent-control/runtime-core/orchestrator.ts')
  const runCoordinator = readWorkspaceFile('src/main/modules/agent-control/task-projection/run-coordinator.ts')
  const runProjection = readWorkspaceFile('src/main/modules/agent-control/task-projection/run-projection.ts')
  const contracts = readWorkspaceFile('src/main/modules/agent-control/contracts/run-contracts.ts')
  const domainAdapter = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/domain-adapter.ts')
  const designToolLoopOrchestrator = readWorkspaceFile('src/main/modules/agent-control/design-tool-loop-orchestrator.ts')
  const documentToolLoopOrchestrator = readWorkspaceFile('src/main/modules/document-engine/pipeline/document-tool-loop-orchestrator.ts')
  const documentDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/document-domain-adapter.ts')
  const documentDomainOrchestrator = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/document-domain-orchestrator.ts')
  const documentDomainHelpers = readWorkspaceFile('src/main/modules/agent-control/document-domain-helpers.ts')
  const executionIntentResolver = readWorkspaceFile('src/main/modules/agent-control/execution-intent-resolver.ts')
  const runCapabilityController = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/run-capability-controller.ts')
  const providerRuntimeResolver = readWorkspaceFile('src/main/modules/agent-control/provider-runtime-resolver.ts')
  const skillContextOrchestrator = readWorkspaceFile('src/main/modules/agent-control/skills/skill-context-orchestrator.ts')
  const skillDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/skills/skill-domain-adapter.ts')
  const rssDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/rss-domain-adapter.ts')
  const calendarDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/calendar-domain-adapter.ts')
  const feishuDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/feishu-domain-adapter.ts')
  const toolRuntimeContextBuilder = readWorkspaceFile('src/main/modules/agent-control/tools-runtime/tool-runtime-context-builder.ts')
  const videoFallbackService = readWorkspaceFile('src/main/modules/claude-bridge/video-fallback-service.ts')
  const anthropicExecutionClient = readWorkspaceFile('src/main/modules/claude-bridge/anthropic-execution-client.ts')
  const kimiCodingClient = readWorkspaceFile('src/main/modules/claude-bridge/kimi-coding-client.ts')
  const openAIExecutionClient = readWorkspaceFile('src/main/modules/claude-bridge/openai-execution-client.ts')
  const documentToolFlow = readWorkspaceFile('src/main/modules/claude-bridge/document-tool-flow.ts')
  // 合同随实现同步（Phase C C4/C5，2026-07-05）：DirectChatEngine 退役，
  // provider/编排器装配壳锚点移至 domain-adapter-host.ts；工具上下文构造的
  // live 消费点移至 agent-sdk-tool-executor.ts。
  const host = readWorkspaceFile('src/main/modules/agent-control/domain-adapters/domain-adapter-host.ts')
  const sdkToolExecutor = readWorkspaceFile('src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts')
  const toolConfig = readWorkspaceFile('src/main/modules/agent-control/tool-policy/execution-tool-config.ts')
  const toolPolicy = readWorkspaceFile('src/main/modules/agent-control/tool-policy/execution-tool-policy.ts')

  assert.match(contracts, /export interface RunCoordinatorRequest/)
  assert.match(contracts, /export interface RunCoordinatorResult/)
  assert.match(contracts, /export interface ExecutionHostRequest/)
  assert.match(contracts, /export interface ExecutionHostResult/)
  assert.match(contracts, /export interface ToolVisibilityPlan/)
  assert.match(contracts, /export interface ToolDispatchDecision/)
  assert.match(contracts, /export interface RunProjectionPatch/)
  assert.match(contracts, /export interface DomainOrchestrationDecision/)

  assert.match(runCoordinator, /export class RunCoordinator/)
  assert.match(runCoordinator, /async runScoped\(/)
  assert.doesNotMatch(runCoordinator, /runInboundChannel/)
  assert.doesNotMatch(runCoordinator, /promptAssembly|executeAndCollect|runtimeKernel|ready-agent-sdk-retired/)

  assert.match(runProjection, /export class RunProjection/)
  assert.match(runProjection, /recordEvent\(/)
  assert.doesNotMatch(runProjection, /deriveTaskSummaryPatch\(/)
  assert.match(domainAdapter, /export interface DomainAdapter/)
  assert.match(domainAdapter, /executedTools\?: Array</)
  assert.match(domainAdapter, /export function readToolProjectionPatch\(/)
  assert.match(domainAdapter, /export function readStructuredToolResultRecord\(/)
  assert.match(domainAdapter, /export function selectDomainAdapter\(/)
  assert.match(designToolLoopOrchestrator, /export class DesignToolLoopOrchestrator/)
  assert.match(designToolLoopOrchestrator, /applySourceInput\(/)
  assert.match(designToolLoopOrchestrator, /filterToolCalls\(/)
  assert.match(designToolLoopOrchestrator, /recordToolResult\(/)
  assert.match(designToolLoopOrchestrator, /buildCompletionText\(/)
  assert.match(designToolLoopOrchestrator, /buildStructuredTaskPayload\(/)
  assert.match(documentToolLoopOrchestrator, /export class DocumentToolLoopOrchestrator/)
  assert.match(documentToolLoopOrchestrator, /createState\(/)
  assert.match(documentToolLoopOrchestrator, /applyToolInspection\(/)
  assert.match(documentToolLoopOrchestrator, /handleNoToolCall\(/)
  assert.match(documentToolLoopOrchestrator, /handleIterationResult\(/)
  assert.match(documentToolLoopOrchestrator, /buildStructuredTaskPayload\(/)
  assert.match(documentDomainAdapter, /export class DocumentDomainAdapter/)
  assert.match(documentDomainOrchestrator, /export class DocumentDomainOrchestrator/)
  assert.match(documentDomainOrchestrator, /async tryDeterministicSectionFormatFlow\(/)
  assert.match(documentDomainOrchestrator, /async tryDeterministicSectionRewriteFlow\(/)
  assert.match(documentDomainOrchestrator, /function isDocumentActionFailureText\(/)
  assert.match(documentDomainOrchestrator, /function isDocumentNoMutationText\(/)
  const rewriteNoMutationGuard = documentDomainOrchestrator.indexOf(
    'if (isDocumentActionFailure(rewriteResult) || isDocumentNoMutationText(rewriteResult.text))',
  )
  const rewriteSaveCall = documentDomainOrchestrator.indexOf("chunk: 'document_save_tab({})'", rewriteNoMutationGuard)
  assert.ok(rewriteNoMutationGuard > 0, 'rewrite shortcut must reject no-op rewrite results')
  assert.ok(rewriteSaveCall > rewriteNoMutationGuard, 'rewrite shortcut must reject no-op rewrites before saving')
  assert.match(
    readWorkspaceFile('src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts'),
    /export class DocumentTaskPipelineExecutor/,
  )
  assert.match(documentDomainHelpers, /export function parseSectionRewritePlan\(/)
  assert.match(documentDomainHelpers, /export function stripCodeFence\(/)
  assert.match(documentDomainHelpers, /export async function applyFormatSectionByPath\(/)
  assert.match(documentDomainHelpers, /export async function applyRewriteSectionByPath\(/)
  assert.match(documentDomainHelpers, /export async function buildSectionRewriteDraft\(/)
  assert.match(executionIntentResolver, /export function resolveExecutionIntentContext\(/)
  assert.match(runCapabilityController, /export function prepareInitialRun\(/)
  assert.match(runCapabilityController, /export function reconcileAfterBrowserDecision\(/)
  assert.match(providerRuntimeResolver, /export function resolveOpenAIProviderRuntime\(/)
  assert.match(providerRuntimeResolver, /export function shouldUseTextToolBridgeForRun\(/)
  assert.match(providerRuntimeResolver, /export function shouldRetryWithTextToolBridge\(/)
  assert.match(skillContextOrchestrator, /export class SkillContextOrchestrator/)
  assert.match(skillContextOrchestrator, /findExplicitlyRequestedSkills\(/)
  assert.match(skillContextOrchestrator, /shouldKeepToolsWithVideo\(/)
  assert.match(skillContextOrchestrator, /buildPreferredSkillToolNames\(/)
  assert.match(skillContextOrchestrator, /maybeInjectExplicitSkillContext\(/)
  assert.match(skillDomainAdapter, /export class SkillDomainAdapter/)
  assert.match(rssDomainAdapter, /export class RSSDomainAdapter/)
  assert.match(calendarDomainAdapter, /export class CalendarDomainAdapter/)
  assert.match(feishuDomainAdapter, /export class FeishuDomainAdapter/)
  assert.match(toolRuntimeContextBuilder, /export function buildToolRuntimeContext\(/)
  assert.match(videoFallbackService, /export class VideoFallbackService/)
  assert.match(videoFallbackService, /async buildVideoFrameFallbackMessages\(/)
  assert.match(videoFallbackService, /async extractFramesFromVideoBase64\(/)
  assert.match(anthropicExecutionClient, /export class AnthropicExecutionClient/)
  assert.match(anthropicExecutionClient, /async requestSimple\(/)
  assert.match(anthropicExecutionClient, /async requestWithTools\(/)
  assert.match(kimiCodingClient, /export class KimiCodingClient/)
  assert.match(kimiCodingClient, /async requestSimple\(/)
  assert.match(kimiCodingClient, /async serializeMessages\(/)
  assert.match(kimiCodingClient, /async uploadVideoToFiles\(/)
  assert.match(openAIExecutionClient, /export class OpenAIExecutionClient/)
  assert.match(openAIExecutionClient, /async requestSimple\(/)
  assert.match(openAIExecutionClient, /async requestTextToolBridge\(/)
  assert.match(openAIExecutionClient, /async requestWithTools\(/)
  assert.match(documentToolFlow, /export function shouldPreferDocumentInspectionResult\(/)
  assert.match(documentToolFlow, /export function inspectDocumentToolCall\(/)
  assert.doesNotMatch(contracts, /\bcompressContext\b/)
  assert.doesNotMatch(host, /\bcompressContext\b/)
  assert.match(toolConfig, /export interface ToolPolicy/)
  assert.match(toolConfig, /export function buildToolGuidance\(/)
  assert.match(toolConfig, /export function getPolicyAnthropicTools\(/)
  assert.match(toolConfig, /export function getPolicyOpenAITools\(/)
  assert.match(toolConfig, /export function buildTextToolBridgeSystemPrompt\(/)
  assert.match(toolConfig, /export function buildTextToolBridgeCorrectionMessage\(/)

  assert.match(runtime, /import \{ RunCoordinator \} from '\.\.\/task-projection\/run-coordinator'/)
  assert.match(runtime, /import \{ RunProjection \} from '\.\.\/task-projection\/run-projection'/)
  assert.match(runtime, /private readonly runCoordinator: RunCoordinator/)
  assert.match(runtime, /private readonly runProjection: RunProjection/)
  assert.doesNotMatch(runtime, /runtimeKernel:\s*'codex-native'|ready-agent-sdk-retired/)
  assert.match(runtime, /new CodexHostOrchestrator\(/)
  assert.doesNotMatch(runtime, /new ReadyAgentOrchestrator\(|new AgentSdkRuntime\(/)
  // Remote IM is resource ingress only. A hidden Agent dispatcher or typing
  // loop here would silently reintroduce non-local execution.
  const remoteChannelService = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/remote-channel-service.ts',
  )
  assert.doesNotMatch(runtime, /non_local_ingress_unsupported/)
  assert.doesNotMatch(remoteChannelService, /runInboundChannel|sendChannelTyping/)
  assert.match(remoteChannelService, /remote_inbound_resource_stored/)
  // B8-D R1 — projection event recording is delegated through the
  // ProjectionSyncCoordinator, which owns the single RunProjection.recordEvent
  // call site; the runtime wires its RunProjection instance into it.
  const projectionSyncCoordinator = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/projection-sync-coordinator.ts',
  )
  assert.match(runtime, /new ProjectionSyncCoordinator\(\{[\s\S]*?runProjection: this\.runProjection/)
  assert.match(projectionSyncCoordinator, /return this\.deps\.runProjection\.recordEvent\(/)
  assert.doesNotMatch(runtime, /const promptAssembly = await this\.promptAssembly\.buildForScopedRun\(/)
  assert.doesNotMatch(runtime, /const result = await this\.orchestrator\.sendAndCollect\(agent, promptPayload, scope\.id, requestId\)/)
  assert.match(runtime, /this\.codexRuntime\.ingressPort\.persistIngressAtomic\(/)
  assert.match(
    runtime,
    /this\.codexRuntime\.lifecycleAdapter\.executePreparedRun\(\{[\s\S]*?emitStartedProjection:\s*input\.emitStartedProjection,[\s\S]*?resolveContext:\s*\(\)\s*=>\s*this\.codexRuntime\.preparedRunContextPort\.resolve\(input\)/,
  )
  assert.doesNotMatch(runtime, /preparedRunPort/)
  assert.doesNotMatch(runtime, /codex_ingress_(?:repository|dispatch)_unavailable/)

  assert.match(orchestrator, /import type \{ ExecutionHostRequest, ExecutionHostResult \} from '\.\.\/contracts\/run-contracts'/)
  assert.match(orchestrator, /async executeAndCollect\(request: ExecutionHostRequest\): Promise<ExecutionHostResult>/)

  assert.match(toolPolicy, /export function buildToolVisibilityPlan\(/)
  assert.match(toolPolicy, /export function buildToolDispatchDecision\(/)
  // 合同随实现同步（Phase C C4/C5，2026-07-05）：装配壳的"消费抽取模块而非内联"
  // 正向断言从 direct-chat.ts 改锚 domain-adapter-host.ts。
  assert.match(host, /import \{ OpenAIExecutionClient \} from '\.\.\/\.\.\/claude-bridge\/openai-execution-client'/)
  assert.match(host, /import \{ SkillContextOrchestrator \} from '\.\.\/skills\/skill-context-orchestrator'/)
  assert.match(host, /import \{ AnthropicExecutionClient \} from '\.\.\/\.\.\/claude-bridge\/anthropic-execution-client'/)
  assert.match(host, /import \{ KimiCodingClient \} from '\.\.\/\.\.\/claude-bridge\/kimi-coding-client'/)
  assert.match(host, /import \{ DocumentToolLoopOrchestrator \} from '\.\.\/\.\.\/document-engine\/pipeline\/document-tool-loop-orchestrator'/)
  assert.match(host, /import \{ DocumentDomainOrchestrator \} from '\.\/document-domain-orchestrator'/)
  assert.doesNotMatch(host, /BrowserDomain(?:Orchestrator|Adapter)|BrowserTaskPlanner/)
  assert.match(host, /private readonly skillContextOrchestrator: SkillContextOrchestrator/)
  assert.match(host, /private readonly anthropicExecutionClient: AnthropicExecutionClient/)
  assert.match(host, /private readonly kimiCodingClient: KimiCodingClient/)
  assert.match(host, /private readonly openAIExecutionClient: OpenAIExecutionClient/)
  assert.match(host, /private readonly documentToolLoopOrchestrator: DocumentToolLoopOrchestrator/)
  assert.match(host, /private readonly documentDomainOrchestrator: DocumentDomainOrchestrator/)
  assert.match(host, /private readonly documentTaskPipelineExecutor: DocumentTaskPipelineExecutor/)
  // 工具上下文构造的 live 消费点在 SDK 工具执行器（V3 Phase 5-A 提取面）。
  assert.match(sdkToolExecutor, /buildToolRuntimeContext/)
  // 该组引擎私有断言随退役摘除（P6f dormant 边界 + Phase C C4，2026-07-05）：
  // - direct-chat 对 resolveExecutionIntentContext / prepareInitialRun /
  //   reconcileAfterBrowserDecision / applyRunBudgetHint / execution-tool-config /
  //   DesignToolLoopOrchestrator 的 import 钉：这些抽取模块随引擎退役失去了唯一
  //   消费方（模块导出面仍由上方断言钉住），SDK 路径尚无等价接线。
  // - 数十条 "引擎不得重新内联 callOpenAIWithTools / 文档捷径 / 设计过滤器 等"
  //   负向断言：冻结的是已删除文件的抽取历史；复活由
  //   check-directchat-turnengine-dormant-boundary 存在性合同拦截。
})

// P6-F1 测试随引擎退役摘除（P6f dormant 边界 + Phase C C4，2026-07-05）：
// "DirectChat 不得保留 host callbacks" 的负向断言在 direct-chat.ts 删除后失去
// 对象；requestSimpleText / ExecutionLoopOrchestrator / HostCapabilityDispatcher
// 的复活由 check-directchat-turnengine-dormant-boundary 的存在性合同与全 src/main
// import/构造扫描拦截。

test('production ownership keeps Codex as the only sender and DomainAdapterHost outside the core', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const codexHost = readWorkspaceFile('src/main/modules/agent-control/runtime-core/codex-host-orchestrator.ts')
  const contracts = readWorkspaceFile('src/main/modules/agent-control/contracts/run-contracts.ts')

  assertMatchesAll(contracts, [
    {
      label: 'phase3 should add a distinct execution turn result contract',
      pattern: /export interface ExecutionTurnResult/,
    },
  ])

  assertMatchesAll(runtime, [
    {
      label: 'runtime should construct the Codex host',
      pattern: /this\.orchestrator = new CodexHostOrchestrator\(/,
    },
    {
      label: 'runtime should construct the Codex coordinator without a legacy switch',
      pattern: /this\.runCoordinator = new RunCoordinator\(\{[\s\S]*?executeCodexPrepared:/,
    },
  ])
  assert.doesNotMatch(runtime, /codexProductRunPreparer|codexPreparationInput/)
  assert.match(codexHost, /export class CodexHostOrchestrator/)
  assert.match(codexHost, /private readonly domainAdapterHost = new DomainAdapterHost\(\)/)
  assert.doesNotMatch(codexHost, /AgentSdkRuntime|ReadyAgentOrchestrator|sendMessage\(/)
})

test('retired SDK browser fixture still has one durable workflow inspection without entering production assembly', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime-core/runtime.ts')
  const sdkToolExecutor = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor.ts',
  )
  const sdkModelLoop = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/agent-sdk-turn-model-loop.ts',
  )
  const sdkRuntime = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts',
  )
  const sdkTurnExecution = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/agent-sdk-turn-execution.ts',
  )
  const sdkTurnCompletion = readWorkspaceFile(
    'src/main/modules/agent-control/runtime-core/agent-sdk-turn-completion.ts',
  )

  assert.match(sdkTurnCompletion, /readWorkflowVerifierBundle\(/)
  assert.doesNotMatch(sdkTurnCompletion, /readVerifiedBrowserWorkflowEvidence\(/)
  assert.match(sdkTurnCompletion, /browserVerifierInspection\.inspection\.state !== 'sealable'/)
  assert.doesNotMatch(
    `${sdkRuntime}\n${sdkTurnExecution}\n${sdkModelLoop}\n${sdkToolExecutor}`,
    /active-plan-step-reminder|noteToolResultForActivePlan|buildActivePlanReminderText|\.applyResult\(/,
  )
  assert.doesNotMatch(runtime, /agent-sdk-turn-completion|new AgentSdkRuntime\(/)
})
