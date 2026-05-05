import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ZodObject, ZodRawShape } from 'zod'
import { getSkillsRuntimeManager, type SkillState } from '../skills-runtime/runtime-manager'
import { rememberSkillRun } from '../agent-control/session-continuity'
import { resolveActiveSkillContext } from '../agent-control/active-skill-context'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tool-result-types'
import {
  buildContractFramePatch,
  loadSkillRunContract,
  type SkillRunContract,
} from '../agent-control/run-contracts'
import {
  startSkillChildRun,
} from '../agent-control/skill-child-runner'
import type {
  SkillTaskSupervisorLiveness,
  SkillTaskSupervisorSnapshot,
} from '../agent-control/skill-task-supervisor'
import type { TurnFramePatch } from '../agent-control/turn-frame'
import {
  getLatestActiveSkillTaskRun,
  hasActiveSkillTaskRun,
  isSkillTaskProjectionLive,
  readSkillTaskProjection,
  recordSkillTaskEvent,
  type SkillTaskEventStatus,
} from '../agent-control/skill-task-tracker'
import { getDetachedSkillTaskTracker } from '../agent-control/detached-skill-task-tracker'
import type {
  SkillActionDefinition,
  SkillInputValue,
} from '../../../shared/skill-execution-types'
import {
  STATIC_SKILL_TOOL_NAMES as STATIC_SKILL_TOOL_NAMES_PURE,
  STATIC_SKILL_TOOL_NAMES_BOOT_SAFE,
} from './skills-tools-static'
import { getLastReferenceSkill } from '../agent-control/skill-reference-hints'
import {
  fallbackThrottle,
  type SkillToolFallbackEntry,
  type SkillToolFallbackReason,
} from '../agent-control/skill-tool-fallback-throttle'
// Stage 4 W3b — authorization-driven primitive skillId resolution.
import {
  SKILL_TOOL_AUTHORIZATION_NOT_SET,
  type SkillToolAuthorization,
} from '../agent-control/skill-tool-authorization'
import { resolvePendingSkillHandoffWriteTargets } from '../agent-control/skill-agent-handoff'
import { isChildLoopSkillAction } from './child-loop-skill-actions'
import { choosePrimitiveSkillId, filterSkillPrimitivesBySession } from './skill-tool-session-gate'
import { PRIMITIVE_TOOL_DEFS } from './skill-primitives/tool-defs'
import {
  executeAskUser,
  executeInspectRunState,
  executePatchConfig,
  executeReadArtifact,
  executeRunShell,
  executeWriteArtifact,
} from './skill-primitives'
import { SHELL_ALLOWLIST } from './skill-primitives/run-shell'
import { getAskUserQuestionEmitter } from '../agent-control/ask-user-bridge'
import { getSkillHostController } from '../skills-runtime/skill-host-controller'
import {
  toAnthropicTool,
  toOpenAITool,
  type SkillToolDef,
  type ToolParam,
} from './skill-tool-types'
import { paramListToZodObject } from './paramList-to-zod'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'

export { STATIC_SKILL_TOOL_NAMES_PURE as STATIC_SKILL_TOOL_NAMES }
export { isChildLoopSkillAction } from './child-loop-skill-actions'

interface SkillToolRuntimeContext {
  scopeId?: string
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  taskProjectionId?: string
  frameSkillId?: string | null
  agent?: string | null
  /**
   * Stage 4 W3b — per-turn skill tool authorization. Used by
   * `resolvePrimitiveSkillId` to derive the primitive's skillId from the
   * single-source-of-truth identity instead of the legacy hint / active
   * context / task run chain. The `'not_set'` default falls back to the
   * legacy chain for back-compat (W3a invokers that haven't been wired
   * through the cutover).
   */
  authorization?: SkillToolAuthorization
  /**
   * Phase 3 (skill-child-loop) — same-turn live frame slot forwarded from
   * the runtime. `skill_read_artifact` prefers `activeFrame.activeArtifactRoots`
   * over the legacy `resolveActiveSkillContext` derivation when populated, so
   * artifact roots emitted by an earlier tool in the same batch are
   * immediately readable.
   */
  activeFrame?: {
    activeArtifactRoots: string[]
    runContract: unknown
    discoveredHandles: Record<string, unknown>[]
  } | null
}

const STATIC_TOOL_NAMES: Record<string, string> = {
  'video-expert-analyzer:video_expert_pipeline': 'skill_video_expert_pipeline',
  'video-expert-analyzer:video_expert_ai_analyze': 'skill_video_expert_ai_analyze',
  'video-copy-analyzer:video_copy_analyze': 'skill_video_copy_analyze',
  'lets-go-rss:rss_add': 'skill_rss_add',
  'lets-go-rss:rss_update': 'skill_rss_update',
  'lets-go-rss:rss_status': 'skill_rss_status',
  'lets-go-rss:rss_list': 'skill_rss_list',
  'lets-go-rss:rss_stats': 'skill_rss_stats',
}

function sanitizeToolToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'skill'
}

function buildToolName(skillId: string, actionName: string): string {
  const staticName = STATIC_TOOL_NAMES[`${skillId}:${actionName}`]
  if (staticName) return staticName
  return `skill_${sanitizeToolToken(skillId)}_${sanitizeToolToken(actionName)}`
}

/**
 * T6 (B child-loop) — exported wrapper over the deterministic
 * `buildToolName` helper so the gateway executor (`tool-registry.ts`) can
 * resolve a (skillId, action) pair to the same tool name the public
 * dispatch path uses. Routing identical inputs through the same name keeps
 * the schema cache (`getSkillActionSchemas()`) authoritative for both the
 * model-facing typed dispatch and the child runner's internal action
 * dispatch. No new mapping table — same source of truth.
 */
export function buildSkillToolName(skillId: string, actionName: string): string {
  return buildToolName(skillId, actionName)
}

function buildSkillToolDescription(skill: SkillState, action: SkillActionDefinition): string {
  if (skill.executionMode === 'advisory' && action.runtime === 'reference') {
    return `读取并应用技能 ${skill.name} 的方法说明，再继续完成当前任务。${skill.description}`
  }
  return `${skill.name} · ${skill.description} · ${action.description}`
}

export function resolveSkillActionTimeoutMs(skill: Pick<SkillState, 'hostRequirements'>, action: Pick<SkillActionDefinition, 'timeoutMs'>): number | undefined {
  if (typeof action.timeoutMs === 'number' && Number.isFinite(action.timeoutMs) && action.timeoutMs > 0) {
    return action.timeoutMs
  }
  const declared = skill.hostRequirements?.default_action_timeout_ms
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
    ? declared
    : undefined
}

let skillActionToolDefsOverrideForTests: (() => SkillToolDef[]) | null = null

export function __setSkillActionToolDefsForTests(resolver: (() => SkillToolDef[]) | null): void {
  skillActionToolDefsOverrideForTests = resolver
  skillActionSchemaCache = {}
  skillActionSchemaSignature = ''
}

/**
 * skill-resume B2 — pure predicate for the visibility filter exception.
 * Exported for direct unit testing without mocking the runtime manager.
 *
 * Returns true if `action` should be exposed to the LLM under the current
 * reference-skill hint state. When the action is non-internal, always true.
 * When internal, true only when (a) hint armed for this exact skillId AND
 * (b) action name appears in the skill's expose_when_hint_armed whitelist.
 */
export function shouldExposeSkillAction(args: {
  actionVisibility: string
  actionName: string
  skillId: string
  referenceHintSkillId: string | null
  activeSkillId?: string | null
  exposeWhenHintArmed: string[]
}): boolean {
  if (args.actionVisibility !== 'internal') return true
  const contextSkillId = args.referenceHintSkillId || args.activeSkillId || null
  if (contextSkillId === null) return false
  if (contextSkillId !== args.skillId) return false
  return args.exposeWhenHintArmed.includes(args.actionName)
}

/**
 * skill-resume B2 — visibility filter respects expose_when_hint_armed.
 *
 * When the reference-skill hint is armed for a specific skill in the current
 * session AND that skill's host_requirements declares an action name in
 * `expose_when_hint_armed`, the action is exposed to the LLM even though it's
 * marked `visibility: 'internal'`. Used by video-expert-analyzer so that
 * `skill_video_expert_pipeline` becomes invokable on session resume (when the
 * hint is restored from chat_conversations.meta_json by A1).
 *
 * This is a NARROW exception: 3 conditions must all hold (hint armed, skill.id
 * matches the armed hint, action name appears in the manifest's whitelist).
 * Any other internal action stays hidden.
 */
function getSkillActionToolDefs(opts?: {
  referenceHintSkillId?: string | null
  activeSkillId?: string | null
  includeInternal?: boolean
}): SkillToolDef[] {
  if (skillActionToolDefsOverrideForTests) {
    return skillActionToolDefsOverrideForTests()
  }
  const manager = getSkillsRuntimeManager()
  const hintSkillId = opts?.referenceHintSkillId ?? null
  const activeSkillId = opts?.activeSkillId ?? null
  return manager.listSkills().flatMap((skill) => {
    const exposeWhenArmed = skill.hostRequirements?.expose_when_hint_armed ?? []
    return skill.actions
      .filter((action) => shouldExposeSkillAction({
        actionVisibility: opts?.includeInternal ? 'public' : (action.visibility ?? 'public'),
        actionName: action.name,
        skillId: skill.id,
        referenceHintSkillId: hintSkillId,
        activeSkillId,
        exposeWhenHintArmed: exposeWhenArmed,
      }))
      .map((action) => ({
        name: buildToolName(skill.id, action.name),
        description: buildSkillToolDescription(skill, action),
        kind: 'skill_action' as const,
        skillId: skill.id,
        action: action.name,
        visibility: action.visibility ?? 'public',
        timeoutMs: resolveSkillActionTimeoutMs(skill, action),
        params: action.params,
      }))
  })
}

// Dynamic-skill-action Zod schema cache (Phase 2.5 PR 12). Keyed by tool name
// (buildToolName is deterministic per (skillId, actionName)). Built lazily on
// first call and rebuilt when the underlying manifest set changes. Changes in
// skill set are detected via a cheap "signature" of name+action pairs — cheaper
// than subscribing to runtime-manager events and covers manifest reload, skill
// add/remove, and action visibility toggles.
let skillActionSchemaCache: Record<string, ZodObject<ZodRawShape>> = {}
let skillActionSchemaSignature = ''

function computeSkillActionSignature(defs: SkillToolDef[]): string {
  return defs
    .map((d) => `${d.name}:${d.params.length}:${d.params.map((p) => `${p.name}/${p.type}/${p.required?'1':'0'}`).join(',')}`)
    .sort()
    .join('|')
}

export function getSkillActionSchemas(
  fallbackEntry: SkillToolFallbackEntry = 'action_schemas_map',
  toolName?: string,
): Record<string, ZodObject<ZodRawShape>> {
  try {
    const defs = getSkillActionToolDefs({ includeInternal: true })
    const sig = computeSkillActionSignature(defs)
    if (sig !== skillActionSchemaSignature) {
      const next: Record<string, ZodObject<ZodRawShape>> = {}
      for (const def of defs) {
        if (def.kind !== 'skill_action') continue
        try {
          next[def.name] = paramListToZodObject(def.params)
        } catch {
          // If a malformed manifest breaks derivation, skip that one rather
          // than crashing the registry; static tools keep working.
        }
      }
      skillActionSchemaCache = next
      skillActionSchemaSignature = sig
    }
    return skillActionSchemaCache
  } catch {
    fallbackThrottle.emit({
      entry: fallbackEntry,
      reason: 'manager_throw',
      ...(toolName ? { toolName } : {}),
    })
    // Runtime manager unavailable (e.g. boot ordering) — return empty so the
    // registry falls through to static schemas only.
    return {}
  }
}

/**
 * Phase 4: skill_executions state machine retired. The 6 execution-control
 * tools (skill_get_state / skill_submit_* / skill_restart_from_step /
 * skill_cancel_execution) no longer exist. This builds the legacy candidate
 * list of skill_action tools + primitives; Stage 4 W3 authorization performs
 * the final model-visible filtering and primitive skillId selection.
 */
function getSkillToolDefs(sessionId?: string): SkillToolDef[] {
  const hasReferenceHint = (sid: string) => getLastReferenceSkill(sid) !== null
  const activeSkillContext = sessionId ? resolveActiveSkillContext({ sessionId }) : null
  const hasActiveSkillTaskProjection = (sid: string) =>
    isSkillTaskProjectionLive(readSkillTaskProjection({ sessionId: sid }))

  const primitiveTools = filterSkillPrimitivesBySession(
    PRIMITIVE_TOOL_DEFS,
    sessionId,
    // Phase 4: hasActiveExecution is permanently false — no execution state.
    () => false,
    hasReferenceHint,
    hasActiveSkillTaskProjection,
    hasActiveSkillTaskRun,
  )
  // B2: pass referenceHintSkillId through so internal actions whitelisted
  // via host_requirements.expose_when_hint_armed surface for the LLM.
  const referenceHintSkillId = sessionId ? (getLastReferenceSkill(sessionId)?.id ?? null) : null
  return [...getSkillActionToolDefs({
    referenceHintSkillId,
    activeSkillId: activeSkillContext?.skillId ?? null,
  }), ...primitiveTools]
}

export function getSkillToolDefsForRegistry(sessionId?: string): SkillToolDef[] {
  return getSkillToolDefs(sessionId)
}

/**
 * Phase 4 stub — the in-memory todo tracker replaces SkillExecutionDetail as
 * the projection source. PR2 rewrites this to consume SkillTaskTracker state +
 * EphemeralExecutionStore.findPendingForSession. For PR1 we always return
 * null so the renderer task card falls through to generic conversation view.
 */
function buildSkillProjectionPatch(params: {
  sessionId?: string
  skillId?: string
}): Record<string, unknown> | null {
  const projection = readSkillTaskProjection(params)
  return projection ? { ...projection } : null
}

function formatRunResult(result: {
  success: boolean
  stdout: string
  stderr: string
  outputDir?: string
  error?: string
  command: string[]
  // Phase 4: mode='workflow' is deprecated; runSkill no longer returns it in
  // the todo-projection world. The union keeps 'workflow' here temporarily to
  // stay compatible with SkillRunResult until PR1-D trims that type.
  mode?: 'direct' | 'reference' | 'workflow'
  skillId?: string
  action?: string
}): string {
  // Reference-mode skills (`runtime: reference`, typically advisory SKILL.md
  // loads) are NOT subprocess executions — they read a markdown guidance file.
  // Wrapping their content in `Command:` / `STDOUT:` envelopes misleads the
  // model and has been observed to trigger redundant guidance probes for a
  // state that never exists. Emit a compact header that marks the payload as
  // guidance and explicitly tells the model no state is tracked.
  if (result.mode === 'reference') {
    if (!result.success) {
      const reason = result.error || result.stderr || 'unknown error'
      return `Skill reference load failed: ${reason}`
    }
    const header = `# Skill guidance (advisory, no execution state): ${result.skillId || 'skill'}${result.action ? ` / ${result.action}` : ''}`
    const body = result.stdout.trim()
    return body ? `${header}\n\n${body}` : header
  }

  if (!result.success) {
    const details = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n')
    return `Skill execution failed.\n${details}`.trim()
  }

  const sections: string[] = []
  if (result.outputDir) sections.push(`Output directory: ${result.outputDir}`)
  if (result.command.length > 0) sections.push(`Command: ${result.command.join(' ')}`)
  if (result.stdout.trim()) sections.push(`STDOUT:\n${result.stdout.trim()}`)
  if (result.stderr.trim()) sections.push(`STDERR:\n${result.stderr.trim()}`)
  return sections.join('\n\n') || 'Skill execution completed.'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Decide which skillId the Phase 1 primitives should operate on for the
 * current session. Phase 4: there's no active-execution concept, so the
 * decision is driven entirely by the reference-skill hint registered by the
 * orchestrator. Returns null when no hint is armed — handlers refuse with a
 * structured `primitive_no_skill_context` errorKind.
 */
function resolvePrimitiveSkillId(sessionId?: string, runtimeContext?: SkillToolRuntimeContext): string | null {
  // Stage 4 W3b — authorization is the single source of truth for the
  // primitive's skillId once the W3 cutover wires it through. Three cases:
  //
  //   - `mode:'selected'` → use `authorization.skillId`. Identity already
  //     decided which skill this turn is bound to; the primitive runs in
  //     that skill's context.
  //   - `mode:'none' && reason !== 'not_set'` → return null. Identity
  //     concluded no skill applies; admission would have already rejected
  //     a model-issued primitive (`authorization_denied`), so this branch
  //     is only reachable from invoker:'host' / 'child_runner' bypass.
  //     Returning null surfaces `primitive_no_skill_context` to the
  //     handler, matching legacy "no signal" semantics.
  //   - `mode:'none' && reason === 'not_set'` (W3a back-compat default) →
  //     fall through to the legacy chain so callers that haven't been
  //     migrated through `ToolPolicy` / `ToolRuntimeContext` keep the
  //     pre-cutover skillId resolution.
  const authorization = runtimeContext?.authorization ?? SKILL_TOOL_AUTHORIZATION_NOT_SET
  if (authorization.mode === 'selected') return authorization.skillId
  if (authorization.mode === 'none' && authorization.reason !== 'not_set') return null

  // Legacy chain (W3a back-compat fallthrough).
  if (!sessionId && !runtimeContext?.frameSkillId) return null
  const activeContext = sessionId ? resolveActiveSkillContext({ sessionId }) : null
  const hint = sessionId ? getLastReferenceSkill(sessionId) : null
  const activeRun = sessionId ? getLatestActiveSkillTaskRun(sessionId) : null
  return choosePrimitiveSkillId({
    frameSkillId: runtimeContext?.frameSkillId,
    activeContextSkillId: activeContext?.skillId ?? null,
    referenceHintSkillId: hint?.id ?? null,
    latestTaskRunSkillId: activeRun?.skillId ?? null,
  })
}

function findSkillName(manager: ReturnType<typeof getSkillsRuntimeManager>, skillId?: string | null): string | undefined {
  if (!skillId) return undefined
  return manager.listSkills().find((skill) => skill.id === skillId)?.name || skillId
}

function artifactLabel(path?: string | null): string | null {
  if (!path) return null
  return path.split(/[\\/]/).pop() || path
}

function goalTextFromParams(toolName: string, action: string | undefined, params?: Record<string, unknown> | null): string | null {
  if (!params) return null
  for (const key of ['goal', 'goalText', 'prompt', 'instruction', 'task', 'query']) {
    const value = asString(params[key])
    if (value) return value
  }
  const source = asString(params.url) || asString(params.source) || asString(params.sceneScoresPath)
  if (source) return `${action || toolName}: ${source}`
  const command = asString(params.command)
  if (command) return `${toolName}: ${command}`
  return null
}

function resourceRefsFromParams(params?: Record<string, unknown> | null): unknown[] {
  if (!params) return []
  const refs: unknown[] = []
  const pushString = (type: string, key: string): void => {
    const value = asString(params[key])
    if (value) refs.push({ type, key, value })
  }
  pushString('url', 'url')
  pushString('source', 'source')
  pushString('file', 'sceneScoresPath')
  pushString('directory', 'outputDir')
  pushString('command', 'command')
  if (Array.isArray(params.resources)) {
    refs.push(...params.resources)
  }
  return refs
}

function normalizeRunStateStatus(value: unknown): SkillTaskEventStatus | null {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['running', 'in_progress', 'waiting_for_batches', 'ready_to_finalize'].includes(status)) return 'running'
  if (['done', 'completed', 'complete', 'success', 'succeeded'].includes(status)) return 'done'
  if (['blocked', 'pending_review', 'awaiting_input'].includes(status)) return 'blocked'
  if (['failed', 'failure', 'error'].includes(status)) return 'error'
  return null
}

function findStatusInObject(value: unknown, depth = 0): SkillTaskEventStatus | null {
  if (depth > 4 || !value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const direct = normalizeRunStateStatus(rec.status)
  if (direct) return direct
  for (const key of ['run_state', 'runState', 'projection', 'data', 'summary']) {
    const nested = findStatusInObject(rec[key], depth + 1)
    if (nested) return nested
  }
  return null
}

function findStatusInText(text: string): SkillTaskEventStatus | null {
  const match = String(text || '').match(/(?:^|\n)\s*status\s*[:=]\s*([a-z0-9_-]+)/i)
  return match ? normalizeRunStateStatus(match[1]) : null
}

function parseJsonCandidates(text: string): unknown[] {
  const values: unknown[] = []
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      values.push(JSON.parse(line) as unknown)
    } catch {
      // ignore non-json log lines
    }
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      values.push(JSON.parse(trimmed) as unknown)
    } catch {
      // ignore
    }
  }
  return values
}

function stringFromRecord(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  const raw = rec[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

function collectRunStatePaths(data: Record<string, unknown>, text: string): string[] {
  const values: unknown[] = [data, ...parseJsonCandidates(text)]
  const paths: string[] = []
  for (const value of values) {
    const direct = stringFromRecord(value, 'runStatePath') || stringFromRecord(value, 'run_state_path')
    if (direct) paths.push(direct)
    const outputDir = stringFromRecord(value, 'outputDir') || stringFromRecord(value, 'output_dir')
    if (outputDir) paths.push(`${outputDir.replace(/\/+$/, '')}/run_state.json`)
    if (value && typeof value === 'object') {
      const rec = value as Record<string, unknown>
      const runState = rec.run_state || rec.runState
      const nestedPath = stringFromRecord(runState, 'path') || stringFromRecord(runState, 'runStatePath')
      if (nestedPath) paths.push(nestedPath)
    }
  }
  return Array.from(new Set(paths))
}

function readRunStateStatus(path: string): SkillTaskEventStatus | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return findStatusInObject(JSON.parse(raw))
  } catch {
    return null
  }
}

function hasFailureSignalInText(text: string): boolean {
  const normalized = String(text || '')
  if (!normalized.trim()) return false
  return [
    /\bHTTP\s*(?:status\s*)?(?:401|403)\b/i,
    /\b(?:401|403)\b[^\n]*(?:unauthorized|forbidden|provider|api|key)/i,
    /\b(?:unauthorized|forbidden)\b/i,
    /\binvalid\s+(?:api\s*)?key\b/i,
    /\bapi\s*key\s*(?:invalid|missing|unauthorized)\b/i,
    /\bprovider[_\s-]*(?:missing|error|unauthorized|invalid)\b/i,
    /\bquota(?:\s+exceeded)?\b/i,
    /\btraceback\s*\(most recent call last\)/i,
    /\b(?:exception|fatal)\b/i,
    /(?:^|\n)\s*(?:error|failed|failure):/i,
  ].some((pattern) => pattern.test(normalized))
}

export function inferSkillRunStatusFromOutput(output: ToolExecutionOutput): SkillTaskEventStatus {
  const data = output.data && typeof output.data === 'object' ? output.data as Record<string, unknown> : {}
  const fromData = findStatusInObject(data)
  if (fromData) return fromData
  const combinedText = [
    typeof data.stdout === 'string' ? data.stdout : '',
    typeof data.stderr === 'string' ? data.stderr : '',
    output.text,
  ].join('\n')
  for (const parsed of parseJsonCandidates(combinedText)) {
    const fromJson = findStatusInObject(parsed)
    if (fromJson) return fromJson
  }
  const fromText = findStatusInText(combinedText)
  if (fromText) return fromText
  for (const path of collectRunStatePaths(data, combinedText)) {
    const fromFile = readRunStateStatus(path)
    if (fromFile) return fromFile
  }
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : 0
  if (exitCode === 0 && hasFailureSignalInText(combinedText)) return 'error'
  return exitCode === 0 ? 'done' : 'error'
}

function outputPathsFromToolOutput(output?: ToolExecutionOutput): {
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
} {
  const data = output?.data && typeof output.data === 'object' ? output.data as Record<string, unknown> : {}
  const runStatePath = stringFromRecord(data, 'runStatePath') || stringFromRecord(data, 'run_state_path')
  const outputDir = stringFromRecord(data, 'outputDir') || stringFromRecord(data, 'output_dir') || (runStatePath ? dirname(runStatePath) : null)
  return {
    outputDir,
    runStatePath,
    sceneScoresPath: stringFromRecord(data, 'sceneScoresPath') || stringFromRecord(data, 'scene_scores_path'),
    deliveryReportPath: stringFromRecord(data, 'deliveryReportPath') || stringFromRecord(data, 'delivery_report_path'),
  }
}

/**
 * Stage C/D — synthesize the minimum supervisor-shaped snapshot that
 * `loadSkillRunContract` consumes. Used by typed-action wrapper and the
 * three inline detached handlers (start/inspect/cancel) to build a
 * `framePatch.runContract` carrying the handles, paths, and liveness the
 * executor observed.
 *
 * Only the fields the loader actually reads are filled; everything else
 * defaults to safe, neutral values so the loader's status/liveness/progress
 * mappings produce coherent output.
 */
function makeSupervisorSnapshotForContract(params: {
  skillId?: string | null
  scopeId?: string | null
  sessionId?: string | null
  action?: string | null
  status: SkillTaskSupervisorSnapshot['status']
  liveness?: SkillTaskSupervisorLiveness
  taskRunId?: string | null
  detachedTaskId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  hasLiveWork?: boolean
  hasRecentProgress?: boolean
  blockers?: string[]
  pauseReason?: string | null
  observedAt?: string
  lastProgressAt?: string | null
}): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: params.taskRunId ?? null,
    detachedTaskId: params.detachedTaskId ?? null,
    skillId: params.skillId ?? null,
    scopeId: params.scopeId ?? null,
    sessionId: params.sessionId ?? null,
    action: params.action ?? null,
    status: params.status,
    liveness: params.liveness ?? null,
    hasLiveWork: Boolean(params.hasLiveWork),
    hasRecentProgress: Boolean(params.hasRecentProgress),
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: params.outputDir ?? null,
    runStatePath: params.runStatePath ?? null,
    sceneScoresPath: params.sceneScoresPath ?? null,
    deliveryReportPath: params.deliveryReportPath ?? null,
    progress: {
      currentStage: params.action ?? null,
      totalScenes: null,
      completedScenes: null,
      coverageRatio: null,
    },
    blockers: Array.isArray(params.blockers) ? params.blockers : [],
    pauseReason: params.pauseReason ?? null,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: params.observedAt || new Date().toISOString(),
    lastProgressAt: params.lastProgressAt ?? null,
  }
}

/**
 * Stage C/D — derive the source URL the typed action's contract should
 * preserve. Pipeline actions take a `url` argument; analyze/deliver do not.
 * Returns the trimmed string or null. Stays in sync with `originalInput` /
 * `actionInput` shape so Epsilon's force-tool dispatch can rebuild the
 * next action input on resume.
 */
function deriveSourceUrlFromActionInput(input?: Record<string, unknown> | null): string | null {
  if (!input) return null
  const url = stringFromRecord(input, 'url') || stringFromRecord(input, 'source')
  return url
}

/**
 * Stage D — translate `DetachedSkillTaskStatus` to the supervisor status
 * the contract loader consumes. Used by start/inspect/cancel inline
 * handlers so the framePatch's runContract `status` / `liveness` reflect
 * the detached tracker's truth.
 */
function detachedStatusToSupervisorStatus(
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'blocked',
): SkillTaskSupervisorSnapshot['status'] {
  // Phase 7 — public vocabulary: cancelled→killed, done→completed,
  // background_running→running (callers add `liveness: 'background'`).
  switch (status) {
    case 'running': return 'running'
    case 'done': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'killed'
    case 'blocked': return 'blocked'
    default: return 'unknown'
  }
}

function detachedStatusToLiveness(
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'blocked',
): SkillTaskSupervisorLiveness {
  return status === 'running' ? 'background' : null
}

/**
 * Stage C/D — wrap a tool output with a `framePatch` carrying the contract.
 * The caller computes the snapshot; this helper invokes Beta's
 * `loadSkillRunContract` + `buildContractFramePatch` and re-creates the
 * output preserving any existing projectionPatch / interactionHint / data /
 * shape so downstream consumers (projection sync, capsule render) keep
 * their existing behaviour.
 */
function attachContractFramePatch(
  output: ToolExecutionOutput,
  loaderParams: Parameters<typeof loadSkillRunContract>[0],
  patchOverrides?: {
    activeArtifactRoots?: string[] | null
    livenessHint?: SkillRunContract['liveness'] | null
    skillStatusUpdates?: TurnFramePatch['skillStatusUpdates']
  },
): ToolExecutionOutput {
  const contract = loadSkillRunContract(loaderParams)
  if (!contract && !patchOverrides?.skillStatusUpdates && !patchOverrides?.activeArtifactRoots) {
    return output
  }
  const framePatch = buildContractFramePatch({
    contract,
    activeArtifactRoots: patchOverrides?.activeArtifactRoots ?? null,
    livenessHint: patchOverrides?.livenessHint ?? null,
  })
  if (patchOverrides?.skillStatusUpdates) {
    framePatch.skillStatusUpdates = {
      ...(framePatch.skillStatusUpdates || {}),
      ...patchOverrides.skillStatusUpdates,
    }
  }
  // Merge with any existing framePatch the upstream handler attached.
  const existing = output.framePatch
  const merged: TurnFramePatch = existing ? { ...existing, ...framePatch } : framePatch
  if (existing?.runContract && framePatch.runContract) {
    merged.runContract = { ...existing.runContract, ...framePatch.runContract }
  }
  return createToolExecutionOutput(output.text, {
    shape: output.shape,
    data: output.data,
    projectionPatch: output.projectionPatch,
    interactionHint: output.interactionHint,
    framePatch: merged,
    // Phase 3 — preserve any same-turn `contextModifier` the upstream
    // handler attached so the runtime-level live-frame mutation still fires.
    contextModifier: output.contextModifier ?? null,
  })
}

const MONITOR_ONLY_PRIMITIVE_TOOLS = new Set([
  'skill_run_shell',
  'skill_read_artifact',
  'skill_inspect_run_state',
  'skill_inspect_detached',
])

export function shouldRememberPrimitiveOutcomeForContinuity(params: {
  toolName: string
  status: SkillTaskEventStatus
  hasDurableHandle: boolean
}): boolean {
  if (params.status === 'running') return false
  if (
    params.status === 'done'
    && MONITOR_ONLY_PRIMITIVE_TOOLS.has(params.toolName)
    && !params.hasDurableHandle
  ) {
    return false
  }
  return true
}

function buildContinuityResumePayload(params: {
  taskId?: string | null
  stepId?: string | null
  blockerType?: string | null
  detachedTaskId?: string | null
  taskRunId?: string | null
  jobId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
  /**
   * Stage C — typed action wrapper supplies the original user/source input
   * (e.g. `{ url: 'https://...' }` for video_expert_pipeline) so the next
   * turn's force-tool dispatch can rebuild the action input via
   * Epsilon's `buildContractFramePatch` flow without re-asking the user.
   */
  originalInput?: Record<string, unknown> | null
  /** VEA `video_expert_ai_analyze` reads this from supervisor on resume. */
  sceneScoresPath?: string | null
  /** VEA `video_expert_deliver` reads this from supervisor on resume. */
  deliveryReportPath?: string | null
  /** Action name preserved so resume can pick the correct typed action. */
  action?: string | null
  /** Tool name preserved alongside action for symmetry with FrameAction. */
  toolName?: string | null
}): Record<string, unknown> | undefined {
  if (
    !params.blockerType
    && !params.detachedTaskId
    && !params.taskRunId
    && !params.jobId
    && !params.outputDir
    && !params.runStatePath
    && !params.sceneScoresPath
    && !params.deliveryReportPath
    && !params.originalInput
  ) {
    return undefined
  }
  return {
    taskId: params.taskId || params.taskRunId || params.detachedTaskId || params.jobId || null,
    stepId: params.stepId || null,
    blockerType: params.blockerType || null,
    detachedTaskId: params.detachedTaskId || null,
    taskRunId: params.taskRunId || null,
    jobId: params.jobId || null,
    outputDir: params.outputDir || null,
    runStatePath: params.runStatePath || null,
    sceneScoresPath: params.sceneScoresPath || null,
    deliveryReportPath: params.deliveryReportPath || null,
    originalInput: params.originalInput && Object.keys(params.originalInput).length > 0
      ? { ...params.originalInput }
      : null,
    action: params.action || null,
    toolName: params.toolName || null,
  }
}

function buildSkillRunArtifacts(result: {
  outputDir?: string
  outputs?: Record<string, string>
}, toolName: string): Array<{ path: string; label: string; kind?: string; meta?: Record<string, unknown> }> {
  const labels: Record<string, string> = {
    outputDir: '技能输出目录',
    runStatePath: 'run_state.json',
    sceneScoresPath: 'scene_scores.json',
    deliveryReportPath: '交付报告',
  }
  const outputs = result.outputs || {}
  const entries = Object.entries(outputs)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
  if (result.outputDir && !entries.some(([key, value]) => key === 'outputDir' || value === result.outputDir)) {
    entries.unshift(['outputDir', result.outputDir])
  }
  return entries.map(([key, value]) => ({
    path: value,
    label: labels[key] || artifactLabel(value) || key,
    kind: key === 'outputDir' ? 'directory' : 'artifact',
    meta: {
      outputKey: key,
      toolName,
    },
  }))
}

function detachedTaskBelongsToSession(record: { scopeId?: string | null; sessionId?: string | null }, sessionId?: string): boolean {
  if (!sessionId) return false
  return record.scopeId === sessionId || record.sessionId === sessionId
}

function attachSkillProjection(output: string | ToolExecutionOutput, params: {
  sessionId?: string
  skillId?: string
}): ToolExecutionOutput {
  const normalized = normalizeToolExecutionOutput(output)
  const projectionPatch = buildSkillProjectionPatch(params)
  if (!projectionPatch) return normalized
  return createToolExecutionOutput(normalized.text, {
    shape: 'projection_patch',
    data: normalized.data,
    projectionPatch,
    interactionHint: normalized.interactionHint,
    // Stage 5 — preserve any structured frame patch the underlying handler
    // attached so the turn engine post-batch consumer still sees it.
    framePatch: normalized.framePatch,
    // Phase 3 — preserve any same-turn `contextModifier` so the live
    // active-frame slot is still mutated for the next dependent tool.
    contextModifier: normalized.contextModifier ?? null,
  })
}

function recordPrimitiveOutcome(params: {
  scopeId?: string
  sessionId?: string
  runId?: string | null
  agent?: string | null
  skillId?: string | null
  skillName?: string
  toolName: string
  stepId?: string
  status: SkillTaskEventStatus
  message?: string
  output?: ToolExecutionOutput
  params?: Record<string, unknown> | null
}): { stepId: string } {
  const data = params.output?.data || {}
  const paths = outputPathsFromToolOutput(params.output)
  const hasDurableHandle = Boolean(paths.outputDir || paths.runStatePath || paths.sceneScoresPath || paths.deliveryReportPath)
  const artifactPath = typeof data.absolutePath === 'string'
    ? data.absolutePath
    : typeof data.stdoutArtifactPath === 'string'
      ? data.stdoutArtifactPath
      : typeof data.stderrArtifactPath === 'string'
        ? data.stderrArtifactPath
        : null
  const recorded = recordSkillTaskEvent({
    scopeId: params.scopeId,
    sessionId: params.sessionId,
    runId: params.runId,
    agent: params.agent,
    skillId: params.skillId || undefined,
    skillName: params.skillName,
    toolName: params.toolName,
    action: params.toolName,
    runKind: 'primitive',
    stepId: params.stepId,
    status: params.status,
    message: params.message,
    params: params.params || null,
    goalText: goalTextFromParams(params.toolName, params.toolName, params.params),
    resourceRefs: resourceRefsFromParams(params.params),
    artifactPath,
    artifactLabel: artifactLabel(artifactPath),
    ...paths,
  })
  if (params.skillId && shouldRememberPrimitiveOutcomeForContinuity({
    toolName: params.toolName,
    status: params.status,
    hasDurableHandle,
  })) {
    rememberSkillRun(params.sessionId, {
      toolName: params.toolName,
      skillId: params.skillId,
      action: params.toolName,
      success: params.status === 'done',
      status: params.status,
      runKind: 'primitive',
      outputDir: paths.outputDir || undefined,
      runStatePath: paths.runStatePath || undefined,
      pauseReason: params.status === 'blocked' ? 'blocked' : undefined,
      resumePayload: buildContinuityResumePayload({
        taskId: params.skillId,
        stepId: recorded.stepId,
        blockerType: params.status === 'blocked' ? 'blocked' : params.status === 'error' ? 'error' : null,
        outputDir: paths.outputDir,
        runStatePath: paths.runStatePath,
      }),
      summary: (params.message || params.output?.text || params.toolName).slice(0, 240),
    })
  }
  return recorded
}

export function getSkillAnthropicTools(sessionId?: string): Array<Record<string, unknown>> {
  return getSkillToolDefs(sessionId).map(toAnthropicTool)
}

export function getSkillOpenAITools(sessionId?: string): Array<Record<string, unknown>> {
  return getSkillToolDefs(sessionId).map(toOpenAITool)
}

// Handler lookup always sees the full skill tool set (action + primitives).
// Gating is a LISTING concern, not an execution concern.
export function findSkillToolByName(toolName: string): SkillToolDef | null {
  return PRIMITIVE_TOOL_DEFS.find((item) => item.name === toolName)
    || findSkillToolByNameForExecution(toolName)
}

export type SkillToolLookupDetailedResult =
  | { ok: true; def: SkillToolDef }
  | { ok: false; reason: SkillToolFallbackReason }

export function findSkillToolByNameForExecutionDetailedWithEntry(
  toolName: string,
  fallbackEntry: SkillToolFallbackEntry,
): SkillToolLookupDetailedResult {
  let actionTool: SkillToolDef | null = null
  let managerFailed = false
  try {
    actionTool = getSkillActionToolDefs({ includeInternal: true })
      .find((item) => item.name === toolName) || null
  } catch {
    managerFailed = true
    fallbackThrottle.emit({
      entry: fallbackEntry,
      reason: 'manager_throw',
      toolName,
    })
    actionTool = null
  }
  if (actionTool) return { ok: true, def: actionTool }

  const primitiveTool = PRIMITIVE_TOOL_DEFS.find((item) => item.name === toolName) || null
  if (primitiveTool) return { ok: true, def: primitiveTool }
  if (managerFailed) return { ok: false, reason: 'manager_throw' }

  if (STATIC_SKILL_TOOL_NAMES_BOOT_SAFE.includes(toolName)) {
    fallbackThrottle.emit({
      entry: fallbackEntry,
      reason: 'manifest_miss',
      toolName,
    })
  }
  return { ok: false, reason: 'manifest_miss' }
}

export function findSkillToolByNameForExecutionDetailed(toolName: string): SkillToolLookupDetailedResult {
  return findSkillToolByNameForExecutionDetailedWithEntry(toolName, 'find_by_name')
}

export function findSkillToolByNameForExecution(toolName: string): SkillToolDef | null {
  const result = findSkillToolByNameForExecutionDetailed(toolName)
  return result.ok ? result.def : null
}

export function findSkillToolBySkillAction(skillId: string, actionName?: string): SkillToolDef | null {
  let defs: SkillToolDef[] = []
  try {
    defs = getSkillActionToolDefs({ includeInternal: true }).filter((item) => item.skillId === skillId)
  } catch {
    fallbackThrottle.emit({
      entry: 'find_by_skill_action',
      reason: 'manager_throw',
      skillId,
      ...(actionName ? { action: actionName } : {}),
    })
    defs = []
  }
  if (!actionName) return defs[0] || null
  return defs.find((item) => item.action === actionName) || defs[0] || null
}

export function resolveStartDetachedActionTool(args: {
  skillId: string
  requestedAction: string
  findByToolName?: (toolName: string) => SkillToolDef | null
  findBySkillAction?: (skillId: string, actionName?: string) => SkillToolDef | null
}): { action: string; actionTool: SkillToolDef | null } {
  const findByToolName = args.findByToolName || findSkillToolByNameForExecution
  const findBySkillAction = args.findBySkillAction || findSkillToolBySkillAction
  let action = args.requestedAction
  let actionTool: SkillToolDef | null = null
  if (args.requestedAction.startsWith('skill_')) {
    const resolvedTool = findByToolName(args.requestedAction)
    if (resolvedTool?.kind === 'skill_action' && resolvedTool.skillId === args.skillId && resolvedTool.action) {
      actionTool = resolvedTool
      action = resolvedTool.action
    }
  } else {
    actionTool = findBySkillAction(args.skillId, action)
  }
  return { action, actionTool }
}

export async function executeSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
  // Phase 4: registerRunCleanup parameter kept for signature stability with
  // tool-runtime-context-builder + run-resource-reaper contract test, but no
  // longer used (the only previous use — cancel-execution cleanup on
  // orphaned workflow — is gone along with the state machine).
  _registerRunCleanup?: (cleanup: () => void | Promise<void>) => void,
  abortSignal?: AbortSignal,
  agentContext?: AgentSpawnContext | null,
  runtimeContext?: SkillToolRuntimeContext,
): Promise<string | ToolExecutionOutput> {
  const tool = findSkillToolByName(toolName)
  if (!tool) {
    return `Unknown skill tool: ${toolName}`
  }

  let manager: ReturnType<typeof getSkillsRuntimeManager> | null = null
  const getManager = (): ReturnType<typeof getSkillsRuntimeManager> => {
    if (!manager) manager = getSkillsRuntimeManager()
    return manager
  }
  const listSkillsSafely = (): SkillState[] => {
    try {
      return getManager().listSkills()
    } catch {
      return []
    }
  }
  const findSkillNameSafely = (skillIdForLookup?: string | null): string | undefined => {
    if (!skillIdForLookup) return undefined
    try {
      return findSkillName(getManager(), skillIdForLookup)
    } catch {
      return skillIdForLookup
    }
  }

  if (tool.kind === 'primitive') {
    const skillId = resolvePrimitiveSkillId(sessionId, runtimeContext)
    const skillName = findSkillNameSafely(skillId)
    if (tool.name === 'skill_ask_user') {
      const started = recordPrimitiveOutcome({
        scopeId: runtimeContext?.scopeId,
        sessionId,
        runId: runtimeContext?.runId,
        agent: runtimeContext?.agent,
        skillId,
        skillName,
        toolName,
        status: 'blocked',
        message: asString(args.question) || '等待用户补充信息',
      })
      try {
        const output = await executeAskUser(
          {
            question: asString(args.question),
            options: Array.isArray(args.options)
              ? (args.options as unknown[]).filter((v) => typeof v === 'string') as string[]
              : undefined,
            placeholder: typeof args.placeholder === 'string' ? args.placeholder : undefined,
          },
          {
            sessionId,
            skillId: skillId || undefined,
            signal: abortSignal,
            emitAskUserQuestion: getAskUserQuestionEmitter(),
          },
        )
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'done',
          message: '用户已回复',
          output,
        })
        return attachSkillProjection(output, { sessionId, skillId: skillId || undefined })
      } catch (error) {
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (tool.name === 'skill_inspect_detached') {
      const tracker = getDetachedSkillTaskTracker()
      const taskId = asString(args.taskId)
      const record = tracker?.inspect(taskId) || null
      if (!record) {
        return createToolExecutionOutput(`Detached skill task not found: ${taskId}`, {
          shape: 'json',
          data: { errorKind: 'detached_task_not_found', taskId },
        })
      }
      if (!detachedTaskBelongsToSession(record, sessionId)) {
        return createToolExecutionOutput(`Detached skill task is not available in this session: ${taskId}`, {
          shape: 'json',
          data: { errorKind: 'detached_task_forbidden', taskId, sessionId: sessionId || null },
        })
      }
      // Stage D4 — emit framePatch with handles, status, liveness, output
      // paths, artifact roots so the next iteration's frame sees the
      // tracker's truth without re-inspecting.
      const supervisorSnapshot = makeSupervisorSnapshotForContract({
        skillId: record.skillId,
        scopeId: record.scopeId || sessionId || null,
        sessionId: record.sessionId || sessionId || null,
        action: record.action,
        status: detachedStatusToSupervisorStatus(record.status),
        liveness: detachedStatusToLiveness(record.status),
        detachedTaskId: record.id,
        outputDir: record.outputDir,
        runStatePath: record.runStatePath,
        sceneScoresPath: record.sceneScoresPath,
        deliveryReportPath: record.deliveryReportPath,
        hasLiveWork: record.status === 'running',
        blockers: record.error ? [record.error] : [],
        pauseReason: record.error || null,
        observedAt: record.updatedAt,
      })
      const baseOutput = createToolExecutionOutput(`Detached skill task ${record.id}: ${record.status}`, {
        shape: 'json',
        data: { task: record },
      })
      return attachContractFramePatch(baseOutput, {
        scopeId: record.scopeId || sessionId || null,
        sessionId: record.sessionId || sessionId || null,
        skillId: record.skillId,
        outputDir: record.outputDir,
        runStatePath: record.runStatePath,
        supervisorSnapshot,
        toolName: tool.name,
        actionInput: { taskId: record.id, ...(record.params || {}) },
      }, {
        activeArtifactRoots: record.outputDir ? [record.outputDir] : null,
      })
    }
    if (tool.name === 'skill_cancel_detached') {
      const tracker = getDetachedSkillTaskTracker()
      const taskId = asString(args.taskId)
      const record = tracker?.cancel(taskId) || null
      if (!record) {
        return createToolExecutionOutput(`Detached skill task not found: ${taskId}`, {
          shape: 'json',
          data: { errorKind: 'detached_task_not_found', taskId },
        })
      }
      if (!detachedTaskBelongsToSession(record, sessionId)) {
        return createToolExecutionOutput(`Detached skill task is not available in this session: ${taskId}`, {
          shape: 'json',
          data: { errorKind: 'detached_task_forbidden', taskId, sessionId: sessionId || null },
        })
      }
      // Stage D7 — emit terminal framePatch so the frame and projection
      // do NOT keep showing recoverable/running work after cancellation.
      // Phase 7: cancellation maps to public `killed` (NOT `failed`).
      const supervisorSnapshot = makeSupervisorSnapshotForContract({
        skillId: record.skillId,
        scopeId: record.scopeId || sessionId || null,
        sessionId: record.sessionId || sessionId || null,
        action: record.action,
        status: detachedStatusToSupervisorStatus(record.status),
        liveness: detachedStatusToLiveness(record.status),
        detachedTaskId: record.id,
        outputDir: record.outputDir,
        runStatePath: record.runStatePath,
        sceneScoresPath: record.sceneScoresPath,
        deliveryReportPath: record.deliveryReportPath,
        hasLiveWork: false,
        blockers: record.error ? [record.error] : [],
        pauseReason: record.error || 'cancelled',
        observedAt: record.updatedAt,
      })
      const baseOutput = createToolExecutionOutput(`Detached skill task ${record.id}: ${record.status}`, {
        shape: 'json',
        data: { task: record },
      })
      return attachContractFramePatch(baseOutput, {
        scopeId: record.scopeId || sessionId || null,
        sessionId: record.sessionId || sessionId || null,
        skillId: record.skillId,
        outputDir: record.outputDir,
        runStatePath: record.runStatePath,
        supervisorSnapshot,
        toolName: tool.name,
        actionInput: { taskId: record.id },
      }, {
        // Force the next-frame liveness off `running_process`. For a
        // cancelled task, `failed` is the safest non-running terminal
        // value since the contract's status enum buckets cancellation
        // into `failed`. This blocks projection from continuing to
        // show "background running" after the explicit cancel.
        livenessHint: 'failed',
        skillStatusUpdates: {
          status: 'cancelled',
        },
      })
    }
    if (!skillId) {
      return createToolExecutionOutput(
        `Cannot invoke ${toolName}: no active skill execution or reference-skill hint for this session. Load a skill first, then retry.`,
        {
          shape: 'json',
          data: {
            errorKind: 'primitive_no_skill_context',
            toolName,
            sessionId: sessionId || null,
          },
        },
      )
    }
    if (tool.name === 'skill_patch_config') {
      const maskedParams = {
        target: asString(args.target),
        operations: Array.isArray(args.operations)
          ? args.operations.map((operation) => {
            const rec = operation && typeof operation === 'object' ? operation as Record<string, unknown> : {}
            return {
              op: rec.op,
              path: rec.path,
              value: rec.op === 'set' ? '[masked]' : undefined,
            }
          })
          : [],
      }
      const started = recordPrimitiveOutcome({
        scopeId: runtimeContext?.scopeId,
        sessionId,
        runId: runtimeContext?.runId,
        agent: runtimeContext?.agent,
        skillId,
        skillName,
        toolName,
        status: 'running',
        message: `修复技能配置：${maskedParams.target}`,
        params: maskedParams,
      })
      try {
        const skillDef = listSkillsSafely().find((skill) => skill.id === skillId)
        const activeSkillContext = resolveActiveSkillContext({ sessionId })
        const output = await executePatchConfig({
          target: maskedParams.target,
          operations: Array.isArray(args.operations)
            ? args.operations as Array<{ op: 'set' | 'delete'; path: string; value?: unknown }>
            : [],
        }, {
          skillId,
          hostRequirements: skillDef?.hostRequirements ?? null,
          activeContext: activeSkillContext
            ? {
              runStatePath: activeSkillContext.runStatePath,
              outputDir: activeSkillContext.outputDir,
            }
            : null,
        })
        const validationOk = Boolean((output.data?.validation as { ok?: unknown } | undefined)?.ok)
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: validationOk ? 'done' : 'blocked',
          message: validationOk ? '配置已修复并校验通过' : '配置已写入但校验未通过',
          output,
          params: maskedParams,
        })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          params: maskedParams,
        })
        throw error
      }
    }
    if (tool.name === 'skill_start_detached') {
      const tracker = getDetachedSkillTaskTracker()
      if (!tracker) {
        return createToolExecutionOutput('Detached skill task runtime is not ready.', {
          shape: 'json',
          data: { errorKind: 'detached_task_runtime_unavailable' },
        })
      }
      const requestedAction = asString(args.action)
      const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? { ...(args.params as Record<string, unknown>) }
        : {}
      const { action, actionTool } = resolveStartDetachedActionTool({ skillId, requestedAction })
      const skillDef = listSkillsSafely().find((skill) => skill.id === skillId)
      const referenceHintSkillId = sessionId ? getLastReferenceSkill(sessionId)?.id ?? null : null
      const activeSkillId = resolveActiveSkillContext({ sessionId })?.skillId ?? null
      // Phase 4.4 — split the old `detached_task_action_not_allowed` blob into
      // four specific errorKinds so the model can self-diagnose:
      //   - skill_not_loaded     (skill manifest never loaded — try later or check install)
      //   - skill_action_unknown (skill loaded but no action by that name)
      //   - hint_required        (action is internal-only and the session has no
      //                           reference hint armed for this skill)
      //   - visibility_internal  (action visibility=internal AND not in
      //                           expose_when_hint_armed allowlist)
      // Audit Phase 4 §C3 — prior taxonomy collapsed all four causes into
      // one opaque "action not allowed" message, leaving the model unable to
      // tell "skill not installed yet, retry in a sec" from "this action is
      // permanently internal".
      let detachedReject: { errorKind: string; reason: string } | null = null
      if (!action || actionTool?.kind !== 'skill_action' || actionTool.skillId !== skillId || actionTool.action !== action) {
        detachedReject = {
          errorKind: 'detached_task_skill_action_unknown',
          reason: `No typed action "${requestedAction}" exposed for skill ${skillId}.`,
        }
      } else if (!skillDef) {
        detachedReject = {
          errorKind: 'detached_task_skill_not_loaded',
          reason: `Skill ${skillId} is not in the loaded manifest list. It may still be installing or the manifest failed to load.`,
        }
      } else if (
        !shouldExposeSkillAction({
          actionVisibility: actionTool.visibility || 'public',
          actionName: action,
          skillId,
          referenceHintSkillId,
          activeSkillId,
          exposeWhenHintArmed: skillDef.hostRequirements?.expose_when_hint_armed ?? [],
        })
      ) {
        const isInternal = (actionTool.visibility || 'public') === 'internal'
        const armedForThisSkill = referenceHintSkillId === skillId
        if (isInternal && !armedForThisSkill && (skillDef.hostRequirements?.expose_when_hint_armed ?? []).includes(action)) {
          detachedReject = {
            errorKind: 'detached_task_hint_required',
            reason: `Action "${action}" requires a reference-skill hint for ${skillId} to be armed. The skill's SKILL.md was not inlined this session — re-trigger the skill (e.g. mention it by name) to arm the hint.`,
          }
        } else {
          detachedReject = {
            errorKind: 'detached_task_visibility_internal',
            reason: `Action "${action}" is marked visibility=internal and is not in expose_when_hint_armed. Use a public action of skill ${skillId} instead.`,
          }
        }
      }
      if (detachedReject) {
        return createToolExecutionOutput(`Cannot start detached skill action: ${detachedReject.reason}`, {
          shape: 'json',
          data: {
            errorKind: detachedReject.errorKind,
            skillId,
            action: requestedAction,
            referenceHintSkillId,
          },
        })
      }
      try {
        const record = tracker.start({
          scopeId: sessionId || null,
          sessionId: sessionId || null,
          agent: runtimeContext?.agent || null,
          parentTaskId: runtimeContext?.taskId || null,
          parentStepId: runtimeContext?.parentStepId || null,
          taskProjectionId: runtimeContext?.taskProjectionId || runtimeContext?.taskId || null,
          skillId,
          action,
          params,
        })
        recordSkillTaskEvent({
          sessionId,
          skillId,
          skillName,
          toolName,
          status: 'running',
          message: `后台技能任务已启动：${record.id}`,
        })
        // Stage D6 — emit framePatch with detached/job handles so the next
        // iteration's frame sees the spawned task without re-inspecting.
        // `outputDir` / `runStatePath` are populated by the tracker when
        // known at start time (some skills resolve them only once the
        // child process writes its first run_state.json).
        const supervisorSnapshot = makeSupervisorSnapshotForContract({
          skillId,
          scopeId: sessionId || null,
          sessionId: sessionId || null,
          action,
          status: 'running',
          liveness: 'background',
          detachedTaskId: record.id,
          outputDir: record.outputDir,
          runStatePath: record.runStatePath,
          sceneScoresPath: record.sceneScoresPath,
          deliveryReportPath: record.deliveryReportPath,
          hasLiveWork: true,
          observedAt: record.startedAt,
        })
        const baseOutput = createToolExecutionOutput(`Detached skill task started: ${record.id}`, {
          shape: 'json',
          data: { task: record },
          projectionPatch: buildSkillProjectionPatch({ sessionId, skillId }),
        })
        return attachContractFramePatch(baseOutput, {
          scopeId: sessionId || null,
          sessionId: sessionId || null,
          skillId,
          outputDir: record.outputDir,
          runStatePath: record.runStatePath,
          supervisorSnapshot,
          toolName: tool.name,
          actionInput: { action, params },
          originalInput: params,
        }, {
          activeArtifactRoots: record.outputDir ? [record.outputDir] : null,
          livenessHint: 'running_process',
        })
      } catch (error) {
        return createToolExecutionOutput('Detached skill task failed to start.', {
          shape: 'json',
          data: {
            errorKind: 'detached_task_start_failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
    if (tool.name === 'skill_run_shell') {
      const started = recordPrimitiveOutcome({
        scopeId: runtimeContext?.scopeId,
        sessionId,
        runId: runtimeContext?.runId,
        agent: runtimeContext?.agent,
        skillId,
        skillName,
        toolName,
        status: 'running',
        message: asString(args.command) || '执行技能脚本',
        params: args,
      })
      try {
        // B-arch-4 — when the active reference-skill declares
        // host_requirements.shell_allowlist_extensions, fold them into the
        // base SHELL_ALLOWLIST so skill-specific diagnostic commands are
        // accepted only while that hint is
        // armed. Other sessions / non-skill tool calls keep the base list.
        const referenceSkillId = sessionId ? (getLastReferenceSkill(sessionId)?.id ?? null) : null
        const activeSkillId = resolveActiveSkillContext({ sessionId })?.skillId ?? null
        const skillDef = listSkillsSafely().find((skill) => skill.id === skillId)
        const hostRequirements = skillDef?.hostRequirements ?? null
        const effectiveAllowlist = getSkillHostController().getEffectiveShellAllowlist(
          sessionId,
          referenceSkillId || activeSkillId,
          SHELL_ALLOWLIST,
          hostRequirements,
        )
        const output = await executeRunShell(
          {
            command: asString(args.command),
            timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
            stdin: typeof args.stdin === 'string' ? args.stdin : undefined,
          },
          {
            skillId,
            signal: abortSignal,
            runtimeBinDir: getManager().getRuntimeBinDir(),
            venvBinDir: getManager().getSharedVenvBinDir(),
            effectiveAllowlist,
          },
        )
        const status = inferSkillRunStatusFromOutput(output)
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status,
          output,
          params: args,
        })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          params: args,
        })
        throw error
      }
    }
    if (tool.name === 'skill_write_artifact') {
      const started = recordPrimitiveOutcome({
        scopeId: runtimeContext?.scopeId,
        sessionId,
        runId: runtimeContext?.runId,
        agent: runtimeContext?.agent,
        skillId,
        skillName,
        toolName,
        status: 'running',
      })
      try {
        const output = await executeWriteArtifact(
          {
            relativePath: asString(args.relativePath),
            content: typeof args.content === 'string' ? args.content : '',
            encoding: args.encoding === 'base64' ? 'base64' : 'utf-8',
          },
          {
            skillId,
            additionalAllowedWriteTargets: resolvePendingSkillHandoffWriteTargets(
              runtimeContext?.activeFrame?.activeArtifactRoots || [],
            ),
          },
        )
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'done',
          output,
        })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (tool.name === 'skill_read_artifact') {
      const started = recordPrimitiveOutcome({
        scopeId: runtimeContext?.scopeId,
        sessionId,
        runId: runtimeContext?.runId,
        agent: runtimeContext?.agent,
        skillId,
        skillName,
        toolName,
        status: 'running',
      })
      try {
        // Phase 3 (skill-child-loop) — prefer the same-turn live
        // `activeFrame.activeArtifactRoots` slot when populated so artifact
        // roots emitted by an earlier tool in this batch (e.g. VEA's
        // outputDir surfaced via `contextModifier`) are immediately readable
        // without waiting for the next turn's frame rebuild. The legacy
        // `resolveActiveSkillContext` path remains as fallback for cold
        // sessions where the active-frame slot is empty.
        const additionalRootCandidates: string[] = []
        const seenRoots = new Set<string>()
        const pushRoot = (path: string | null | undefined) => {
          if (typeof path !== 'string') return
          const trimmed = path.trim()
          if (!trimmed || seenRoots.has(trimmed)) return
          seenRoots.add(trimmed)
          additionalRootCandidates.push(trimmed)
        }
        const liveFrameRoots = runtimeContext?.activeFrame?.activeArtifactRoots
        if (Array.isArray(liveFrameRoots) && liveFrameRoots.length > 0) {
          for (const root of liveFrameRoots) pushRoot(root)
        } else {
          // TODO(skill-child-loop): drop fallback after child-run path is stable
          const activeContextForRoots = sessionId ? resolveActiveSkillContext({ sessionId }) : null
          if (activeContextForRoots) {
            pushRoot(activeContextForRoots.outputDir)
            if (activeContextForRoots.runStatePath) pushRoot(dirname(activeContextForRoots.runStatePath))
            if (activeContextForRoots.sceneScoresPath) pushRoot(dirname(activeContextForRoots.sceneScoresPath))
            if (activeContextForRoots.deliveryReportPath) pushRoot(dirname(activeContextForRoots.deliveryReportPath))
          }
        }
        const output = await executeReadArtifact(
          {
            relativePath: asString(args.relativePath),
            maxBytes: typeof args.maxBytes === 'number' ? args.maxBytes : undefined,
          },
          {
            skillId,
            additionalAllowedReadRoots: additionalRootCandidates,
          },
        )
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'done',
          output,
        })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    if (tool.name === 'skill_inspect_run_state') {
      const started = recordPrimitiveOutcome({
        scopeId: runtimeContext?.scopeId,
        sessionId,
        runId: runtimeContext?.runId,
        agent: runtimeContext?.agent,
        skillId,
        skillName,
        toolName,
        status: 'running',
      })
      try {
        const output = await executeInspectRunState({
          outputDir: typeof args.outputDir === 'string' ? args.outputDir : undefined,
          runStatePath: typeof args.runStatePath === 'string' ? args.runStatePath : undefined,
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          expectedTaskId: typeof args.expectedTaskId === 'string' ? args.expectedTaskId : undefined,
          maxRawBytes: typeof args.maxRawBytes === 'number' ? args.maxRawBytes : undefined,
          // Stage D3 — thread the active skillId through so the emitted
          // `framePatch.runContract` is anchored to the right skill and
          // can be persisted by `applyTurnFramePatch` even when no prior
          // contract exists on the frame.
          skillId: typeof skillId === 'string' && skillId.length > 0 ? skillId : undefined,
        })
        const status = inferSkillRunStatusFromOutput(output)
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status,
          output,
        })
        return attachSkillProjection(output, { sessionId, skillId })
      } catch (error) {
        recordPrimitiveOutcome({
          scopeId: runtimeContext?.scopeId,
          sessionId,
          runId: runtimeContext?.runId,
          agent: runtimeContext?.agent,
          skillId,
          skillName,
          toolName,
          stepId: started.stepId,
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }
    return `Unknown skill primitive: ${toolName}`
  }

  // Phase 4: execution_control (skill_get_state / skill_submit_* /
  // skill_restart_from_step / skill_cancel_execution) branch retired.

  const started = recordSkillTaskEvent({
    scopeId: runtimeContext?.scopeId,
    sessionId,
    runId: runtimeContext?.runId,
    agent: runtimeContext?.agent,
    skillId: tool.skillId || undefined,
    skillName: findSkillName(getManager(), tool.skillId),
    toolName,
    action: tool.action || '',
    runKind: 'typed_action',
    status: 'running',
    params: args,
    goalText: goalTextFromParams(toolName, tool.action || '', args),
    resourceRefs: resourceRefsFromParams(args),
  })

  // Phase 6 — child-loop routing. When the typed action belongs to a
  // child-owned skill (currently: VEA `video_expert_pipeline` and
  // `video_expert_ai_analyze`), skip the inline `runSkill` await: launch
  // (or reuse) a child run and return immediately with a structured
  // envelope the parent's tool batch can fold into the next iteration.
  // The framePatch carries `runContract.childRunId` + `parentNextHint` so
  // the next turn's `loadSkillRunContract` sees child ownership and
  // `shouldParentForceLongSkillTool` blocks any synthesized parent-side
  // force dispatch. See docs/architecture/skill-child-loop-boundary.md §5.2.
  if (isChildLoopSkillAction(tool.skillId || '', tool.action || '')) {
    return await dispatchChildLoopSkillAction({
      toolName,
      skillId: tool.skillId || '',
      action: tool.action || '',
      args,
      sessionId,
      scopeId: runtimeContext?.scopeId || sessionId || null,
      stepId: started.stepId,
      agentContext,
      runtimeContext,
    })
  }

  // TODO(skill-child-loop): this awaited runSkill call blocks the parent's
  // tool batch on the entire long-skill run. When the child-loop runner
  // lands, this becomes a launch-and-acknowledge call; the structured close
  // event arrives via a separate channel and only then do we build the
  // framePatch below. See docs/architecture/skill-child-loop-boundary.md §5.2.
  const result = await getManager().runSkill({
    skillId: tool.skillId || '',
    action: tool.action || '',
    params: args,
    timeoutMs: tool.timeoutMs,
    signal: abortSignal,
    triggerType: 'tool',
    sessionId,
    agentContext,
  })
  const formatted = formatRunResult(result)
  const runStatus = result.status ?? (result.success ? 'done' : 'error')
  const outputs = result.outputs && typeof result.outputs === 'object' ? result.outputs : {}
  const outputDir = result.outputDir || outputs.outputDir || null
  const runStatePath = outputs.runStatePath || null
  const sceneScoresPath = outputs.sceneScoresPath || null
  const deliveryReportPath = outputs.deliveryReportPath || null
  const taskRunId = stringFromRecord(outputs, 'taskRunId') || stringFromRecord(outputs, 'task_run_id')
  const detachedTaskId = stringFromRecord(outputs, 'detachedTaskId') || stringFromRecord(outputs, 'detached_task_id')
  recordSkillTaskEvent({
    scopeId: runtimeContext?.scopeId,
    sessionId,
    runId: runtimeContext?.runId,
    agent: runtimeContext?.agent,
    skillId: tool.skillId || undefined,
    skillName: findSkillName(getManager(), tool.skillId),
    toolName,
    action: tool.action || '',
    runKind: 'typed_action',
    stepId: started.stepId,
    // B-arch-4 — when SkillRunResult.status is populated by
    // SkillHostController.detectStatus, propagate it (so 'blocked' surfaces in
    // the task projection). Falls back to the legacy success-mapping when the
    // skill didn't opt into host_requirements.status_detection.
    status: runStatus,
    message: result.success ? undefined : result.error || result.stderr || '技能执行失败',
    artifactPath: result.outputDir || undefined,
    artifactLabel: result.outputDir ? '技能输出目录' : undefined,
    artifacts: buildSkillRunArtifacts(result, toolName),
    params: args,
    outputDir,
    runStatePath,
    sceneScoresPath,
    deliveryReportPath,
    failureKind: result.success ? null : 'skill_action_failed',
    failureDetail: result.success ? null : result.error || result.stderr || null,
    goalText: goalTextFromParams(toolName, tool.action || '', args),
    resourceRefs: resourceRefsFromParams(args),
    jobId: result.jobId || null,
    detachedTaskId,
  })
  rememberSkillRun(sessionId, {
    toolName,
    skillId: tool.skillId || '',
    action: tool.action || '',
    success: result.success,
    status: runStatus,
    runKind: 'typed_action',
    taskRunId: taskRunId || undefined,
    detachedTaskId: detachedTaskId || undefined,
    jobId: result.jobId || undefined,
    outputDir: outputDir || undefined,
    runStatePath: runStatePath || undefined,
    pauseReason: runStatus === 'blocked' ? 'blocked' : undefined,
    // Stage C resume payload completeness — preserve the original action
    // input AND the action-specific paths Epsilon's force-tool dispatch
    // reads on resume:
    //   - pipeline (`video_expert_pipeline`): `originalInput.url` survives
    //     so the next turn can reconstruct the same action input.
    //   - analyze (`video_expert_ai_analyze`): `sceneScoresPath` survives.
    //   - deliver: `deliveryReportPath` survives.
    resumePayload: buildContinuityResumePayload({
      taskId: taskRunId || detachedTaskId || result.jobId || null,
      stepId: started.stepId,
      blockerType: runStatus === 'blocked' ? 'blocked' : runStatus === 'error' ? 'error' : null,
      detachedTaskId,
      taskRunId,
      jobId: result.jobId || null,
      outputDir,
      runStatePath,
      sceneScoresPath,
      deliveryReportPath,
      originalInput: args,
      action: tool.action || null,
      toolName,
    }),
    summary: formatted.slice(0, 240),
  })
  const projectionPatch = buildSkillProjectionPatch({
    sessionId,
    skillId: tool.skillId || undefined,
  })

  // Stage C C3 + C4 — emit framePatch carrying the SkillRunContract that
  // Epsilon's force-tool dispatch will read on the next turn. The
  // contract preserves the validated action input, the original user
  // input (for input rebuild), the source URL (pipeline only), the
  // detached/task-run/job handles, the output paths discovered by the
  // skill runtime, and the status/liveness/progress observed.
  //
  // Special-cased because typed action wrappers carry the most precise
  // signal: the result.outputs map is authoritative for sceneScoresPath /
  // deliveryReportPath, more so than the file-system probe a primitive
  // would have to do. Liveness derived from the runStatus enum.
  //
  // TODO(skill-child-loop): this contract construction runs inline inside
  // the parent's tool batch because the parent-only loop has no other place
  // to fold the close into. When the child-loop runner lands, the same
  // construction runs at the child's structured close event — the typed
  // action wrapper returns immediately on launch, and the close event
  // produces the framePatch. See docs/architecture/skill-child-loop-boundary.md §5.2.
  const supervisorStatusForContract: SkillTaskSupervisorSnapshot['status'] = (() => {
    if (runStatus === 'done') return 'completed'
    if (runStatus === 'error') return 'failed'
    if (runStatus === 'blocked') return 'blocked'
    return 'running'
  })()
  const supervisorLivenessForContract: SkillTaskSupervisorLiveness = (() => {
    if (runStatus === 'done' || runStatus === 'error' || runStatus === 'blocked') return null
    return 'background'
  })()
  const livenessHintForContract: SkillRunContract['liveness'] = (() => {
    if (runStatus === 'done') return 'done'
    if (runStatus === 'error') return 'failed'
    if (runStatus === 'blocked') return 'blocked'
    return 'running_process'
  })()
  const supervisorSnapshot = makeSupervisorSnapshotForContract({
    skillId: tool.skillId || null,
    scopeId: runtimeContext?.scopeId || sessionId || null,
    sessionId: sessionId || null,
    action: tool.action || null,
    status: supervisorStatusForContract,
    liveness: supervisorLivenessForContract,
    taskRunId,
    detachedTaskId,
    outputDir,
    runStatePath,
    sceneScoresPath,
    deliveryReportPath,
    hasLiveWork: runStatus === 'blocked',
    blockers: result.success ? [] : [result.error || result.stderr || '技能执行失败'],
    pauseReason: runStatus === 'blocked' ? 'blocked' : (result.error || null),
  })
  const contract = loadSkillRunContract({
    scopeId: runtimeContext?.scopeId || sessionId || null,
    sessionId: sessionId || null,
    skillId: tool.skillId || null,
    outputDir,
    runStatePath,
    supervisorSnapshot,
    projectionSibling: null,
    referenceHint: sessionId ? getLastReferenceSkill(sessionId) : null,
    originalInput: args,
    sourceUrl: deriveSourceUrlFromActionInput(args),
    toolName,
    actionInput: args,
    jobId: result.jobId || null,
  })
  // Patch the contract with the precise output paths the runtime
  // produced, in case `loadSkillRunContract` populated them from a
  // different source.
  if (contract) {
    contract.artifactPaths = {
      sceneScoresPath: sceneScoresPath || contract.artifactPaths.sceneScoresPath,
      deliveryReportPath: deliveryReportPath || contract.artifactPaths.deliveryReportPath,
    }
    if (outputDir && !contract.artifactRoots.includes(outputDir)) {
      contract.artifactRoots = [outputDir, ...contract.artifactRoots]
    }
  }
  const framePatch = buildContractFramePatch({
    contract,
    activeArtifactRoots: outputDir ? [outputDir] : null,
    livenessHint: livenessHintForContract,
  })

  // Phase 3 (skill-child-loop) — emit a same-turn `contextModifier` for the
  // VEA typed-action wrappers so dependent later tools in this batch (e.g.
  // a follow-up `skill_read_artifact run_state.json`) immediately see the
  // freshly-produced output directory as an additional allowed read root.
  // The framePatch above remains the durable end-of-turn signal; this
  // contextModifier is strictly additive for live intra-turn visibility.
  const VEA_CONTEXT_MUTATING_TOOL_NAMES = new Set([
    'skill_video_expert_pipeline',
    'skill_video_expert_ai_analyze',
  ])
  const contextModifier = (outputDir && VEA_CONTEXT_MUTATING_TOOL_NAMES.has(toolName))
    ? { activeFrame: { activeArtifactRoots: [outputDir] } }
    : null

  return createToolExecutionOutput(formatted, {
    projectionPatch,
    framePatch,
    contextModifier,
  })
}

export type { SkillToolDef, ToolParam, SkillActionDefinition }
// Phase 4: SkillInputValue re-export preserved as a type-only passthrough for
// callers that still import it from here (no runtime impact).
export type { SkillInputValue }

/**
 * Test-only handle for the legacy-status leakage guard tests (T2). These
 * three helpers are the adapter edge between the legacy detached vocabulary
 * (`running / done / cancelled / failed / blocked`) and the public supervisor
 * vocabulary (`running / completed / killed / failed / blocked / ...`).
 *
 * Exposed via a single namespaced object so the production surface stays
 * unchanged while the regression guards can iterate the legacy set
 * exhaustively and assert the produced snapshot fields never reintroduce
 * `'background_running'`, `'done'`, or `'cancelled'`.
 */
export const __skillsToolsInternalsForTests = {
  detachedStatusToSupervisorStatus,
  detachedStatusToLiveness,
  makeSupervisorSnapshotForContract,
}

/**
 * Phase 6 — dispatch a child-loop owned typed action through
 * `startSkillChildRun`. Returns a `ToolExecutionOutput` with:
 *   - text body  : a JSON envelope the model can read
 *                  (`status: 'child_launched' | 'child_reused' | 'child_paused'`)
 *   - framePatch : `runContract.{childRunId, parentNextHint}` + `livenessHint`
 *                  + `activeArtifactRoots` so the next turn's contract loader
 *                  sees child ownership.
 *   - contextModifier: same artifact root + a (skeletal) `runContract` so
 *                      same-batch dependent tools (e.g. `skill_read_artifact`)
 *                      see the live outputDir without waiting for next turn.
 *
 * Does NOT await the child run. The runner emits a separate close event
 * (and the next turn's `loadSkillRunContract` reads it).
 */
async function dispatchChildLoopSkillAction(params: {
  toolName: string
  skillId: string
  action: string
  args: Record<string, unknown>
  sessionId?: string
  scopeId: string | null
  stepId: string
  agentContext?: AgentSpawnContext | null
  runtimeContext?: SkillToolRuntimeContext
}): Promise<ToolExecutionOutput> {
  const { toolName, skillId, action, args, sessionId, scopeId, stepId, agentContext, runtimeContext } = params

  let result: Awaited<ReturnType<typeof startSkillChildRun>>
  try {
    result = await startSkillChildRun({
      scopeId,
      sessionId: sessionId || null,
      skillId,
      action,
      requestedInput: args,
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
      agentContext: agentContext ?? null,
    })
  } catch (error) {
    // The runner is supposed to surface refusals as `recoverable_paused` /
    // `failed` close events, not throws. Treat a throw as infra-level and
    // record a failure event so the projection / metric pipeline notices.
    const message = error instanceof Error ? error.message : String(error)
    recordSkillTaskEvent({
      scopeId: runtimeContext?.scopeId,
      sessionId,
      runId: runtimeContext?.runId,
      agent: runtimeContext?.agent,
      skillId,
      skillName: undefined,
      toolName,
      action,
      runKind: 'typed_action',
      stepId,
      status: 'error',
      message: `child runner unavailable: ${message}`,
      failureKind: 'child_runner_unavailable',
      failureDetail: message,
    })
    return createToolExecutionOutput(`child runner unavailable: ${message}`, {
      shape: 'json',
      data: {
        status: 'child_runner_unavailable',
        skillId,
        action,
        error: message,
      },
    })
  }

  // Map runner status → tool envelope status.
  const envelopeStatus: 'child_launched' | 'child_reused' | 'child_paused' | 'child_terminal' = (() => {
    if (result.status === 'reused') return 'child_reused'
    if (result.status === 'recoverable_paused' || result.status === 'queued' || result.status === 'blocked') {
      return 'child_paused'
    }
    if (result.status === 'failed' || result.status === 'completed' || result.status === 'killed') {
      return 'child_terminal'
    }
    return 'child_launched'
  })()

  // Record only the parent launcher operation here. Durable liveness belongs
  // to the child-run row created by `startSkillChildRun`; keeping the launcher
  // `running` leaves stale parent rows that can poison unrelated later turns.
  const trackerStatus: SkillTaskEventStatus = (() => {
    if (envelopeStatus === 'child_terminal' && (result.status === 'failed' || result.status === 'killed')) return 'error'
    if (envelopeStatus === 'child_paused') return 'blocked'
    return 'done'
  })()
  const shouldAttachLauncherPaths = envelopeStatus === 'child_paused' || envelopeStatus === 'child_terminal'

  recordSkillTaskEvent({
    scopeId: runtimeContext?.scopeId,
    sessionId,
    runId: runtimeContext?.runId,
    agent: runtimeContext?.agent,
    skillId,
    skillName: undefined,
    toolName,
    action,
    runKind: 'typed_action',
    stepId,
    status: trackerStatus,
    message: envelopeStatus === 'child_terminal'
      ? (result.closeEvent?.error?.message || 'child run completed on launch')
      : `child run ${envelopeStatus} (id=${result.childRunId})`,
    artifactPath: shouldAttachLauncherPaths ? result.outputDir || undefined : undefined,
    artifactLabel: shouldAttachLauncherPaths && result.outputDir ? '技能输出目录' : undefined,
    outputDir: shouldAttachLauncherPaths ? result.outputDir || null : null,
    runStatePath: shouldAttachLauncherPaths ? result.runStatePath || null : null,
    detachedTaskId: undefined,
  })

  // Build a minimal `SkillRunContract` carrying the child handle so the
  // framePatch + contextModifier flow it forward without re-reading from
  // the repository. We anchor the contract via `loadSkillRunContract` (so
  // any of its other reconciliation paths still run when applicable),
  // then override with the live child handle the runner just produced.
  const livenessHintForContract: SkillRunContract['liveness'] = (() => {
    if (envelopeStatus === 'child_terminal') {
      if (result.status === 'failed' || result.status === 'killed') return 'failed'
      if (result.status === 'completed') return 'done'
      return 'unknown'
    }
    if (envelopeStatus === 'child_paused') return 'recoverable_paused'
    return 'running_process'
  })()

  const contract = loadSkillRunContract({
    scopeId,
    sessionId: sessionId || null,
    skillId,
    outputDir: result.outputDir || null,
    runStatePath: result.runStatePath || null,
    supervisorSnapshot: null,
    projectionSibling: null,
    referenceHint: sessionId ? getLastReferenceSkill(sessionId) : null,
    originalInput: args,
    sourceUrl: deriveSourceUrlFromActionInput(args),
    toolName,
    actionInput: args,
    jobId: null,
  })
  if (contract) {
    contract.childRunId = result.childRunId
    contract.parentNextHint = result.parentNextHint
    if (result.closeEvent) {
      contract.childCloseEvent = result.closeEvent
    }
    if (result.outputDir && !contract.artifactRoots.includes(result.outputDir)) {
      contract.artifactRoots = [result.outputDir, ...contract.artifactRoots]
    }
  }

  const framePatch = buildContractFramePatch({
    contract,
    activeArtifactRoots: result.outputDir ? [result.outputDir] : null,
    livenessHint: livenessHintForContract,
  })

  const contextModifier = result.outputDir
    ? {
      activeFrame: {
        activeArtifactRoots: [result.outputDir],
        ...(contract ? { runContract: contract } : {}),
      },
    }
    : null

  const envelope: Record<string, unknown> = {
    status: envelopeStatus,
    childRunId: result.childRunId,
    skillId,
    action,
    outputDir: result.outputDir,
    runStatePath: result.runStatePath,
    eventLogPath: result.eventLogPath,
    parentNextHint: result.parentNextHint,
  }
  if (envelopeStatus === 'child_paused' || envelopeStatus === 'child_terminal') {
    envelope.closeEvent = result.closeEvent
  }

  const text = JSON.stringify(envelope)

  return createToolExecutionOutput(text, {
    shape: 'json',
    data: envelope,
    framePatch,
    contextModifier,
  })
}
