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

test('runtime host is split into run coordinator, run projection, and execution host contracts', () => {
  const runtime = readWorkspaceFile('src/main/modules/agent-control/runtime.ts')
  const orchestrator = readWorkspaceFile('src/main/modules/agent-control/orchestrator.ts')
  const runCoordinator = readWorkspaceFile('src/main/modules/agent-control/run-coordinator.ts')
  const runProjection = readWorkspaceFile('src/main/modules/agent-control/run-projection.ts')
  const contracts = readWorkspaceFile('src/main/modules/agent-control/run-contracts.ts')
  const browserDomainOrchestrator = readWorkspaceFile('src/main/modules/agent-control/browser-domain-orchestrator.ts')
  const browserDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/browser-domain-adapter.ts')
  const domainAdapter = readWorkspaceFile('src/main/modules/agent-control/domain-adapter.ts')
  const designToolLoopOrchestrator = readWorkspaceFile('src/main/modules/agent-control/design-tool-loop-orchestrator.ts')
  const documentToolLoopOrchestrator = readWorkspaceFile('src/main/modules/agent-control/document-tool-loop-orchestrator.ts')
  const documentDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/document-domain-adapter.ts')
  const documentDomainOrchestrator = readWorkspaceFile('src/main/modules/agent-control/document-domain-orchestrator.ts')
  const documentDomainHelpers = readWorkspaceFile('src/main/modules/agent-control/document-domain-helpers.ts')
  const executionIntentResolver = readWorkspaceFile('src/main/modules/agent-control/execution-intent-resolver.ts')
  const runCapabilityController = readWorkspaceFile('src/main/modules/agent-control/run-capability-controller.ts')
  const hostCapabilityDispatcher = readWorkspaceFile('src/main/modules/agent-control/host-capability-dispatcher.ts')
  const providerRuntimeResolver = readWorkspaceFile('src/main/modules/agent-control/provider-runtime-resolver.ts')
  const skillContextOrchestrator = readWorkspaceFile('src/main/modules/agent-control/skill-context-orchestrator.ts')
  const skillDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/skill-domain-adapter.ts')
  const rssDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/rss-domain-adapter.ts')
  const calendarDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/calendar-domain-adapter.ts')
  const feishuDomainAdapter = readWorkspaceFile('src/main/modules/agent-control/feishu-domain-adapter.ts')
  const toolRuntimeContextBuilder = readWorkspaceFile('src/main/modules/agent-control/tool-runtime-context-builder.ts')
  const videoFallbackService = readWorkspaceFile('src/main/modules/claude-bridge/video-fallback-service.ts')
  const anthropicExecutionClient = readWorkspaceFile('src/main/modules/claude-bridge/anthropic-execution-client.ts')
  const kimiCodingClient = readWorkspaceFile('src/main/modules/claude-bridge/kimi-coding-client.ts')
  const openAIExecutionClient = readWorkspaceFile('src/main/modules/claude-bridge/openai-execution-client.ts')
  const documentToolFlow = readWorkspaceFile('src/main/modules/claude-bridge/document-tool-flow.ts')
  const executionLoopOrchestrator = readWorkspaceFile('src/main/modules/agent-control/execution-loop-orchestrator.ts')
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const toolConfig = readWorkspaceFile('src/main/modules/agent-control/execution-tool-config.ts')
  const toolPolicy = readWorkspaceFile('src/main/modules/agent-control/execution-tool-policy.ts')

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
  assert.match(runCoordinator, /async runInboundChannel\(/)
  assert.match(runCoordinator, /private async executeRun\(/)

  assert.match(runProjection, /export class RunProjection/)
  assert.match(runProjection, /recordEvent\(/)
  assert.doesNotMatch(runProjection, /deriveTaskSummaryPatch\(/)
  assert.match(browserDomainOrchestrator, /export class BrowserDomainOrchestrator/)
  assert.match(browserDomainOrchestrator, /async prepareBrowserExecution\(/)
  assert.match(browserDomainOrchestrator, /createToolLoopState\(/)
  assert.match(browserDomainOrchestrator, /recordToolLoopProgress\(/)
  assert.match(browserDomainOrchestrator, /buildToolLoopLimitMessage\(/)
  assert.match(browserDomainOrchestrator, /buildToolLoopMessage\(/)
  assert.match(browserDomainOrchestrator, /getRecommendedToolLoopIterations\(/)
  assert.match(browserDomainOrchestrator, /refineUploadDecision\(/)
  assert.match(browserDomainOrchestrator, /runDeterministicExecution\(/)
  assert.match(browserDomainOrchestrator, /resolveExecutionDispatch\(/)
  assert.match(domainAdapter, /export interface DomainAdapter/)
  assert.match(domainAdapter, /executedTools\?: Array</)
  assert.match(domainAdapter, /export function readToolProjectionPatch\(/)
  assert.match(domainAdapter, /export function readStructuredToolResultRecord\(/)
  assert.match(domainAdapter, /export function selectDomainAdapter\(/)
  assert.match(browserDomainAdapter, /export class BrowserDomainAdapter/)
  assert.match(browserDomainAdapter, /prepare\(/)
  assert.match(browserDomainAdapter, /dispatch\(/)
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
  assert.match(
    readWorkspaceFile('src/main/modules/agent-control/document-task-pipeline-executor.ts'),
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
  assert.match(hostCapabilityDispatcher, /export class HostCapabilityDispatcher/)
  assert.match(hostCapabilityDispatcher, /async dispatch\(/)
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
  assert.match(executionLoopOrchestrator, /export class ExecutionLoopOrchestrator/)
  assert.match(executionLoopOrchestrator, /async requestToolLoopResponse\(/)
  assert.match(executionLoopOrchestrator, /async executeToolCalls\(/)
  assert.doesNotMatch(executionLoopOrchestrator, /shouldRetryWithVideoFallback:/)
  assert.match(toolConfig, /export interface ToolPolicy/)
  assert.match(toolConfig, /export function buildToolGuidance\(/)
  assert.match(toolConfig, /export function getPolicyAnthropicTools\(/)
  assert.match(toolConfig, /export function getPolicyOpenAITools\(/)
  assert.match(toolConfig, /export function buildTextToolBridgeSystemPrompt\(/)
  assert.match(toolConfig, /export function buildTextToolBridgeCorrectionMessage\(/)

  assert.match(runtime, /import \{ RunCoordinator \} from '\.\/run-coordinator'/)
  assert.match(runtime, /import \{ RunProjection \} from '\.\/run-projection'/)
  assert.match(runtime, /private readonly runCoordinator: RunCoordinator/)
  assert.match(runtime, /private readonly runProjection: RunProjection/)
  assert.match(runtime, /return this\.runCoordinator\.runScoped\(/)
  assert.match(runtime, /await this\.runCoordinator\.runInboundChannel\(/)
  assert.match(runtime, /return this\.runProjection\.recordEvent\(/)
  assert.doesNotMatch(runtime, /const promptAssembly = await this\.promptAssembly\.buildForScopedRun\(/)
  assert.doesNotMatch(runtime, /const result = await this\.orchestrator\.sendAndCollect\(agent, promptPayload, scope\.id, requestId\)/)

  assert.match(orchestrator, /import type \{ ExecutionHostRequest, ExecutionHostResult \} from '\.\/run-contracts'/)
  assert.match(orchestrator, /async executeAndCollect\(request: ExecutionHostRequest\): Promise<ExecutionHostResult>/)

  assert.match(toolPolicy, /export function buildToolVisibilityPlan\(/)
  assert.match(toolPolicy, /export function buildToolDispatchDecision\(/)
  assert.match(turnEngine, /export class TurnEngine/)
  assert.match(turnEngine, /async execute(?:<|\()/)
  assert.match(turnEngine, /hostCapabilityDispatcher\.dispatch\(/)
  assert.match(turnEngine, /selectDomainAdapter\(domainAdapters/)
  assert.match(turnEngine, /selectedDomainAdapter\.buildProjectionPatch\(/)
  assert.match(turnEngine, /executedToolsThisIteration/)
  assert.match(turnEngine, /designToolLoopOrchestrator\.buildStructuredTaskPayload\(/)
  assert.match(turnEngine, /selectedDomainPrepareResult\?\.budgetHint/)
  assert.match(turnEngine, /selectedDomainAdapter\.applyResult\(/)
  assert.match(turnEngine, /designToolLoopOrchestrator\.getBudgetHint\(/)
  assert.match(turnEngine, /simpleResponse\.fallback/)
  assert.match(turnEngine, /executedToolBatch\.budgetLimited/)
  assert.match(directChat, /import \{ OpenAIExecutionClient \} from '\.\/openai-execution-client'/)
  assert.match(directChat, /import \{ resolveExecutionIntentContext \} from '\.\.\/agent-control\/execution-intent-resolver'/)
  assert.match(directChat, /import \{[\s\S]*prepareInitialRun[\s\S]*reconcileAfterBrowserDecision[\s\S]*\} from '\.\.\/agent-control\/run-capability-controller'/)
  assert.match(directChat, /import \{ HostCapabilityDispatcher \} from '\.\.\/agent-control\/host-capability-dispatcher'/)
  assert.match(directChat, /import \{ SkillContextOrchestrator \} from '\.\.\/agent-control\/skill-context-orchestrator'/)
  assert.match(directChat, /import \{ buildToolRuntimeContext \} from '\.\.\/agent-control\/tool-runtime-context-builder'/)
  assert.match(directChat, /import \{[\s\S]*applyRunBudgetHint[\s\S]*\} from '\.\.\/agent-control\/run-budget-policy'/)
  assert.match(directChat, /import \{ VideoFallbackService \} from '\.\/video-fallback-service'/)
  assert.match(directChat, /import \{ AnthropicExecutionClient \} from '\.\/anthropic-execution-client'/)
  assert.match(directChat, /import \{ KimiCodingClient \} from '\.\/kimi-coding-client'/)
  assert.match(directChat, /import \{[\s\S]*OpenAIExecutionClient[\s\S]*\} from '\.\/openai-execution-client'/)
  assert.match(directChat, /import \{ BrowserDomainOrchestrator \} from '\.\.\/agent-control\/browser-domain-orchestrator'/)
  assert.match(directChat, /import \{ DesignToolLoopOrchestrator \} from '\.\.\/agent-control\/design-tool-loop-orchestrator'/)
  assert.match(directChat, /import \{ DocumentToolLoopOrchestrator \} from '\.\.\/agent-control\/document-tool-loop-orchestrator'/)
  assert.match(directChat, /import \{ DocumentDomainOrchestrator \} from '\.\.\/agent-control\/document-domain-orchestrator'/)
  assert.match(directChat, /import \{ ExecutionLoopOrchestrator \} from '\.\.\/agent-control\/execution-loop-orchestrator'/)
  assert.match(directChat, /private readonly browserDomainOrchestrator: BrowserDomainOrchestrator/)
  assert.match(directChat, /private readonly skillContextOrchestrator: SkillContextOrchestrator/)
  assert.match(directChat, /private readonly anthropicExecutionClient: AnthropicExecutionClient/)
  assert.match(directChat, /private readonly kimiCodingClient: KimiCodingClient/)
  assert.match(directChat, /private readonly openAIExecutionClient: OpenAIExecutionClient/)
  assert.match(directChat, /private readonly videoFallbackService: VideoFallbackService/)
  assert.match(directChat, /private readonly designToolLoopOrchestrator: DesignToolLoopOrchestrator/)
  assert.match(directChat, /private readonly documentToolLoopOrchestrator: DocumentToolLoopOrchestrator/)
  assert.match(directChat, /private readonly documentDomainOrchestrator: DocumentDomainOrchestrator/)
  assert.match(directChat, /private readonly documentTaskPipelineExecutor: DocumentTaskPipelineExecutor/)
  assert.match(directChat, /private readonly executionLoopOrchestrator: ExecutionLoopOrchestrator/)
  assert.match(directChat, /private readonly hostCapabilityDispatcher: HostCapabilityDispatcher/)
  assert.match(directChat, /import \{ TurnEngine \} from '\.\.\/agent-control\/turn-engine'/)
  assert.match(directChat, /private readonly turnEngine: TurnEngine/)
  assert.match(directChat, /return await this\.turnEngine\.execute\(/)
  assert.doesNotMatch(directChat, /private async maybeRunDocumentTaskPlanShortcut\(/)
  assert.doesNotMatch(directChat, /private async maybeRunDocumentWidgetPipelineShortcut\(/)
  assert.doesNotMatch(directChat, /private readonly documentInsightCache = new DocumentInsightCache\(\)/)
  assert.match(directChat, /import \{[\s\S]*buildTextToolBridgeCorrectionMessage[\s\S]*buildToolGuidance[\s\S]*\} from '\.\.\/agent-control\/execution-tool-config'/)
  assert.doesNotMatch(directChat, /import \{ buildToolVisibilityPlan \} from '\.\.\/agent-control\/execution-tool-policy'/)
  assert.doesNotMatch(directChat, /await this\.browserTaskPlanner\.buildContinuityContext\(/)
  assert.doesNotMatch(directChat, /interface ToolPolicy \{/)
  assert.doesNotMatch(directChat, /private getPolicyAnthropicTools\(/)
  assert.doesNotMatch(directChat, /private getPolicyOpenAITools\(/)
  assert.doesNotMatch(directChat, /private buildTextToolBridgeSystemPrompt\(/)
  assert.doesNotMatch(directChat, /private async tryDeterministicSectionFormatFlow\(/)
  assert.doesNotMatch(directChat, /private async tryDeterministicSectionRewriteFlow\(/)
  assert.doesNotMatch(directChat, /private parseSectionRewritePlan\(/)
  assert.doesNotMatch(directChat, /private async applyFormatSectionByPath\(/)
  assert.doesNotMatch(directChat, /private async applyRewriteSectionByPath\(/)
  assert.doesNotMatch(directChat, /private async buildSectionRewriteDraft\(/)
  assert.doesNotMatch(directChat, /function shouldPreferDocumentInspectionResult\(/)
  assert.doesNotMatch(directChat, /const CONTENT_MUTATING_DOCUMENT_TOOL_NAMES = new Set\(/)
  assert.doesNotMatch(directChat, /const DOCUMENT_INSPECTION_TOOL_NAMES = new Set\(/)
  assert.doesNotMatch(directChat, /function parseSectionRewritePlan\(/)
  assert.doesNotMatch(directChat, /function stripCodeFence\(/)
  assert.doesNotMatch(directChat, /async function applyFormatSectionByPath\(/)
  assert.doesNotMatch(directChat, /async function applyRewriteSectionByPath\(/)
  assert.doesNotMatch(directChat, /async function buildSectionRewriteDraft\(/)
  assert.doesNotMatch(directChat, /\[系统检查点\] 当前进度：/)
  assert.doesNotMatch(directChat, /private async maybeRefineBrowserDecision\(/)
  assert.doesNotMatch(directChat, /new BrowserAgentRunner\(/)
  assert.doesNotMatch(directChat, /private shouldUseTextToolBridge\(/)
  assert.doesNotMatch(directChat, /private shouldRetryWithTextToolBridge\(/)
  assert.doesNotMatch(directChat, /private resolveOpenAIWireApi\(/)
  assert.doesNotMatch(directChat, /private resolveReasoningEffort\(/)
  assert.doesNotMatch(directChat, /private findExplicitlyRequestedSkills\(/)
  assert.doesNotMatch(directChat, /private extractSkillReferenceContent\(/)
  assert.doesNotMatch(directChat, /private async maybeInjectExplicitSkillContext\(/)
  assert.doesNotMatch(directChat, /private hasActiveSkillExecution\(/)
  assert.doesNotMatch(directChat, /private shouldKeepToolsWithVideo\(/)
  assert.doesNotMatch(directChat, /private buildPreferredSkillToolNames\(/)
  assert.doesNotMatch(directChat, /const openclawCommand = this\.extractOpenclawPairingCommand\(userText\)/)
  assert.doesNotMatch(directChat, /toolPolicy\.forceDocumentTool &&[\s\S]*toolPolicy\.preferFormatOnly/)
  assert.doesNotMatch(directChat, /private applyDesignSourceInput\(/)
  assert.doesNotMatch(directChat, /private buildActualDesignCompletionText\(/)
  assert.doesNotMatch(directChat, /private isPrimaryDesignArtifactTool\(/)
  assert.doesNotMatch(directChat, /private filterSingleArtifactDesignToolCalls\(/)
  assert.doesNotMatch(directChat, /const toolContext = \{/)
  assert.doesNotMatch(directChat, /const deterministicDocumentToolContext = \{/)
  assert.doesNotMatch(directChat, /private extractOpenAIMessageText\(/)
  assert.doesNotMatch(directChat, /private serializeMessagesForResponses\(/)
  assert.doesNotMatch(directChat, /private convertOpenAIToolsToResponses\(/)
  assert.doesNotMatch(directChat, /private extractResponsesText\(/)
  assert.doesNotMatch(directChat, /private extractResponsesToolCalls\(/)
  assert.doesNotMatch(directChat, /private getResponsesContinuationState\(/)
  assert.doesNotMatch(directChat, /private repairOpenAIToolMessageHistory\(/)
  assert.doesNotMatch(directChat, /private async callOpenAISimple\(/)
  assert.doesNotMatch(directChat, /private async callOpenAIWithTextToolBridge\(/)
  assert.doesNotMatch(directChat, /private async callOpenAIWithTools\(/)
  assert.doesNotMatch(directChat, /private resolveAnthropicLikeModel\(/)
  assert.doesNotMatch(directChat, /private buildAnthropicLikeHeaders\(/)
  assert.doesNotMatch(directChat, /private async callAnthropicSimple\(/)
  assert.doesNotMatch(directChat, /private async callAnthropicWithTools\(/)
  assert.doesNotMatch(directChat, /private async callKimiCodingSimple\(/)
  assert.doesNotMatch(directChat, /fallback to Anthropic-compatible path/)
  assert.doesNotMatch(directChat, /private async serializeMessagesForKimiCoding\(/)
  assert.doesNotMatch(directChat, /private async uploadVideoToKimiFiles\(/)
  assert.doesNotMatch(directChat, /private async getFfmpegPath\(/)
  assert.doesNotMatch(directChat, /private async buildVideoFrameFallbackMessages\(/)
  assert.doesNotMatch(directChat, /private async extractFramesFromVideoBase64\(/)
  assert.doesNotMatch(directChat, /private shouldRetryWithVideoFallback\(/)
  assert.doesNotMatch(directChat, /private extensionFromVideoMediaType\(/)
  assert.doesNotMatch(directChat, /response = await this\.callAnthropicWithTools\(/)
  assert.doesNotMatch(directChat, /response = await this\.callOpenAIWithTools\(/)
})

test('phase3 moves execution-host responsibilities from DirectChatEngine into TurnEngine while preserving host wiring', () => {
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')

  assertMatchesAll(directChat, [
    {
      label: 'phase3 should keep run setup explicit in sendMessage',
      pattern: /const abortController = new AbortController\(/,
    },
    {
      label: 'phase3 should keep provider context assembly explicit in sendMessage',
      pattern: /providerContext: \{/,
    },
    {
      label: 'phase3 should keep turn-engine host assembly explicit in direct chat',
      pattern: /private buildTurnEngineHost\(/,
    },
    {
      label: 'phase3 should keep requestSimpleText host callback local to direct chat',
      pattern: /private async requestSimpleText\(/,
    },
    {
      label: 'phase3 should keep requestToolLoopResponse host callback local to direct chat',
      pattern: /private async requestToolLoopResponse\(/,
    },
  ])

  assertMatchesAll(turnEngine, [
    {
      label: 'phase3 should move run capability preparation into TurnEngine',
      pattern: /const preparedRunCapabilities = prepareInitialRun\(/,
    },
    {
      label: 'phase3 should move initial route resolution into TurnEngine',
      pattern: /const initialTaskExecutionRoute = resolveTaskExecutionRoute\(/,
    },
    {
      label: 'phase4 should prepare browser routing through the domain adapter contract',
      pattern: /const browserPrepareResult = browserDomainAdapter/,
    },
    {
      label: 'phase3 should move capability reconciliation into TurnEngine',
      pattern: /const reconciledRunCapabilities = reconcileAfterBrowserDecision\(/,
    },
    {
      label: 'phase3 should move final execution route ownership into TurnEngine',
      pattern: /const taskExecutionRoute = resolveTaskExecutionRoute\(/,
    },
    {
      label: 'phase3 should move host shortcut dispatch into TurnEngine',
      pattern: /const hostShortcutResult = await hostCapabilityDispatcher\.dispatch\(/,
    },
    {
      label: 'phase4 should select a single domain adapter after route resolution',
      pattern: /const selectedDomainAdapter = selectDomainAdapter\(domainAdapters/,
    },
    {
      label: 'phase3 should move design loop state ownership into TurnEngine',
      pattern: /let designToolLoopState = designToolLoopOrchestrator\.createState\(\)/,
    },
    {
      label: 'phase3 should move model tool-loop requests into TurnEngine',
      pattern: /await host\.requestToolLoopResponse\(/,
    },
    {
      label: 'phase3 should move batch tool execution into TurnEngine',
      pattern: /await host\.executeToolBatch\(/,
    },
    {
      label: 'phase3 should move direct host tool execution into TurnEngine',
      pattern: /executeTool:\s*async \(tool: string,\s*args: Record<string, unknown>\) => host\.executeToolCall\(tool,\s*args,\s*preparedToolContext\)/,
    },
    {
      label: 'phase4 should move domain-specific projection emission behind adapter buildProjectionPatch',
      pattern: /const patch = selectedDomainAdapter\.buildProjectionPatch\(/,
    },
  ])
})

test('phase0 freezes the target runtime boundary that later refactors must satisfy', () => {
  const roadmap = readWorkspaceFile('docs/superpowers/plans/2026-04-17-ready-agent-runtime-realignment-roadmap.md')
  const design = readWorkspaceFile('docs/superpowers/specs/2026-04-17-ready-agent-runtime-realignment-design.md')
  const gapAnalysis = readWorkspaceFile('docs/superpowers/specs/2026-04-17-claude-code-vs-ready-agent-gap-analysis.md')

  assertMatchesAll(roadmap, [
    {
      label: 'roadmap should freeze the current DirectChatEngine ownership baseline into tests',
      pattern: /把“当前哪些职责仍然在 `DirectChatEngine`”写成测试断言/,
    },
    {
      label: 'roadmap should freeze the future migration boundary into tests',
      pattern: /把“未来哪些职责应该被迁出”也写成 contract 断言/,
    },
    {
      label: 'roadmap should require DirectChatEngine to shrink into a provider host',
      pattern: /`DirectChatEngine` 缩为 provider-facing host shell/,
    },
    {
      label: 'roadmap should require TurnState to absorb single-turn runtime truth',
      pattern: /`route \/ budget \/ toolPool \/ transcript \/ interaction \/ continuation \/ domainState`/,
    },
    {
      label: 'roadmap should require shrinkage to stay backed by contract tests',
      pattern: /`DirectChatEngine` 的缩责必须有 contract test 支撑/,
    },
  ])

  assertMatchesAll(design, [
    {
      label: 'design should describe TurnEngine as the new single-turn owner',
      pattern: /单轮执行唯一真相来源/,
    },
    {
      label: 'design should freeze PreparedRunPayload as TurnEngine input',
      pattern: /接收 `PreparedRunPayload`/,
    },
    {
      label: 'design should freeze ExecutionTurnResult as TurnEngine output',
      pattern: /产出结构化 `ExecutionTurnResult`/,
    },
    {
      label: 'design should freeze DirectChatEngine as a provider-facing execution host shell',
      pattern: /`DirectChatEngine` 最终应缩成“provider-facing execution host shell”/,
    },
  ])

  assertMatchesAll(gapAnalysis, [
    {
      label: 'gap analysis should freeze DirectChatEngine as the current super-host problem',
      pattern: /`DirectChatEngine` 仍然是事实上的超级宿主/,
    },
    {
      label: 'gap analysis should freeze TurnEngine as the future execution truth owner',
      pattern: /新的 `TurnEngine` 成为唯一 execution truth owner/,
    },
    {
      label: 'gap analysis should freeze DirectChatEngine as a future provider client host adapter',
      pattern: /`DirectChatEngine` 缩成 provider client \+ host adapter/,
    },
  ])
})

test('phase3 keeps runtime ownership split while DirectChatEngine delegates single-turn execution to TurnEngine', () => {
  const orchestrator = readWorkspaceFile('src/main/modules/agent-control/orchestrator.ts')
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const turnEngine = readWorkspaceFile('src/main/modules/agent-control/turn-engine.ts')
  const contracts = readWorkspaceFile('src/main/modules/agent-control/run-contracts.ts')

  assertMatchesAll(contracts, [
    {
      label: 'phase3 should add a distinct execution turn result contract',
      pattern: /export interface ExecutionTurnResult/,
    },
    {
      label: 'phase3 should add a dedicated turn engine request contract',
      pattern: /export interface TurnEngineRequest/,
    },
  ])

  assertMatchesAll(turnEngine, [
    {
      label: 'phase3 should add a TurnEngine class',
      pattern: /export class TurnEngine/,
    },
    {
      label: 'phase3 should make TurnEngine execute single-turn runs',
      pattern: /async execute(?:<|\()/,
    },
  ])

  assertMatchesAll(directChat, [
    {
      label: 'direct chat should import TurnEngine during phase3',
      pattern: /import \{ TurnEngine \} from '\.\.\/agent-control\/turn-engine'/,
    },
    {
      label: 'direct chat should keep a turn engine instance during phase3',
      pattern: /private readonly turnEngine: TurnEngine/,
    },
    {
      label: 'sendMessage should delegate to turn engine during phase3',
      pattern: /return await this\.turnEngine\.execute\(/,
    },
  ])

  assertMatchesAll(orchestrator, [
    {
      label: 'orchestrator should continue consuming execution host results rather than direct-chat internals',
      pattern: /async executeAndCollect\(request: ExecutionHostRequest\): Promise<ExecutionHostResult>/,
    },
    {
      label: 'orchestrator should read stable task projection ids from host results',
      pattern: /taskProjectionId: result\.taskProjectionId/,
    },
    {
      label: 'orchestrator should read stable execution diagnostics from host results',
      pattern: /executionDiagnostics: result\.executionDiagnostics \|\| null/,
    },
  ])
})
