import { createHash } from 'crypto'

import { getStaticSkillToolNameForAction } from '../tools/skills-tools-static'
import { resolveToolInputSchemaForExecution } from './tool-registry'
import { createSystemReminderRegistry } from './system-reminder-registry'
import { logAgentMetric } from './metrics'
import { resolveCanonicalChildRunHandle } from './child-run-handle-resolver'
import { resolvePendingSkillHandoffWriteTargets } from './skill-agent-handoff'
import type { FrameAction, TurnFrame, TurnFrameLiveness, TurnFrameMode } from './turn-frame'
import type { SkillRunContract } from './run-contracts'
import { isTerminalChildCloseStatus } from './skill-child-run-types'

export const FRAME_STEERING_PRIMITIVE_TOOL_NAMES = [
  'skill_inspect_run_state',
  'skill_read_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_ask_user',
] as const

const CHILD_FRAME_STEERING_PRIMITIVE_TOOL_NAMES = [
  'skill_inspect_run_state',
  'skill_read_artifact',
  'skill_ask_user',
] as const

const SKILL_START_PRIMITIVE_TOOL_NAMES = [
  'skill_ask_user',
] as const

// Phase 6 — VEA's `video_expert_pipeline` was the legacy parent-force
// fallback action for `mode='skill_resume'` frames missing an explicit
// action. The child-loop runner now owns VEA execution, so the parent
// must never synthesize this typed action with `{}`. Other skills that
// still rely on the legacy parent-force route may register here; VEA
// MUST NOT.
const DEFAULT_RESUME_ACTION_BY_SKILL_ID: Record<string, string> = {}

/**
 * Stage 7 — extra signals the caller may pass when re-evaluating steering
 * inside the iteration loop. Today the only signal is whether the previous
 * iteration already force-dispatched the same typed action; if it did, we
 * fall back to `ask_model` so we can never enter an infinite force loop.
 */
export interface BuildSteeringExtras {
  /**
   * `true` when the immediately preceding iteration force-dispatched the
   * typed skill action that this frame would otherwise force again. Caller
   * is responsible for tracking this at the turn level.
   */
  recentForceToolDispatched?: boolean
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Stage E — deterministic digest over a forced-tool input. Used as the
 * cross-turn key for `runContract.forceLoopGuard`: when the same
 * `(toolName, inputDigest)` repeats consecutively the engine checkpoints
 * instead of dispatching again.
 *
 * Stable JSON-stringify over sorted object keys so two structurally-equal
 * inputs always produce the same digest regardless of property iteration
 * order. `null` / non-object inputs hash a sentinel so we never collide with
 * `{}`.
 */
export function computeForceInputDigest(input: Record<string, unknown> | null): string {
  if (!input || typeof input !== 'object') {
    return createHash('sha1').update('null').digest('hex').slice(0, 16)
  }
  const stable = stableStringify(input)
  return createHash('sha1').update(stable).digest('hex').slice(0, 16)
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
  )
  return `{${parts.join(',')}}`
}

/**
 * Stage E — derive a forced typed-action input from the durable
 * `SkillRunContract`. Strategy:
 *   1. Prefer `runContract.actionInput` (typed action wrapper produced
 *      validated input on a previous turn — Delta's Wave 2 emission).
 *   2. Otherwise rebuild a best-effort partial from contract fields keyed
 *      by action name (VEA pipeline → `url`, score-batch → `sceneScoresPath`,
 *      deliver → `deliveryReportPath`, plus durable handles + outputDir).
 *
 * The returned object is then preflight-validated against the same Zod
 * schema the dispatch path uses (`getToolInputSchemas()`). Missing required
 * fields surface in `missingInputs[]` so the engine can checkpoint instead
 * of calling the tool with `{}`.
 */
export function deriveForcedActionInput(params: {
  toolName: string
  contract: SkillRunContract | null
  frame: TurnFrame
}): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const contract = params.contract
  const frame = params.frame
  // Wave 2 happy path: typed action wrapper already validated and serialised
  // an actionInput for us. Spread it first so subsequent contract fields can
  // ONLY fill blanks (never override what we already validated).
  if (contract?.actionInput && typeof contract.actionInput === 'object') {
    Object.assign(out, contract.actionInput)
  }
  // Original input (the user/source request) backfills fields the typed
  // wrapper hasn't published yet (e.g. fresh resume on a new session).
  if (contract?.originalInput && typeof contract.originalInput === 'object') {
    for (const [k, v] of Object.entries(contract.originalInput)) {
      if (out[k] == null) out[k] = v
    }
  }
  const action = nonEmpty(contract?.action) || nonEmpty(frame.skill?.action) || null
  const sceneScoresPath = nonEmpty(contract?.artifactPaths?.sceneScoresPath)
    || nonEmpty(frame.skill?.artifactPaths?.sceneScoresPath)
  const deliveryReportPath = nonEmpty(contract?.artifactPaths?.deliveryReportPath)
    || nonEmpty(frame.skill?.artifactPaths?.deliveryReportPath)
  const outputDir = nonEmpty(contract?.outputDir) || nonEmpty(frame.skill?.outputDir)
  const runStatePath = nonEmpty(contract?.runStatePath) || nonEmpty(frame.skill?.runStatePath)
  const sourceUrl = nonEmpty(contract?.sourceUrl)
  const taskRunId = nonEmpty(contract?.taskRunId) || nonEmpty(frame.skill?.taskRunId)
  const detachedTaskId = nonEmpty(contract?.detachedTaskId) || nonEmpty(frame.skill?.detachedTaskId)
  const jobId = nonEmpty(contract?.jobId)
  // Per-action contract → input field projection. Only fill fields the
  // schema knows about; other action types fall back to actionInput-only.
  if (action === 'video_expert_pipeline') {
    if (out.url == null && sourceUrl) out.url = sourceUrl
    if (out.outputDir == null && outputDir) out.outputDir = outputDir
  } else if (action === 'video_expert_ai_analyze' || action === 'video_expert_score_batch') {
    if (out.sceneScoresPath == null && sceneScoresPath) out.sceneScoresPath = sceneScoresPath
    if (out.outputDir == null && outputDir) out.outputDir = outputDir
  } else if (action === 'video_expert_deliver' || action === 'video_expert_finalize') {
    if (out.deliveryReportPath == null && deliveryReportPath) out.deliveryReportPath = deliveryReportPath
    if (out.outputDir == null && outputDir) out.outputDir = outputDir
  }
  // Universal handle backfills — only set when not already populated AND
  // the schema actually accepts the field. Schema accept-check happens at
  // validateForcedActionInput; here we just publish the candidates.
  void runStatePath
  void taskRunId
  void detachedTaskId
  void jobId
  return out
}

/**
 * Stage E — preflight-validate a forced-tool input against the same Zod
 * schema the dispatch path uses (`tool-executor` → `validateToolInput`).
 *
 * Returns either `{ ok: true, data }` (matching the validator's contract)
 * or a list of missing-required field paths the engine should surface in
 * `FrameAction.missingInputs[]`.
 *
 * NOTE: We deliberately do not import `validateToolInput` here to avoid
 * circular module deps; the contract is identical because both code paths
 * resolve the same schema via `resolveToolInputSchemaForExecution()` —
 * Phase 2 (B plan child-loop) collapsed dispatch / preflight / steering
 * onto that single resolver so the dynamic skill-action cache is no longer
 * invisible to the steering validator.
 */
export function validateForcedActionInput(
  toolName: string,
  input: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; missingInputs: string[] } {
  const schema = resolveToolInputSchemaForExecution(toolName)
  if (!schema) {
    // Same passthrough behaviour as the validator: tools without a registered
    // schema cannot have missing inputs from our perspective.
    return { ok: true, data: input }
  }
  const parsed = schema.safeParse(input)
  if (parsed.success) {
    return { ok: true, data: parsed.data as Record<string, unknown> }
  }
  // Collect schema paths from the issues. Empty path means a top-level
  // mismatch we can't translate into a missing field; record it as '(root)'.
  const missing = new Set<string>()
  for (const issue of parsed.error.issues) {
    const path = Array.isArray(issue.path) && issue.path.length > 0
      ? issue.path.map((segment) => String(segment)).join('.')
      : '(root)'
    missing.add(path)
  }
  return { ok: false, missingInputs: Array.from(missing) }
}

/**
 * Stage E — build the explicit `FrameAction` to attach to
 * `frame.steering.action`. Returns null when the engine should not force
 * a tool dispatch (no skill, no typed tool, terminal liveness, etc.).
 *
 * For every forceable frame we ALWAYS produce a FrameAction even when input
 * is incomplete: missing inputs surface in `missingInputs[]` and the engine
 * downgrades the action to a checkpoint without ever dispatching `{}`.
 */
export function buildFrameAction(params: {
  frame: TurnFrame
  decidedMode: TurnFrame['steering']['mode']
  toolName: string | null
}): FrameAction | null {
  const { frame, decidedMode, toolName } = params
  if (decidedMode === 'finish' || decidedMode === 'none') return null
  if (decidedMode === 'checkpoint') {
    return {
      mode: 'checkpoint',
      toolName: null,
      input: null,
      inputDigest: null,
      reason: frame.skill && frame.liveness === 'failed'
        ? 'skill_failed'
        : frame.budget?.exhausted
          ? 'budget_exhausted'
          : 'checkpoint',
      missingInputs: [],
    }
  }
  if (!toolName) {
    return {
      mode: 'ask_model',
      toolName: null,
      input: null,
      inputDigest: null,
      reason: 'no_typed_tool',
      missingInputs: [],
    }
  }
  const contract = frame.skill?.runContract || null
  const candidateInput = deriveForcedActionInput({ toolName, contract, frame })
  const actionName = nonEmpty(contract?.action) || nonEmpty(frame.skill?.action)
  const handle = resolveCanonicalChildRunHandle({
    skillId: frame.skill?.skillId,
    action: actionName,
    requestedInput: candidateInput,
    contract,
    frame,
  })
  if (!handle.ok) {
    return {
      mode: 'checkpoint',
      toolName,
      input: handle.input,
      inputDigest: computeForceInputDigest(handle.input),
      reason: handle.reason,
      missingInputs: [handle.reason],
    }
  }
  const dispatchInput = handle.input
  const validated = validateForcedActionInput(toolName, dispatchInput)
  if (!validated.ok) {
    // Required fields missing → caller will checkpoint instead of dispatch.
    const reason = validated.missingInputs.length > 0
      ? `missing_${validated.missingInputs[0]}`
      : 'input_validation_failed'
    return {
      mode: 'checkpoint',
      toolName,
      input: dispatchInput,
      inputDigest: computeForceInputDigest(dispatchInput),
      reason,
      missingInputs: validated.missingInputs,
    }
  }
  // Schema parse succeeded — input is dispatch-ready.
  return {
    mode: decidedMode === 'force_tool' ? 'force_tool' : 'ask_model',
    toolName,
    input: validated.data,
    inputDigest: computeForceInputDigest(validated.data),
    reason: decidedMode === 'force_tool' ? 'force_tool_resume' : 'preferred_tool',
    missingInputs: [],
  }
}

function shouldResolveTypedToolForForceMode(
  frame: TurnFrame,
  extras?: BuildSteeringExtras,
): boolean {
  if (extras?.recentForceToolDispatched) return false
  if (!frame.skill) return false
  if (isChildOwnedFrame(frame)) return false
  if (!FORCE_TOOL_LIVENESS_MODES.includes(frame.mode)) return false
  if (!FORCE_TOOL_LIVENESS_STATES.includes(frame.liveness)) return false
  if (frame.skill && frame.liveness === 'failed') return false
  if (frame.budget.exhausted && frame.liveness === 'running_process') return false
  return true
}

export function resolveTurnFrameSkillActionToolName(
  frame: TurnFrame,
  options?: { emitBlockedMetric?: boolean },
): string | null {
  const skillId = nonEmpty(frame.skill?.skillId)
  if (!skillId) return null
  const action = nonEmpty(frame.skill?.action)
    || (frame.mode === 'skill_resume' ? DEFAULT_RESUME_ACTION_BY_SKILL_ID[skillId] : null)
  if (!action) return null
  if (action.startsWith('skill_')) return action
  const staticToolName = getStaticSkillToolNameForAction(skillId, action)
  if (staticToolName) return staticToolName
  if (options?.emitBlockedMetric !== false) {
    logAgentMetric('preferred_tool_name_synthesis_blocked', { skillId, action })
  }
  return null
}

/**
 * Phase 6 (Wave 3 — T5) — child-loop ownership signals.
 *
 * When `frame.skill?.runContract?.childRunId` is set AND there is no
 * terminal close event attached, the child runner now owns "what action
 * runs next" for this skill. Parent steering MUST NOT surface the typed
 * VEA action (e.g. `skill_video_expert_pipeline`) in `preferredToolNames`,
 * MUST NOT enter `force_tool` mode, and MUST NOT set `requiredToolName`.
 *
 * A close event whose `status` is one of `completed | failed | killed` is
 * terminal. `recoverable_paused | budget_paused | blocked` close events
 * are non-terminal — the run is paused and may resume — so the child is
 * still considered the owner and steering still excludes the typed action.
 */
export function hasTerminalChildCloseEvent(
  contract: SkillRunContract | null | undefined,
): boolean {
  const close = contract?.childCloseEvent
  if (!close || typeof close !== 'object') return false
  return isTerminalChildCloseStatus(close.status)
}

export function isChildOwnedFrame(frame: TurnFrame): boolean {
  const childRunId = frame.skill?.runContract?.childRunId
  if (typeof childRunId !== 'string' || childRunId.trim().length === 0) {
    return false
  }
  // Once the child has terminally closed, parent steering may resume
  // surfacing typed actions for follow-on user turns. Until then the
  // child runner owns the resume.
  return !hasTerminalChildCloseEvent(frame.skill?.runContract ?? null)
}

function shouldPreferTypedAction(frame: TurnFrame): boolean {
  if (!frame.skill) return false
  // Phase 6 — child-loop runner owns the resume for child-owned frames.
  if (isChildOwnedFrame(frame)) return false
  if (frame.mode === 'skill_start') return true
  if (frame.mode !== 'skill_resume' && frame.mode !== 'skill_repair') return false
  return frame.liveness === 'recoverable_paused'
    || frame.liveness === 'ready_to_resume'
    || frame.liveness === 'blocked'
    || frame.liveness === 'recent_progress'
    || frame.liveness === 'unknown'
}

function preferredPrimitiveToolNamesForFrame(frame: TurnFrame): ReadonlyArray<string> {
  if (frame.mode === 'skill_start') return SKILL_START_PRIMITIVE_TOOL_NAMES
  return FRAME_STEERING_PRIMITIVE_TOOL_NAMES
}

const FORCE_TOOL_LIVENESS_MODES: ReadonlyArray<TurnFrameMode> = [
  'skill_resume',
  'skill_repair',
  'skill_start',
]

const FORCE_TOOL_LIVENESS_STATES: ReadonlyArray<TurnFrameLiveness> = [
  'recoverable_paused',
  'ready_to_resume',
  'blocked',
]

/**
 * Stage 7 — pick the steering mode for the current frame.
 *
 * `force_tool` — frame is a skill resume/repair/start with a recoverable
 *   typed action that we want the next iteration to invoke deterministically
 *   instead of letting the model decide. `recent_progress` is intentionally
 *   excluded because work may already be progressing in the loop. `blocked`
 *   is forceable only after the normal FrameAction preflight proves the
 *   typed action has enough durable input; missing input downgrades to
 *   checkpoint before dispatch.
 *
 * `checkpoint` — budget exhausted with a still-live background worker, OR
 *   skill terminal `failed`. Both cases mean "stop, return to user."
 *
 * `ask_model` — default; current behavior unchanged.
 *
 * The `recentForceToolDispatched` extra prevents force-loops: if we just
 * force-dispatched the same tool, fall back to ask_model so the model can
 * pivot.
 */
export function selectSteeringMode(
  frame: TurnFrame,
  extras?: BuildSteeringExtras,
): TurnFrame['steering']['mode'] {
  // Checkpoint conditions take priority — once we're terminal or out of
  // budget there's nothing to force.
  if (frame.skill && frame.liveness === 'failed') return 'checkpoint'
  if (frame.budget.exhausted && frame.liveness === 'running_process') return 'checkpoint'

  if (extras?.recentForceToolDispatched) return 'ask_model'

  if (!frame.skill) return 'ask_model'
  // Phase 6 — child-loop runner owns the resume; never parent-force the
  // typed action when a child run is in flight.
  if (isChildOwnedFrame(frame)) return 'ask_model'
  if (!FORCE_TOOL_LIVENESS_MODES.includes(frame.mode)) return 'ask_model'
  if (!FORCE_TOOL_LIVENESS_STATES.includes(frame.liveness)) return 'ask_model'

  // Need a resolvable typed action to force, otherwise fall back.
  const typedToolName = resolveTurnFrameSkillActionToolName(frame)
  if (!typedToolName) return 'ask_model'

  return 'force_tool'
}

export function buildTurnFrameSteering(
  frame: TurnFrame,
  extras?: BuildSteeringExtras,
): TurnFrame['steering'] {
  const decidedMode = selectSteeringMode(frame, extras)

  if (decidedMode === 'checkpoint') {
    const reason = frame.skill && frame.liveness === 'failed'
      ? '系统补充：技能任务已失败，本轮进入 checkpoint，等待用户后续指令；不要继续工具循环。'
      : '系统补充：本轮预算已用尽且后台仍在运行，进入 checkpoint 让用户决定是否继续；不要再发起工具调用。'
    const registry = createSystemReminderRegistry()
    registry.register({ topic: 'checkpoint', priority: 100, text: reason })
    return {
      mode: 'checkpoint',
      requiredToolName: null,
      preferredToolNames: [],
      systemReminder: registry.compose(),
      action: buildFrameAction({ frame, decidedMode: 'checkpoint', toolName: null }),
    }
  }

  // Phase 6 — child-loop ownership steering. When a child run is in
  // flight (childRunId set, no terminal close), the parent MUST NOT
  // surface the typed VEA action. Steering keeps primitives available
  // (so the model can probe state with `skill_inspect_run_state` etc.)
  // and emits an explicit child-aware reminder so the model never
  // re-derives a typed call from the contract handles.
  if (isChildOwnedFrame(frame)) {
    const childRunId = frame.skill?.runContract?.childRunId || ''
    const childStatus = frame.skill?.runContract?.childStatus || null
    const hasPendingHandoffWrite = resolvePendingSkillHandoffWriteTargets(frame.activeArtifactRoots).length > 0
    const reminderTokens = [
      `系统补充：本轮 skill 已由 child-loop runner 接管（childRunId=${childRunId}${childStatus ? `, status=${childStatus}` : ''}）。父循环只处理 status / resume / cancel，并等待 child close event。`,
      hasPendingHandoffWrite
        ? '如需观察状态，只使用 skill_inspect_run_state / skill_read_artifact；如果当前输出目录里有待 agent 完成的 handoff 任务，可用 skill_write_artifact 写入该任务声明的输出文件；需要用户选择时再用 skill_ask_user。不要重新发起该 skill 的动作工具。'
        : '如需观察状态，只使用 skill_inspect_run_state / skill_read_artifact；需要用户选择时再用 skill_ask_user。不要重新发起该 skill 的动作工具。',
    ]
    const reminderText = reminderTokens.join('\n')
    const registry = createSystemReminderRegistry()
    registry.register({ topic: 'child-owned', priority: 85, text: reminderText })
    const preferredToolNames = hasPendingHandoffWrite
      ? [...CHILD_FRAME_STEERING_PRIMITIVE_TOOL_NAMES, 'skill_write_artifact']
      : [...CHILD_FRAME_STEERING_PRIMITIVE_TOOL_NAMES]
    return {
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames,
      systemReminder: registry.compose(),
      action: buildFrameAction({ frame, decidedMode: 'ask_model', toolName: null }),
    }
  }

  const typedToolName = shouldPreferTypedAction(frame)
    ? resolveTurnFrameSkillActionToolName(frame, {
        emitBlockedMetric: !shouldResolveTypedToolForForceMode(frame, extras),
      })
    : null

  if (!typedToolName) {
    const preferredToolNames = frame.skill
      ? [...preferredPrimitiveToolNamesForFrame(frame)]
      : []
    return {
      ...frame.steering,
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames,
      systemReminder: null,
      action: buildFrameAction({ frame, decidedMode: 'ask_model', toolName: null }),
    }
  }

  const preferredToolNames = Array.from(new Set([
    typedToolName,
    ...preferredPrimitiveToolNamesForFrame(frame),
  ]))
  const handleText = [
    frame.skill?.outputDir ? `outputDir=${frame.skill.outputDir}` : '',
    frame.skill?.runStatePath ? `runStatePath=${frame.skill.runStatePath}` : '',
  ].filter(Boolean).join(' ')

  if (decidedMode === 'force_tool') {
    const action = buildFrameAction({ frame, decidedMode: 'force_tool', toolName: typedToolName })
    // Stage E — when input synthesis surfaces missing required fields, the
    // FrameAction switches mode to 'checkpoint' so the engine never dispatches
    // an empty `{}`. Mirror that decision into the legacy `steering.mode` so
    // the existing dispatch-eligibility check at the engine still skips
    // force_tool dispatch deterministically.
    if (action && action.mode === 'checkpoint') {
      const missing = action.missingInputs.length > 0
        ? `缺少必需字段：${action.missingInputs.join(', ')}`
        : action.reason
      const systemReminder = [
        `系统补充：本轮 TurnFrame 想强制调用 ${typedToolName}，但运行契约里缺少必需输入（${missing}）。`,
        '请先补齐必要参数（例如 url / sceneScoresPath / outputDir），或调用 skill_inspect_run_state / skill_read_artifact 探查产出，再重新尝试。',
        handleText,
      ].filter(Boolean).join('\n')
      const registry = createSystemReminderRegistry()
      registry.register({ topic: 'force-tool-missing', priority: 90, text: systemReminder })
      return {
        mode: 'checkpoint',
        requiredToolName: null,
        preferredToolNames,
        systemReminder: registry.compose(),
        action,
      }
    }
    const systemReminder = [
      `系统补充：本轮 TurnFrame 已锁定 force_tool 模式，必须直接调用 typed skill action ${typedToolName} 推进任务。`,
      '不要再用 skill_inspect_run_state / skill_read_artifact / skill_run_shell 做诊断；不要先解释、再决定下一步——直接发起 typed action 调用。',
      handleText,
    ].filter(Boolean).join('\n')
    const registry = createSystemReminderRegistry()
    registry.register({ topic: 'force-tool-locked', priority: 80, text: systemReminder })
    return {
      mode: 'force_tool',
      requiredToolName: typedToolName,
      preferredToolNames,
      systemReminder: registry.compose(),
      action,
    }
  }

  const systemReminder = [
    `系统补充：当前 TurnFrame 已确认本轮是 skill continuation，优先调用 typed skill action ${typedToolName} 推进任务。`,
    'skill_run_shell 只用于必要诊断；不要用 shell 反复读取同一份 run_state 或脚本目录来替代 typed skill action。',
    handleText,
  ].filter(Boolean).join('\n')
  const registry = createSystemReminderRegistry()
  registry.register({ topic: 'typed-action-preferred', priority: 30, text: systemReminder })

  return {
    mode: 'ask_model',
    requiredToolName: null,
    preferredToolNames,
    systemReminder: registry.compose(),
    action: buildFrameAction({ frame, decidedMode: 'ask_model', toolName: typedToolName }),
  }
}

export function applySteeringToTurnFrame(
  frame: TurnFrame,
  extras?: BuildSteeringExtras,
): TurnFrame {
  return {
    ...frame,
    steering: buildTurnFrameSteering(frame, extras),
  }
}
