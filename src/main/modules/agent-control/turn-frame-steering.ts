import { getStaticSkillToolNameForAction } from '../tools/skills-tools-static'
import type { TurnFrame } from './turn-frame'

export const FRAME_STEERING_PRIMITIVE_TOOL_NAMES = [
  'skill_inspect_run_state',
  'skill_read_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_ask_user',
] as const

const DEFAULT_RESUME_ACTION_BY_SKILL_ID: Record<string, string> = {
  'video-expert-analyzer': 'video_expert_pipeline',
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sanitizeToolToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'skill'
}

function fallbackToolName(skillId: string, actionName: string): string {
  return `skill_${sanitizeToolToken(skillId)}_${sanitizeToolToken(actionName)}`
}

export function resolveTurnFrameSkillActionToolName(frame: TurnFrame): string | null {
  const skillId = nonEmpty(frame.skill?.skillId)
  if (!skillId) return null
  const action = nonEmpty(frame.skill?.action)
    || (frame.mode === 'skill_resume' ? DEFAULT_RESUME_ACTION_BY_SKILL_ID[skillId] : null)
  if (!action) return null
  if (action.startsWith('skill_')) return action
  return getStaticSkillToolNameForAction(skillId, action) || fallbackToolName(skillId, action)
}

function shouldPreferTypedAction(frame: TurnFrame): boolean {
  if (!frame.skill) return false
  if (frame.mode === 'skill_start') return true
  if (frame.mode !== 'skill_resume' && frame.mode !== 'skill_repair') return false
  return frame.liveness === 'recoverable_paused'
    || frame.liveness === 'ready_to_resume'
    || frame.liveness === 'blocked'
    || frame.liveness === 'recent_progress'
    || frame.liveness === 'unknown'
}

export function buildTurnFrameSteering(frame: TurnFrame): TurnFrame['steering'] {
  const typedToolName = shouldPreferTypedAction(frame)
    ? resolveTurnFrameSkillActionToolName(frame)
    : null
  if (!typedToolName) {
    return {
      ...frame.steering,
      preferredToolNames: [],
      systemReminder: null,
    }
  }
  const preferredToolNames = Array.from(new Set([
    typedToolName,
    ...FRAME_STEERING_PRIMITIVE_TOOL_NAMES,
  ]))
  const handleText = [
    frame.skill?.outputDir ? `outputDir=${frame.skill.outputDir}` : '',
    frame.skill?.runStatePath ? `runStatePath=${frame.skill.runStatePath}` : '',
  ].filter(Boolean).join(' ')
  const systemReminder = [
    `系统补充：当前 TurnFrame 已确认本轮是 skill continuation，优先调用 typed skill action ${typedToolName} 推进任务。`,
    'skill_run_shell 只用于必要诊断；不要用 shell 反复读取同一份 run_state 或脚本目录来替代 typed skill action。',
    handleText,
  ].filter(Boolean).join('\n')

  return {
    mode: 'ask_model',
    requiredToolName: null,
    preferredToolNames,
    systemReminder,
  }
}

export function applySteeringToTurnFrame(frame: TurnFrame): TurnFrame {
  return {
    ...frame,
    steering: buildTurnFrameSteering(frame),
  }
}
