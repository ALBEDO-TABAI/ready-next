import type { AgentInputItem, MemorySession } from '@openai/agents'
import type { AgentSessionCheckpointRepository } from '../../repositories/agent-session-checkpoint-repository'
import { AgentSessionInputController } from './agent-session-input-controller'
import type { ToolBridgeRuntimeContext } from './agent-sdk-types'

export function bindAgentSessionInputController(params: {
  repository: AgentSessionCheckpointRepository | null
  runtimeContext: ToolBridgeRuntimeContext
  requestEnvelope: unknown
  ownerModelSession: MemorySession
}): {
  controller: AgentSessionInputController
  filter: (
    items: AgentInputItem[],
    context: { sourceItems: AgentInputItem[]; compacted: boolean },
  ) => Promise<AgentInputItem[]>
  prepareRunnerSession: () => Promise<void>
} | null {
  if (!params.repository) return null
  const controller = new AgentSessionInputController(
    params.repository,
    params.runtimeContext,
    params.requestEnvelope,
  )
  params.runtimeContext.ensureBrowserWorkflowRoute = () => controller.ensureBrowserWorkflowRoute()
  return {
    controller,
    filter: (items, context) => controller.filter(items, context),
    prepareRunnerSession: () => controller.prepareRunnerSession(params.ownerModelSession),
  }
}
