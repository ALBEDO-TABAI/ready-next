import type { ActiveSkillContextSource } from './active-skill-context'

export type TurnTerminalReason =
  | 'done'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'checkpoint_user_input'
  | 'blocked_config'
  | 'blocked_tool_error'
  | 'failed_skill'
  | 'cancelled_user'
  | 'cancelled_runtime'
  | 'infra_error'

export type TurnUserIntent =
  | 'start'
  | 'continue'
  | 'repair_config'
  | 'inspect'
  | 'cancel'
  | 'unknown'

export type TurnFrameLiveness =
  | 'running_process'
  | 'recent_progress'
  | 'recoverable_paused'
  | 'blocked'
  | 'ready_to_resume'
  | 'done'
  | 'failed'
  | 'unknown'

export interface TurnFrameSkillSlice {
  skillId: string
  skillName: string | null
  source: ActiveSkillContextSource
  confidence: number
  taskRunId: string | null
  detachedTaskId: string | null
  action: string | null
  runStatePath: string | null
  outputDir: string | null
  artifactPaths: {
    sceneScoresPath: string | null
    deliveryReportPath: string | null
  }
  status: string | null
  staleBlockerReason: string | null
}

export interface TurnFrame {
  ids: {
    sessionId: string | null
    requestId: string | null
  }
  userIntent: TurnUserIntent
  skill: TurnFrameSkillSlice | null
  liveness: TurnFrameLiveness
  progress: {
    stage: string | null
    totalUnits: number | null
    completedUnits: number | null
    coverageRatio: number | null
    fingerprint: string | null
  }
  steering: {
    mode: 'none' | 'ask_model' | 'force_tool' | 'checkpoint' | 'finish'
    requiredToolName: string | null
    preferredToolNames: string[]
    systemReminder: string | null
  }
  budget: {
    leaseEndIteration: number | null
    hardCapIteration: number | null
    exhausted: boolean
  }
  terminalReason: TurnTerminalReason | null
}

export function summarizeTurnFrame(frame: TurnFrame | null): Record<string, unknown> | null {
  if (!frame) return null
  return {
    sessionId: frame.ids.sessionId,
    requestId: frame.ids.requestId,
    skillId: frame.skill?.skillId || null,
    source: frame.skill?.source || null,
    hasRunState: Boolean(frame.skill?.runStatePath),
    hasOutputDir: Boolean(frame.skill?.outputDir),
    liveness: frame.liveness,
    terminalReason: frame.terminalReason,
  }
}
