/**
 * Phase 5 — Video Expert Analyzer (VEA) child driver.
 *
 * Owns:
 *   - First-action selection (pipeline vs ai_analyze) based on current
 *     `run_state.json`.
 *   - Resume planning when a child run wakes up against an existing output
 *     dir.
 *   - Close-event synthesis for terminal run-state shapes (completed /
 *     blocked / missing handles).
 *
 * The driver does NOT spawn anything itself — it returns plans that the
 * runner executes via `SkillsRuntimeManager.runSkill`. That keeps every
 * shell hop on the existing skill-host conventions (CLAUDE.md §6.12).
 *
 * Tests live in `src/__tests__/video-expert-child-driver.test.ts`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type { SkillRunResult } from '../skills-runtime/runtime-manager'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { resolveAIConfigCapabilities, type AIModelConfig } from '../../../shared/ai-providers'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'

import { logAgentMetric } from './metrics'
import type { SkillRunContract } from './run-contracts'
import { inspectSkillProgressArtifacts, type SkillProgressArtifacts } from './skill-progress-artifacts'
import {
  registerSkillChildDriver,
  type SkillChildDriver,
} from './skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
  SkillChildLaunchParams,
} from './skill-child-run-types'

const VEA_SKILL_ID = 'video-expert-analyzer'
const PIPELINE_ACTION = 'video_expert_pipeline'
const AI_ANALYZE_ACTION = 'video_expert_ai_analyze'
const BUILTIN_PROVIDER_IDS = new Set(['openai', 'anthropic', 'gemini', 'fox', 'moonshot', 'volcengine'])

interface VeaDriverState extends SkillChildDriverState {
  skillId: string
  requestedAction: string
  outputDir: string | null
  runStatePath: string | null
  requestedInput: Record<string, unknown>
  parsedRunState: ParsedVeaRunState | null
  agentContext: AgentSpawnContext | null
  /** Tracks how many internal actions the driver has already planned —
   *  the runner itself enforces budget, but the driver uses this to make
   *  the second plan idempotent (e.g. don't re-plan pipeline after the
   *  first call). */
  actionsPlanned: number
}

interface ParsedVeaRunState {
  status: string | null
  currentStage: string | null
  sceneScoresPath: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
  configIssue: boolean
}

type VeaProviderPreflightConfigReader = () => AIModelConfig | null

let providerPreflightConfigReaderForTests: VeaProviderPreflightConfigReader | null = null
let settingsRepository: AppSettingsRepository | null = null

const COMPLETED_STATUSES = new Set(['completed', 'success', 'done', 'succeeded', 'complete'])
const READY_TO_FINALIZE_STATUSES = new Set(['ready_to_resume', 'ready_to_finalize'])
const BLOCKED_STATUSES = new Set([
  'blocked',
  'pending_review',
  'awaiting_input',
  'paused',
])
const FAILED_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled'])
const POST_SCORE_STAGES = new Set(['score_batches', 'merge_validate', 'finalize'])

function trim(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

function trimLower(value: unknown): string | null {
  return trim(value)?.toLowerCase() ?? null
}

function readCurrentAIConfigForPreflight(): AIModelConfig | null {
  if (providerPreflightConfigReaderForTests) {
    return providerPreflightConfigReaderForTests()
  }
  try {
    settingsRepository ??= new AppSettingsRepository()
    return settingsRepository.getAIConfig()
  } catch {
    return null
  }
}

function modelRef(provider: string, model: string): string {
  return `${provider}/${model}`
}

function isCustomProvider(provider: string): boolean {
  return provider === 'openai-compatible' || !BUILTIN_PROVIDER_IDS.has(provider)
}

function isKnownTextOnlyModel(provider: string, model: string): boolean {
  const p = provider.toLowerCase()
  const m = model.toLowerCase()
  if (p === 'moonshot') return true
  if (m.includes('codex')) return true
  if (m.includes('kimi-for-coding')) return true
  if (m.startsWith('moonshot-v1')) return true
  if (m === 'o3-mini') return true
  if (m.startsWith('doubao-')) return true
  if (m.startsWith('seedream-') || m.startsWith('seedance-')) return true
  return false
}

function isKnownVisionModel(provider: string, model: string): boolean {
  const p = provider.toLowerCase()
  const m = model.toLowerCase()
  if (p === 'anthropic' && (m.startsWith('claude-3') || m.startsWith('claude-opus-4') || m.startsWith('claude-sonnet-4'))) return true
  if (p === 'gemini' && m.startsWith('gemini-')) return true
  if ((p === 'openai' || p === 'fox') && (m.startsWith('gpt-4o') || m.startsWith('gpt-4.1') || m.startsWith('gpt-5.4'))) return true
  if (m.includes('glm-5v') || m.includes('glm-4v') || m.includes('qwen-vl') || m.includes('mimo-v2-omni')) return true
  return false
}

function hasExplicitAgentProtocol(config: AIModelConfig): boolean {
  return config.agentProtocol === 'anthropic' || config.agentProtocol === 'openai'
}

function findCurrentModelVisionIssue(config: AIModelConfig): string | null {
  const provider = trim(config.provider)
  const model = trim(config.model)
  if (!provider || !model) return 'active AI config is missing provider or model.'
  const ref = modelRef(provider, model)
  if (config.visionMode === 'off') return `current model ${ref} has vision disabled.`
  if (config.visionMode === 'on') return null
  if (isKnownTextOnlyModel(provider, model)) return `current model ${ref} is text-only.`
  if (isKnownVisionModel(provider, model)) return null
  const capabilities = resolveAIConfigCapabilities(config)
  if (capabilities?.supportsVision && (!isCustomProvider(provider) || hasExplicitAgentProtocol(config))) {
    return null
  }
  if (isCustomProvider(provider)) {
    return `current custom provider ${ref} is unverified for image input; set visionMode=on after verifying it can read images.`
  }
  return `current model ${ref} is not verified image-capable.`
}

function findAgentContextVisionIssue(agent: AgentSpawnContext): string | null {
  const provider = trim(agent.provider)
  const model = trim(agent.model_id)
  if (!provider || !model) return 'active agent context is missing provider or model.'
  const ref = modelRef(provider, model)
  const inputModes = Array.isArray(agent.input_modes) ? agent.input_modes.map((item) => String(item).toLowerCase()) : []
  if (!inputModes.includes('image')) return `current model ${ref} is not declared image-capable by the active agent context.`
  return null
}

function pickString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = trim(rec[key])
    if (v) return v
  }
  return null
}

function pickNumber(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = rec[key]
    if (v === null || v === undefined) continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function readRunState(runStatePath: string | null): ParsedVeaRunState | null {
  if (!runStatePath) return null
  let raw: string
  try {
    raw = readFileSync(runStatePath, 'utf-8')
  } catch {
    return null
  }
  let rec: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    rec = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const status = trimLower(rec.status)
  const currentStage = pickString(rec, ['current_stage', 'currentStage', 'current_step', 'currentStep'])
  const sceneScoresPath = pickString(rec, ['scene_scores_path', 'sceneScoresPath', 'scores_path'])
  const totalScenes = pickNumber(rec, ['total_scenes', 'totalScenes'])
  const completedScenes = pickNumber(rec, ['completed_scenes', 'completedScenes'])
  const coverageRatio = pickNumber(rec, ['coverage_ratio', 'coverageRatio'])
  const blockerKind = trimLower(rec.blocker_kind ?? rec.blockerKind)
  const failureKind = trimLower(rec.failure_kind ?? rec.failureKind)
  const configIssue = (blockerKind === 'config' || blockerKind === 'config_repair' || failureKind === 'config')
  return {
    status,
    currentStage,
    sceneScoresPath,
    totalScenes,
    completedScenes,
    coverageRatio,
    configIssue,
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function inferSceneScoresPath(parsed: ParsedVeaRunState | null, outputDir: string | null): string | null {
  if (parsed?.sceneScoresPath) {
    const candidate = isAbsolute(parsed.sceneScoresPath) || !outputDir
      ? parsed.sceneScoresPath
      : join(outputDir, parsed.sceneScoresPath)
    if (existsSync(candidate)) return candidate
    return candidate
  }
  if (!outputDir) return null
  const guessed = join(outputDir, 'scene_scores.json')
  return existsSync(guessed) ? guessed : null
}

function hasUnfinishedArtifactProgress(progress: SkillProgressArtifacts): boolean {
  if (!progress.hasEvidence) return false
  if (progress.totalScenes !== null && progress.completedScenes !== null && progress.completedScenes < progress.totalScenes) {
    return true
  }
  if (progress.hostBatches && progress.hostBatches.completedBatches < progress.hostBatches.totalBatches) {
    return true
  }
  return false
}

function expandHome(path: string): string {
  if (path === '~') return process.env.HOME || homedir()
  if (path.startsWith('~/')) return join(process.env.HOME || homedir(), path.slice(2))
  return path
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function findPreferredModelConfigIssue(): string | null {
  const configPath = expandHome('~/.config/video-expert-analyzer-vnext/config.json')
  const config = existsSync(configPath) ? readJson(configPath) : null
  const autoScoring = getObject(config?.auto_scoring)
  const preferredModel = trim(autoScoring?.preferred_model) || 'kcode/K2.6-code-preview'
  const modelsJsonPath = trim(autoScoring?.models_json_path)
  const configuredCatalogPath = modelsJsonPath ? expandHome(modelsJsonPath) : null
  const catalogPath = configuredCatalogPath && existsSync(configuredCatalogPath)
    ? configuredCatalogPath
    : findDefaultOpenClawModelsJson()

  if (!catalogPath) {
    return null
  }

  const catalog = existsSync(catalogPath) ? readJson(catalogPath) : null
  const providers = getObject(catalog?.providers)
  if (!providers) return `models catalog has no providers for ${preferredModel}.`

  const slash = preferredModel.indexOf('/')
  if (slash <= 0 || slash === preferredModel.length - 1) {
    return `preferred model ${preferredModel} is not provider/model form.`
  }
  const providerName = preferredModel.slice(0, slash)
  const modelId = preferredModel.slice(slash + 1)
  const provider = getObject(providers[providerName])
  if (!provider) return `preferred model ${preferredModel} references missing provider ${providerName}.`
  const models = Array.isArray(provider.models) ? provider.models : []
  const modelEntry = models.map(getObject).find((model) => model?.id === modelId)
  if (!modelEntry) return `preferred model ${preferredModel} is not in provider ${providerName} catalog.`
  const input = Array.isArray(modelEntry.input) ? modelEntry.input.map((item) => String(item).toLowerCase()) : []
  return input.includes('image') ? null : `preferred model ${preferredModel} is not declared image-capable.`
}

function findDefaultOpenClawModelsJson(): string | null {
  const root = process.env.OPENCLAW_ROOT || join(process.env.HOME || homedir(), '.openclaw')
  const explicit = process.env.OPENCLAW_MODELS_JSON
  if (explicit && existsSync(expandHome(explicit))) return expandHome(explicit)
  const agentsDir = join(root, 'agents')
  try {
    const candidates: Array<{ agentName: string; path: string }> = []
    for (const agentName of readdirSync(agentsDir)) {
      const candidate = join(agentsDir, agentName, 'agent', 'models.json')
      if (existsSync(candidate)) candidates.push({ agentName, path: candidate })
    }
    candidates.sort((a, b) => {
      const aMain = a.agentName === 'main' ? 0 : 1
      const bMain = b.agentName === 'main' ? 0 : 1
      return aMain - bMain || a.agentName.localeCompare(b.agentName)
    })
    return candidates[0]?.path || null
  } catch {
    return null
  }
}

function shouldPreflightFirstVeaAction(state: VeaDriverState): boolean {
  return state.actionsPlanned === 0
}

function findVeaProviderPreflightIssue(agentContext: AgentSpawnContext | null): string | null {
  if (agentContext) return findAgentContextVisionIssue(agentContext)
  const currentConfig = readCurrentAIConfigForPreflight()
  if (currentConfig) return findCurrentModelVisionIssue(currentConfig)
  return findPreferredModelConfigIssue()
}

function makeBaseClose(
  state: VeaDriverState,
  parsed: ParsedVeaRunState | null,
  artifactProgress?: SkillProgressArtifacts | null,
): Omit<SkillChildCloseEvent, 'status' | 'terminalReason' | 'error'> {
  const sceneScoresPath = artifactProgress?.sceneScoresPath || inferSceneScoresPath(parsed, state.outputDir)
  return {
    childRunId: '',
    skillId: VEA_SKILL_ID,
    outputDir: state.outputDir,
    runStatePath: state.runStatePath,
    sceneScoresPath,
    deliveryReportPath: null,
    progress: {
      stage: parsed?.currentStage ?? null,
      totalUnits: artifactProgress?.totalScenes ?? parsed?.totalScenes ?? null,
      completedUnits: artifactProgress?.completedScenes ?? parsed?.completedScenes ?? null,
      coverageRatio: artifactProgress?.coverageRatio ?? parsed?.coverageRatio ?? null,
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
  }
}

function isClose(value: unknown): value is SkillChildCloseEvent {
  return typeof value === 'object' && value !== null
    && 'status' in (value as Record<string, unknown>)
    && 'terminalReason' in (value as Record<string, unknown>)
}

function maybeBlockVeaProviderPreflight(state: VeaDriverState, parsed: ParsedVeaRunState | null, artifactProgress: SkillProgressArtifacts): SkillChildCloseEvent | null {
  if (!shouldPreflightFirstVeaAction(state)) return null
  const issue = findVeaProviderPreflightIssue(state.agentContext)
  if (!issue) return null
  return {
    ...makeBaseClose(state, parsed, artifactProgress),
    status: 'blocked',
    terminalReason: 'blocked_config',
    error: {
      kind: 'blocked_config',
      message: `VEA provider preflight failed: ${issue}`,
    },
  }
}

function makeAiAnalyzePlan(
  state: VeaDriverState,
  parsed: ParsedVeaRunState | null,
  artifactProgress: SkillProgressArtifacts,
  input: Record<string, unknown>,
): SkillChildDriverAction | SkillChildCloseEvent {
  const blocked = maybeBlockVeaProviderPreflight(state, parsed, artifactProgress)
  if (blocked) return blocked
  state.actionsPlanned += 1
  return { action: AI_ANALYZE_ACTION, input }
}

class VideoExpertChildDriver implements SkillChildDriver {
  readonly skillId = VEA_SKILL_ID

  ownsSkill(skillId: string): boolean {
    return skillId === VEA_SKILL_ID
  }

  canStart(input: Record<string, unknown>): boolean {
    // The pipeline action requires either a URL or a pre-existing output
    // dir we can resume from. AI-analyze can also start fresh if a
    // sceneScoresPath is supplied directly.
    const url = trim(input.url)
    const outputDir = trim(input.outputDir)
    const sceneScoresPath = trim(input.sceneScoresPath)
    return Boolean(url || outputDir || sceneScoresPath)
  }

  canResume(contract: SkillRunContract): boolean {
    return contract.skillId === VEA_SKILL_ID
  }

  async createInitialState(params: SkillChildLaunchParams): Promise<SkillChildDriverState> {
    const requestedInput = { ...(params.requestedInput || {}) }
    // Prefer an explicit outputDir (from requestedInput or the launch
    // params). When the caller only provides `sceneScoresPath` (the AI
    // scoring cold-start case from RSS visual flow), derive outputDir
    // from the parent directory so the driver still has somewhere to
    // read run_state.json from after the action runs.
    const explicitOutputDir = trim(requestedInput.outputDir) || trim(params.outputDir)
    const requestedSceneScoresPath = trim(requestedInput.sceneScoresPath)
    const outputDirInput = explicitOutputDir
      || (requestedSceneScoresPath ? dirname(requestedSceneScoresPath) : null)
    const runStatePath = outputDirInput ? join(outputDirInput, 'run_state.json') : null
    const parsedRunState = readRunState(runStatePath)
    const state: VeaDriverState = {
      skillId: VEA_SKILL_ID,
      requestedAction: params.action,
      outputDir: outputDirInput,
      runStatePath,
      requestedInput,
      parsedRunState,
      agentContext: params.agentContext ?? null,
      actionsPlanned: 0,
    }
    return state
  }

  async planNextAction(
    rawState: SkillChildDriverState,
  ): Promise<SkillChildDriverAction | SkillChildCloseEvent> {
    const state = rawState as VeaDriverState
    // Always re-read run_state — the runner observes after each action,
    // but a resume call lands here straight without an observation.
    const parsed = state.runStatePath ? readRunState(state.runStatePath) : null
    state.parsedRunState = parsed ?? state.parsedRunState
    const artifactProgress = inspectSkillProgressArtifacts({
      outputDir: state.outputDir,
      sceneScoresPath: trim(state.requestedInput.sceneScoresPath),
    })
    const explicitSceneScoresPath = trim(state.requestedInput.sceneScoresPath)
    const sceneScoresPath = explicitSceneScoresPath
      ?? artifactProgress.sceneScoresPath
      ?? inferSceneScoresPath(parsed, state.outputDir)
    const stagePostScore = parsed?.currentStage
      ? POST_SCORE_STAGES.has(parsed.currentStage)
      : false
    const readyToFinalize = parsed?.status ? READY_TO_FINALIZE_STATUSES.has(parsed.status) : false

    if (parsed?.status && COMPLETED_STATUSES.has(parsed.status) && hasUnfinishedArtifactProgress(artifactProgress)) {
      if (sceneScoresPath) {
        const input: Record<string, unknown> = { sceneScoresPath }
        const mode = trim(state.requestedInput.mode)
        if (mode) input.mode = mode
        if (state.outputDir) input.outputDir = state.outputDir
        return makeAiAnalyzePlan(state, parsed, artifactProgress, input)
      }
      return {
        ...makeBaseClose(state, parsed, artifactProgress),
        status: 'recoverable_paused',
        terminalReason: 'checkpoint_background',
        error: {
          kind: 'stale_completed_run_state',
          message: 'VEA run_state is completed but progress artifacts are incomplete',
        },
      }
    }

    // Terminal: completed.
    if (parsed?.status && COMPLETED_STATUSES.has(parsed.status)) {
      return {
        ...makeBaseClose(state, parsed, artifactProgress),
        status: 'completed',
        terminalReason: 'completed',
        error: null,
      }
    }

    // A blocked score_batches run can be a stale provider/batch failure, not a
    // terminal human blocker. If durable artifacts prove work is incomplete,
    // try the AI scoring action again; its provider preflight will still stop
    // real config problems before any host batches launch.
    if (
      parsed?.status
      && BLOCKED_STATUSES.has(parsed.status)
      && !parsed.configIssue
      && parsed.currentStage === 'score_batches'
      && sceneScoresPath
      && hasUnfinishedArtifactProgress(artifactProgress)
    ) {
      const input: Record<string, unknown> = { sceneScoresPath }
      const mode = trim(state.requestedInput.mode)
      if (mode) input.mode = mode
      if (state.outputDir) input.outputDir = state.outputDir
      return makeAiAnalyzePlan(state, parsed, artifactProgress, input)
    }

    // A blocked finalize can be stale after the underlying VEA script is fixed
    // or after scoring artifacts complete asynchronously. If scoring evidence
    // is complete but delivery outputs are still missing, give the typed action
    // a chance to run the finalize path instead of freezing the parent task.
    if (
      parsed?.status
      && BLOCKED_STATUSES.has(parsed.status)
      && !parsed.configIssue
      && parsed.currentStage === 'finalize'
      && sceneScoresPath
      && artifactProgress.hasEvidence
      && !hasUnfinishedArtifactProgress(artifactProgress)
    ) {
      const input: Record<string, unknown> = { sceneScoresPath }
      const mode = trim(state.requestedInput.mode)
      if (mode) input.mode = mode
      if (state.outputDir) input.outputDir = state.outputDir
      return makeAiAnalyzePlan(state, parsed, artifactProgress, input)
    }

    // Terminal: blocked / awaiting input.
    if (parsed?.status && BLOCKED_STATUSES.has(parsed.status)) {
      const reason: SkillChildCloseEvent['terminalReason'] = parsed.configIssue
        ? 'blocked_config'
        : 'blocked_external'
      return {
        ...makeBaseClose(state, parsed, artifactProgress),
        status: 'blocked',
        terminalReason: reason,
        error: {
          kind: parsed.configIssue ? 'blocked_config' : 'blocked_external',
          message: `VEA run state reports status=${parsed.status}`,
        },
      }
    }

    // Terminal: skill-declared failure.
    if (parsed?.status && FAILED_STATUSES.has(parsed.status)) {
      return {
        ...makeBaseClose(state, parsed, artifactProgress),
        status: 'failed',
        terminalReason: 'failed_skill',
        error: { kind: 'failed_skill', message: `VEA run state reports status=${parsed.status}` },
      }
    }

    // Prefer the caller's explicit sceneScoresPath before falling back to
    // inference from run_state / outputDir. This is what unlocks the AI
    // scoring cold-start path where the caller already produced
    // scene_scores.json out-of-band (e.g. RSS visual flow's second stage).
    if (sceneScoresPath && (stagePostScore || readyToFinalize)) {
      const input: Record<string, unknown> = { sceneScoresPath }
      const mode = trim(state.requestedInput.mode)
      if (mode) input.mode = mode
      return makeAiAnalyzePlan(state, parsed, artifactProgress, input)
    }

    // Cold-start AI-analyze: caller passed an explicit sceneScoresPath and
    // the run_state (if any) does not place us inside an active pipeline
    // stage. We treat this as a direct AI scoring request rather than
    // forcing the full pipeline. The actionsPlanned guard keeps us from
    // re-planning the same action forever after the runtime has already
    // executed it once — the runner re-reads run_state via
    // observeAfterAction, so subsequent ticks should fall through to the
    // run_state-driven branches above (or close on completion).
    if (explicitSceneScoresPath && state.actionsPlanned === 0 && !parsed) {
      const input: Record<string, unknown> = { sceneScoresPath: explicitSceneScoresPath }
      const mode = trim(state.requestedInput.mode)
      if (mode) input.mode = mode
      if (state.outputDir) input.outputDir = state.outputDir
      return makeAiAnalyzePlan(state, parsed, artifactProgress, input)
    }

    // Need scene_scores to advance but no path is reachable → recoverable pause.
    if (stagePostScore && !sceneScoresPath) {
      return {
        ...makeBaseClose(state, parsed, artifactProgress),
        status: 'recoverable_paused',
        terminalReason: 'checkpoint_background',
        error: {
          kind: 'missing_scene_scores',
          message: 'VEA stage requires scene_scores.json but path is missing',
        },
      }
    }

    // Default: kick off the full pipeline. This is the cold-start path.
    const url = trim(state.requestedInput.url)
    if (url) {
      const blocked = maybeBlockVeaProviderPreflight(state, parsed, artifactProgress)
      if (blocked) return blocked
      const input: Record<string, unknown> = { url }
      if (state.outputDir) input.outputDir = state.outputDir
      const sceneThreshold = state.requestedInput.sceneThreshold
      if (sceneThreshold !== undefined && sceneThreshold !== null) input.sceneThreshold = sceneThreshold
      const bestThreshold = state.requestedInput.bestThreshold
      if (bestThreshold !== undefined && bestThreshold !== null) input.bestThreshold = bestThreshold
      state.actionsPlanned += 1
      return { action: PIPELINE_ACTION, input }
    }

    // Edge case: no URL, no scene_scores, no useful run_state — surface as a
    // recoverable pause so the parent can ask the user instead of looping.
    return {
      ...makeBaseClose(state, parsed, artifactProgress),
      status: 'recoverable_paused',
      terminalReason: 'checkpoint_background',
      error: {
        kind: 'missing_inputs',
        message: 'VEA driver has no URL and no resumable scene scores',
      },
    }
  }

  async observeAfterAction(
    rawState: SkillChildDriverState,
    result: SkillRunResult,
  ): Promise<SkillChildDriverState> {
    const state = rawState as VeaDriverState
    // Honor the runtime's view of where outputs landed.
    if (
      typeof result.outputDir === 'string'
      && result.outputDir.trim()
      && result.outputDir.trim() !== state.outputDir
    ) {
      state.outputDir = result.outputDir.trim()
      state.runStatePath = join(state.outputDir, 'run_state.json')
    }
    state.parsedRunState = state.runStatePath ? readRunState(state.runStatePath) : null
    return state
  }
}

const veaDriver = new VideoExpertChildDriver()
registerSkillChildDriver(veaDriver)

function __setVeaProviderPreflightConfigReaderForTests(reader: VeaProviderPreflightConfigReader | null): void {
  providerPreflightConfigReaderForTests = reader
}

export { veaDriver as videoExpertChildDriver }
export { getSkillChildDriver } from './skill-child-drivers'
export type { SkillChildDriver } from './skill-child-drivers'

// Light metric to confirm registration ordering during boot.
try {
  logAgentMetric('skill_child_driver_registered', { skillId: VEA_SKILL_ID })
} catch {
  // metric registration is best-effort.
}

export { isClose as __isCloseForTests }
export { __setVeaProviderPreflightConfigReaderForTests }
