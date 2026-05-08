export type TaskOperationIntentKind =
  | 'continue_existing'
  | 'restart_same_goal'
  | 'repair_config'
  | 'inspect_progress'
  | 'unknown'

export interface TaskOperationIntent {
  kind: TaskOperationIntentKind
  confidence: 'high' | 'medium' | 'low'
  signals: string[]
}

type OperationSignalKind = 'reset' | 'keep'

const OPERATION_SIGNAL_PATTERNS: ReadonlyArray<{
  readonly kind: OperationSignalKind
  readonly label: string
  readonly weight: number
  readonly pattern: RegExp
}> = [
  {
    kind: 'reset',
    label: 'reset_boundary',
    weight: 3,
    pattern: /(?:从头|start\s+over|from\s+scratch|清(?:掉|空|除).{0,8}(?:进度|状态|上下文)|(?:进度|状态|上下文).{0,8}(?:归零|清空|清掉))/i,
  },
  {
    kind: 'reset',
    label: 'repeat_execution',
    weight: 3,
    pattern: /(?:重新|重做|重跑|再跑|再执行|再来(?:一遍|一次|一轮|一下)?|rerun|restart)/i,
  },
  {
    kind: 'reset',
    label: 'same_goal_reference',
    weight: 1,
    pattern: /(?:这(?:个|次)?任务|当前任务|刚才(?:的)?(?:目标|任务)|同(?:一|样)(?:目标|任务)|same\s+(?:goal|task))/i,
  },
  {
    kind: 'keep',
    label: 'continue_progress',
    weight: 3,
    pattern: /(?:继续|接着|恢复|continue|resume)/i,
  },
  {
    kind: 'keep',
    label: 'existing_progress',
    weight: 1,
    pattern: /(?:上次|未完成|暂停|已有(?:进度|结果)?|checkpoint|run_state)/i,
  },
]

function uniqueTexts(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

function scoreOperationSignals(text: string): { resetScore: number; keepScore: number; signals: string[] } {
  let resetScore = 0
  let keepScore = 0
  const signals: string[] = []
  for (const entry of OPERATION_SIGNAL_PATTERNS) {
    if (!entry.pattern.test(text)) continue
    signals.push(entry.label)
    if (entry.kind === 'reset') {
      resetScore += entry.weight
    } else {
      keepScore += entry.weight
    }
  }
  return { resetScore, keepScore, signals }
}

export function resolveTaskOperationIntent(params: {
  texts: ReadonlyArray<string | null | undefined>
  retryOnlyTurnDetected: boolean
  configRepairTurnDetected: boolean
  progressFollowupTurnDetected: boolean
}): TaskOperationIntent {
  const texts = uniqueTexts(params.texts)
  const joined = texts.join('\n')
  const signals: string[] = []

  if (params.configRepairTurnDetected) {
    signals.push('config_repair')
    return { kind: 'repair_config', confidence: 'high', signals }
  }

  if (params.progressFollowupTurnDetected && !params.retryOnlyTurnDetected) {
    signals.push('progress_followup')
    return { kind: 'inspect_progress', confidence: 'medium', signals }
  }

  if (!params.retryOnlyTurnDetected) {
    return { kind: 'unknown', confidence: 'low', signals }
  }

  const scored = scoreOperationSignals(joined)
  signals.push(...scored.signals)

  if (scored.resetScore >= 3 && scored.resetScore > scored.keepScore) {
    return {
      kind: 'restart_same_goal',
      confidence: scored.resetScore >= 5 ? 'high' : 'medium',
      signals,
    }
  }

  return {
    kind: 'continue_existing',
    confidence: scored.keepScore >= 3 ? 'high' : 'medium',
    signals,
  }
}
