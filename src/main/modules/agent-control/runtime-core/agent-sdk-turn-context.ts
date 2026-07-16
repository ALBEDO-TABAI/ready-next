import type { AgentInputItem } from '@openai/agents'
import type { FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import type { AIConfigLoad } from '../../claude-bridge/direct-chat-ai-config'
import type { RunMessage, TaskProjectionRecord, TaskType } from '../contracts/run-contracts'
import type { CheckInRecord } from '../quality/task-adjudicator'
import type {
  resumeSkillChildRun as defaultResumeSkillChildRun,
  waitForSkillChildRunClose as defaultWaitForSkillChildRunClose
} from '../skills/skill-child-runner'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type { AgentSdkIntentTracker } from './agent-sdk-intent-tracker'
import type { AgentSdkRunLifecycle } from './agent-sdk-run-lifecycle'
import type { AgentSdkSessionManager } from './agent-sdk-session'
import type { AgentSdkToolExecutor } from './agent-sdk-tool-executor'
import type {
  AgentSdkRuntimeDeps,
  CompactReason,
  CompactSessionResult,
  ReadyAgentSdkRunParams,
  ReadyAgentSdkRunResult,
  RunHandle,
  RunMetaRepositoryLike,
  SkillContextOrchestratorLike,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import type { AgentControlRuntime } from './runtime'
import type { DynamicDeliveryCoordinator } from './dynamic-delivery/dynamic-delivery-coordinator'

export interface TurnOrchestratorHost {
  readonly executeToolCall: NonNullable<AgentSdkRuntimeDeps['executeToolCall']>
  readonly fetchWithTimeout: NonNullable<AgentSdkRuntimeDeps['fetchWithTimeout']>
  readonly getScopeTaskRefs: ((scopeId: string) => FollowupTaskRef[]) | null
  readonly intentTracker: AgentSdkIntentTracker
  readonly listToolDefinitionsForTurn: NonNullable<AgentSdkRuntimeDeps['listToolDefinitions']>
  readonly loadAIConfig: () => AIConfigLoad
  readonly resumeSkillChildRun: typeof defaultResumeSkillChildRun
  readonly runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  readonly setActiveToolUseMode: NonNullable<AgentSdkRuntimeDeps['setActiveToolUseMode']>
  readonly dynamicDelivery: DynamicDeliveryCoordinator
  readonly runLifecycle: AgentSdkRunLifecycle
  readonly runtime: AgentControlRuntime | null
  readonly sessionManager: AgentSdkSessionManager
  readonly skillContextOrchestrator: SkillContextOrchestratorLike | null
  readonly toolExecutor: AgentSdkToolExecutor
  readonly waitForSkillChildRunClose: typeof defaultWaitForSkillChildRunClose
  compactCapturedSession(
    name: string,
    runHandle: RunHandle,
    baseItems: AgentInputItem[] | undefined,
    reason: CompactReason,
    windowTokens: number
  ): Promise<CompactSessionResult>
  getRunMetaRepositoryForFinalize(): RunMetaRepositoryLike | null
  hasBrowserController(): boolean
  hasPendingTaskProjection(scopeId?: string): boolean
  learnSiteCardFromToolFailure(
    toolName: string,
    args: Record<string, unknown> | undefined,
    output: ToolExecutionOutput
  ): void
  learnSiteCardsFromCheckIn(input: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    terminalStatus?: string | null
    terminalReason?: string | null
  }): void
  newSession(name: string, systemPrompt?: string): void
  resolveMapPlaceAmbiguityIfNeeded(params: {
    bridgeResults: ToolBridgeResultItem[]
    definitionByName: Map<string, ToolDefinition>
    runtimeContext: ToolBridgeRuntimeContext
  }): Promise<boolean>
  resolveSkillAuthorizationForTurn(
    message: RunMessage,
    sessionId?: string,
    requestEnvelope?: unknown,
    forceLocalSendImIntent?: boolean,
    skillHintRelevantForTurn?: boolean
  ): SkillToolAuthorization
  resolveTaskTypeFromTools(usedTools: string[]): TaskType
  emit(event: string | symbol, ...args: unknown[]): boolean
}
