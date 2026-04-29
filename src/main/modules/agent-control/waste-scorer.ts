import { createHash } from 'node:crypto'
import type { ToolExecutionOutput } from './tool-result-types'
import type { RecoveryRecord, TurnToolCall } from './run-contracts'

export interface SkillWasteScore {
  score: number
  reasons: string[]
  repeatedUnchangedObservation: boolean
  repeatedRecoverableError: boolean
  repeatedToolCallStreak: number
  recoverableErrorKind: string | null
  recoverableErrorCount: number
}
export interface SkillWasteScorerInput {
  toolCalls?: Array<Pick<TurnToolCall, 'name' | 'input'>>
  recentToolCalls?: Array<{ name: string; argsHash: string }>
  executedTools?: Array<{
    name: string
    input?: Record<string, unknown>
    result?: ToolExecutionOutput | null
  }>
  recoveryHistory?: RecoveryRecord[]
  currentFingerprint?: string | null
  previousFingerprint?: string | null
  preferredTypedSkillToolName?: string | null
}

function hashInput(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16)
}

function errorKindFromOutput(output?: ToolExecutionOutput | null): string | null {
  const data = output?.data
  if (!data || typeof data !== 'object') return null
  const kind = (data as Record<string, unknown>).errorKind
  return typeof kind === 'string' && kind.trim() ? kind.trim() : null
}

function isRepeatableObservationTool(name: string): boolean {
  return name === 'skill_inspect_run_state' || name === 'skill_read_artifact'
}

function isRecoverableLoopError(kind: string): boolean {
  return [
    'input_validation',
    'command_parse_failed',
    'cmd_not_allowlisted',
    'auth',
    'quota',
    'rate_limit',
  ].includes(kind)
}

function longestTrailingKindStreak(kinds: string[]): { kind: string | null; count: number } {
  const last = kinds[kinds.length - 1] || null
  if (!last) return { kind: null, count: 0 }
  let count = 0
  for (let index = kinds.length - 1; index >= 0; index -= 1) {
    if (kinds[index] !== last) break
    count += 1
  }
  return { kind: last, count }
}

export function scoreSkillWaste(input: SkillWasteScorerInput): SkillWasteScore {
  const reasons: string[] = []
  let score = 0
  const recent = [...(input.recentToolCalls || [])]
  for (const toolCall of input.toolCalls || []) {
    recent.push({ name: toolCall.name, argsHash: hashInput(toolCall.input) })
  }
  const last = recent[recent.length - 1]
  let repeatedToolCallStreak = 0
  if (last) {
    repeatedToolCallStreak = recent.filter((item) => item.name === last.name && item.argsHash === last.argsHash).length
    if (repeatedToolCallStreak >= 3) {
      score += 2
      reasons.push('repeated_tool_call')
    }
  }
  if (
    input.preferredTypedSkillToolName
    && last?.name === 'skill_run_shell'
    && recent.filter((item) => item.name === 'skill_run_shell').length >= 2
  ) {
    score += 2
    reasons.push('shell_loop_while_typed_action_preferred')
  }

  const repeatedObservation = Boolean(
    input.currentFingerprint
      && input.previousFingerprint
      && input.currentFingerprint === input.previousFingerprint
      && (input.executedTools || []).some((tool) => isRepeatableObservationTool(tool.name)),
  )
  if (repeatedObservation) {
    score += 2
    reasons.push('unchanged_run_state_or_artifact')
  }

  const toolErrorKinds = (input.executedTools || [])
    .map((tool) => errorKindFromOutput(tool.result))
    .filter((kind): kind is string => Boolean(kind))
  const recoveryKinds = (input.recoveryHistory || []).map((item) => item.kind)
  const recoverableKinds = [...toolErrorKinds, ...recoveryKinds]
    .filter((kind) => isRecoverableLoopError(kind))
  const recoverableStreak = longestTrailingKindStreak(recoverableKinds)
  const repeatedError = recoverableStreak.count >= 3
  if (repeatedError) {
    score += 2
    reasons.push('recoverable_error_repeated')
  }

  return {
    score,
    reasons,
    repeatedUnchangedObservation: repeatedObservation,
    repeatedRecoverableError: repeatedError,
    repeatedToolCallStreak,
    recoverableErrorKind: recoverableStreak.kind,
    recoverableErrorCount: recoverableStreak.count,
  }
}
