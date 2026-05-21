import type { SkillRunContract } from '../contracts/run-contracts'
import type { SkillChildDriver } from './skill-child-drivers'
import type {
  SkillChildLaunchParams,
  SkillChildRunPayload,
} from './skill-child-run-types'
import {
  createSkillChildSubAgent,
  type SkillChildSubAgentActionExecutor,
} from './skill-child-sub-agent'
import type { SubAgent } from '../sub-agent/sub-agent-types'

export interface SkillChildSubAgentFromPersistedParams {
  readonly payload: SkillChildRunPayload
  readonly driver: SkillChildDriver
  readonly executeAction: SkillChildSubAgentActionExecutor
  readonly maxActions?: number
  readonly contract?: SkillRunContract | null
}

export async function createSkillChildSubAgentFromPersisted(
  params: SkillChildSubAgentFromPersistedParams,
): Promise<SubAgent> {
  if (params.contract && !params.driver.canResume(params.contract)) {
    throw new Error(`driver cannot resume child run ${params.payload.childRunId}`)
  }
  const launchParams: SkillChildLaunchParams = {
    skillId: params.payload.skillId,
    action: params.payload.requestedAction,
    scopeId: params.payload.parentScopeId,
    sessionId: params.payload.parentSessionId,
    requestedInput: params.payload.requestedInput,
    parentNextHint: params.payload.parentNextHint,
    outputDir: params.payload.outputDir,
  }
  const initialState = await params.driver.createInitialState(launchParams)
  return createSkillChildSubAgent({
    childRunId: params.payload.childRunId,
    outputDir: params.payload.outputDir,
    runStatePath: params.payload.runStatePath,
    driver: params.driver,
    initialState,
    executeAction: params.executeAction,
    parentScopeId: params.payload.parentScopeId,
    parentSessionId: params.payload.parentSessionId,
    maxActions: params.maxActions,
  })
}
