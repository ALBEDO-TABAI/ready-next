import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { join, delimiter } from 'path'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'

// See database.ts for the full rationale. Electron's Node entry is a CJS
// string-export, so ESM `import { app } from 'electron'` breaks tsx/ESM tests
// that transitively load this file (e.g. via tool-registry → skills-tools →
// runtime-manager). `createRequire(...)('electron')` succeeds in both the real
// Electron runtime (named members populated) and in plain Node (destructuring
// a string yields `undefined`, which is caught by downstream try/catch when a
// method such as `app.getPath` is actually invoked).
const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch { return {} as typeof import('electron') }
})()
const { app } = electronModule
import { getDatabase } from '../database'
import { getWhichCommand } from '../../utils/platform'
import { EMBEDDED_SKILLS, type EmbeddedSkillId, type EmbeddedSkillManifest, getEmbeddedSkillManifest } from './manifest'
import type {
  ExecutionBlocker,
  SkillActionDefinition,
  SkillActionResult,
  SkillDefinition,
  SkillExecutionDetail,
  SkillExecutionMode,
  SkillExecutionState,
  SkillInputValue,
  SkillParamDefinition,
  SkillRuntimeKind,
  SkillSource,
} from '../../../shared/skill-execution-types'
import {
  type RegisteredCustomSkill,
  getManagedCustomSkill,
  importCustomSkillFolder,
  listManagedCustomSkills,
  removeManagedCustomSkill,
  updateManagedCustomSkillDescription,
} from './custom-skill-registry'
import { SkillLoader } from './skill-loader'
import { ExecutionStateStore } from './execution-state-store'
import { ExecutionCoordinator } from './execution-coordinator'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'
import { isWorkflowStarterAction } from './guardrails'
import { EphemeralExecutionStore } from '../tools/skill-ephemeral-ask-user'

const execFileAsync = promisify(execFile)

const INSTALL_STATE_FILENAME = '.ready-install-state.json'
const MAX_COMMAND_BUFFER = 24 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
const SCHEDULER_INTERVAL_MS = 60_000

const DOUYIN_COMPAT_SHIM = `#!/usr/bin/env python3
"""
Compatibility adapter for pipeline_enhanced.py.
The project now ships download_douyin.py, while pipeline imports douyin_downloader.
This shim keeps the expected class interface.
"""

from pathlib import Path
import sys

_scripts_dir = Path(__file__).parent
if str(_scripts_dir) not in sys.path:
    sys.path.insert(0, str(_scripts_dir))

from download_douyin import (  # type: ignore
    is_douyin_url,
    get_redirect_url,
    extract_render_data,
    extract_video_url,
    download_douyin_video,
)


class DouyinDownloader:
    @staticmethod
    def is_douyin_url(url: str) -> bool:
        return bool(is_douyin_url(url))

    def get_redirect_url(self, url: str):
        result = get_redirect_url(url)
        if not isinstance(result, tuple):
            return None, None
        if len(result) >= 2:
            return result[0], result[1]
        return None, None

    def extract_render_data(self, html: str):
        return extract_render_data(html)

    def extract_video_url(self, data):
        return extract_video_url(data)

    def download(self, url: str, output_path) -> bool:
        return bool(download_douyin_video(url, str(output_path)))
`

type SkillTriggerType = 'manual' | 'tool' | 'schedule'
export type SkillId = string

export interface SkillState {
  id: SkillId
  name: string
  description: string
  version: string
  installed: boolean
  installStatePath: string
  source: SkillSource
  manifestValid: boolean
  defaultAction?: string
  actions: SkillActionDefinition[]
  executionMode: SkillExecutionMode
  managedPath?: string
  sourcePath?: string
}

export interface SkillsRuntimeInfo {
  runtimeRoot: string
  skillsRoot: string
  customSkillsRoot: string
  outputsRoot: string
  venvRoot: string
}

interface SkillInstallState {
  version: string
  requirementsDigest: string
  installedAt: string
}

export interface SkillInstallResult {
  success: boolean
  skillId: SkillId
  skillPath?: string
  venvPython?: string
  error?: string
}

export interface SkillRunResult {
  success: boolean
  skillId: SkillId
  action: string
  stdout: string
  stderr: string
  outputDir?: string
  command: string[]
  error?: string
  mode?: 'direct' | 'workflow' | 'reference'
  execution?: SkillExecutionDetail | null
  blocker?: ExecutionBlocker | null
}

export interface SkillRunRequest {
  skillId: SkillId
  action: string
  params?: Record<string, unknown>
  timeoutMs?: number
  triggerType?: SkillTriggerType
  scheduleId?: string
  env?: Record<string, string>
  sessionId?: string
  executionMode?: 'auto' | 'workflow' | 'direct'
}

interface SkillJobRow {
  id: string
  skill_id: SkillId
  action: string
  params_json: string | null
  status: string
  trigger_type: SkillTriggerType
  schedule_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  stdout: string | null
  stderr: string | null
  output_dir: string | null
  error: string | null
  command_json: string | null
}

interface SkillScheduleRow {
  id: string
  skill_id: SkillId
  action: string
  params_json: string | null
  interval_minutes: number
  next_run_at: string
  last_run_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

interface DatabaseStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface DatabaseConnection {
  prepare(sql: string): DatabaseStatement
}

export interface SkillJobRecord {
  id: string
  skillId: SkillId
  action: string
  status: string
  triggerType: SkillTriggerType
  scheduleId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  stdout: string
  stderr: string
  outputDir: string | null
  error: string | null
  command: string[]
}

export interface SkillScheduleRecord {
  id: string
  skillId: SkillId
  action: string
  params: Record<string, unknown>
  intervalMinutes: number
  nextRunAt: string
  lastRunAt: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateSkillScheduleRequest {
  skillId: SkillId
  action: string
  params?: Record<string, unknown>
  intervalMinutes: number
  startAt?: string
}

function asString(value: unknown): string | null {

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.toLowerCase().trim()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return null
}

function truncateOutput(content: string, max = 18_000): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n...[truncated ${content.length - max} chars]`
}

function getInstallStatePath(skillPath: string): string {
  return join(skillPath, INSTALL_STATE_FILENAME)
}

function requirementsDigest(requirementsPath: string): string {
  if (!existsSync(requirementsPath)) return 'missing'
  const content = readFileSync(requirementsPath, 'utf-8')
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i)
    hash |= 0
  }
  return `${content.length}:${hash}`
}

export class SkillsRuntimeManager {
  private readonly runtimeRoot: string
  private readonly skillsRoot: string
  private readonly customSkillsRoot: string
  private readonly venvRoot: string
  private readonly runtimeBin: string
  private readonly cacheRoot: string
  private readonly modelscopeCache: string
  private readonly pipCache: string
  private readonly outputsRoot: string
  private loader: SkillLoader | null = null
  private executionStore: ExecutionStateStore | null = null
  private executionCoordinator: ExecutionCoordinator | null = null
  private installLocks = new Map<SkillId, Promise<SkillInstallResult>>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private ttlBootTimer: NodeJS.Timeout | null = null
  private ttlIntervalTimer: NodeJS.Timeout | null = null
  private runningScheduleIds = new Set<string>()

  private static readonly TTL_RETENTION_DAYS = 7
  private static readonly TTL_SWEEP_INTERVAL_MS = 60 * 60_000
  private static readonly TTL_BOOT_DELAY_MS = 30_000

  private static ephemeralStore: EphemeralExecutionStore | null = null

  private static initEphemeralStore(): void {
    if (!SkillsRuntimeManager.ephemeralStore) {
      SkillsRuntimeManager.ephemeralStore = new EphemeralExecutionStore()
      SkillsRuntimeManager.ephemeralStore.startSweep()
    }
  }

  static getEphemeralStore(): EphemeralExecutionStore {
    if (!SkillsRuntimeManager.ephemeralStore) {
      SkillsRuntimeManager.initEphemeralStore()
    }
    // Type assertion because we know ephemeralStore is non-null after init
    return SkillsRuntimeManager.ephemeralStore!
  }

  static clearAllEphemeralAskUser(sessionId: string): number {
    return SkillsRuntimeManager.getEphemeralStore().clearAllForSession(sessionId)
  }

  constructor() {
    this.runtimeRoot = join(app.getPath('userData'), 'skill-runtime')
    this.skillsRoot = join(this.runtimeRoot, 'skills')
    this.customSkillsRoot = join(this.runtimeRoot, 'custom-skills')
    this.venvRoot = join(this.runtimeRoot, 'python')
    this.runtimeBin = join(this.runtimeRoot, 'bin')
    this.cacheRoot = join(this.runtimeRoot, 'cache')
    this.modelscopeCache = join(this.cacheRoot, 'modelscope')
    this.pipCache = join(this.cacheRoot, 'pip')
    this.outputsRoot = join(this.runtimeRoot, 'outputs')
    this.startScheduler()
    this.startTtlSweep()
    SkillsRuntimeManager.initEphemeralStore()
  }

  /**
   * Phase 4 — periodically purge terminal skill_executions rows older than
   * the retention window. Runs once 30s after boot (avoid blocking startup)
   * and then hourly. Each run is best-effort — a failure logs to stderr and
   * the next tick tries again.
   */
  private startTtlSweep(): void {
    const sweep = (): void => {
      try {
        const store = this.getExecutionStore()
        const { deleted, cutoff } = store.purgeExpiredExecutions(
          SkillsRuntimeManager.TTL_RETENTION_DAYS,
        )
        logAgentMetric(TOOL_ERROR_METRICS.ttlSwept, {
          deleted,
          retentionDays: SkillsRuntimeManager.TTL_RETENTION_DAYS,
          cutoff,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[SkillsRuntimeManager] TTL sweep failed:', message)
      }
    }
    this.ttlBootTimer = setTimeout(sweep, SkillsRuntimeManager.TTL_BOOT_DELAY_MS)
    this.ttlIntervalTimer = setInterval(sweep, SkillsRuntimeManager.TTL_SWEEP_INTERVAL_MS)
  }

  private getSkillLoader(): SkillLoader {
    if (!this.loader) {
      this.loader = new SkillLoader(this.resolveEmbeddedSkillsRoot(), this.customSkillsRoot)
    }
    return this.loader
  }

  private toSkillState(definition: SkillDefinition): SkillState {
    const skillPath = definition.source === 'embedded'
      ? this.getSkillRuntimePath(definition.id)
      : (definition.managedPath || definition.sourcePath)
    const statePath = getInstallStatePath(skillPath)
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      installed: existsSync(statePath),
      installStatePath: statePath,
      source: definition.source,
      manifestValid: definition.manifestValid,
      defaultAction: definition.defaultAction,
      actions: definition.actions,
      executionMode: definition.executionMode,
      managedPath: definition.source === 'embedded' ? skillPath : definition.managedPath,
      sourcePath: definition.sourcePath,
    }
  }

  listSkills(): SkillState[] {
    this.ensureRuntimeDirs()
    const loader = this.getSkillLoader()
    return [
      ...loader.listEmbeddedSkills().map((definition) => this.toSkillState(definition)),
      ...loader.listCustomSkills().map((definition) => this.toSkillState(definition)),
    ]
  }

  getRuntimeInfo(): SkillsRuntimeInfo {
    this.ensureRuntimeDirs()
    return {
      runtimeRoot: this.runtimeRoot,
      skillsRoot: this.skillsRoot,
      customSkillsRoot: this.customSkillsRoot,
      outputsRoot: this.outputsRoot,
      venvRoot: this.venvRoot,
    }
  }

  private getExecutionStore(): ExecutionStateStore {
    if (!this.executionStore) {
      const db = this.getRawDatabase()
      if (!db) {
        throw new Error('Database not available')
      }
      this.executionStore = new ExecutionStateStore(db)
    }
    return this.executionStore
  }

  private getExecutionCoordinator(): ExecutionCoordinator {
    if (!this.executionCoordinator) {
      this.executionCoordinator = new ExecutionCoordinator(
        this.getExecutionStore(),
        {
          executeRuntimeAction: ({ definition, actionName, step, args, sessionId }) =>
            this.executeWorkflowRuntimeAction({
              definition,
              actionName,
              stepId: step.id,
              params: args,
              sessionId,
            }),
        },
        this.outputsRoot,
      )
    }
    return this.executionCoordinator
  }

  listExecutions(limit = 30, sessionId?: string, activeOnly = false): SkillExecutionDetail[] {
    this.ensureRuntimeDirs()
    return this.getExecutionStore()
      .listExecutions(limit, sessionId, activeOnly)
      .map((item) => this.getExecutionStore().getExecution(item.id))
      .filter((item): item is SkillExecutionDetail => Boolean(item))
  }

  getExecution(executionId: string): SkillExecutionDetail | null {
    this.ensureRuntimeDirs()
    return this.getExecutionStore().getExecution(executionId)
  }

  async submitExecutionInput(executionId: string, inputs: Record<string, SkillInputValue>): Promise<SkillExecutionDetail> {
    this.ensureRuntimeDirs()
    return this.getExecutionCoordinator().submitInput(executionId, inputs)
  }

  async submitExecutionConfirmation(executionId: string, stepId: string, confirmed: boolean): Promise<SkillExecutionDetail> {
    this.ensureRuntimeDirs()
    return this.getExecutionCoordinator().submitConfirmation(executionId, stepId, confirmed)
  }

  async submitExecutionAgentResult(params: {
    executionId: string
    stepId: string
    textContent?: string
    outputs?: Record<string, SkillInputValue>
  }): Promise<SkillExecutionDetail> {
    this.ensureRuntimeDirs()
    return this.getExecutionCoordinator().submitAgentResult(params)
  }

  async restartExecutionFromStep(
    executionId: string,
    stepId: string,
    inputs?: Record<string, SkillInputValue>,
  ): Promise<SkillExecutionDetail> {
    this.ensureRuntimeDirs()
    return this.getExecutionCoordinator().restartFromStep(executionId, stepId, inputs)
  }

  cancelExecution(executionId: string): SkillExecutionDetail | null {
    this.ensureRuntimeDirs()
    return this.getExecutionCoordinator().cancelExecution(executionId)
  }

  async runEmbeddedPython(params: {
    code?: string
    scriptPath?: string
    args?: string[]
    cwd?: string
    timeoutMs?: number
  }): Promise<{ success: boolean; stdout: string; stderr: string; command: string[]; error?: string }> {
    this.ensureRuntimeDirs()
    const venvPython = await this.ensurePythonVenv()
    let scriptPath = params.scriptPath || ''
    if (!scriptPath) {
      const code = String(params.code || '').trim()
      if (!code) {
        return { success: false, stdout: '', stderr: '', command: [], error: 'Missing code or scriptPath' }
      }
      const scriptDir = join(this.runtimeRoot, 'tmp-python')
      mkdirSync(scriptDir, { recursive: true })
      scriptPath = join(scriptDir, `ready-embedded-${randomUUID()}.py`)
      writeFileSync(scriptPath, `${code}\n`, 'utf-8')
    }
    const command = [venvPython, scriptPath, ...((params.args || []).map((item) => String(item)))]
    try {
      const { stdout, stderr } = await execFileAsync(venvPython, [scriptPath, ...((params.args || []).map((item) => String(item)))], {
        cwd: params.cwd || this.runtimeRoot,
        timeout: Math.max(1_000, params.timeoutMs || DEFAULT_TIMEOUT_MS),
        maxBuffer: MAX_COMMAND_BUFFER,
        env: this.getBaseEnv(),
      })
      return {
        success: true,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        command,
        error: err.message,
      }
    }
  }

  importCustomSkill(sourcePath: string): SkillState {
    this.ensureRuntimeDirs()
    const record = importCustomSkillFolder(sourcePath, this.customSkillsRoot)
    const definition = this.getSkillLoader().loadSkill(record.id, record.managedPath)
    return this.toSkillState(definition || {
      id: record.id,
      name: record.name,
      description: record.description,
      version: record.version,
      source: 'custom',
      sourcePath: record.sourcePath,
      managedPath: record.managedPath,
      manifestPath: record.manifestPath,
      requirementsFile: record.requirementsFile,
      defaultAction: record.defaultAction,
      actions: record.actions,
      executionMode: record.execution?.mode || 'direct',
      workflow: undefined,
      manifestValid: true,
    })
  }

  removeCustomSkill(skillId: string): { removed: boolean } {
    this.ensureRuntimeDirs()
    return { removed: removeManagedCustomSkill(this.customSkillsRoot, skillId) }
  }

  updateCustomSkillDescription(skillId: string, description: string): SkillState {
    this.ensureRuntimeDirs()
    const record = updateManagedCustomSkillDescription(this.customSkillsRoot, skillId, description)
    const definition = this.getSkillLoader().loadSkill(record.id, record.managedPath)
    return this.toSkillState(definition || {
      id: record.id,
      name: record.name,
      description: record.description,
      version: record.version,
      source: 'custom',
      sourcePath: record.sourcePath,
      managedPath: record.managedPath,
      manifestPath: record.manifestPath,
      requirementsFile: record.requirementsFile,
      defaultAction: record.defaultAction,
      actions: record.actions,
      executionMode: record.execution?.mode || 'direct',
      workflow: undefined,
      manifestValid: true,
    })
  }

  async ensureSkillInstalled(skillId: SkillId, force = false): Promise<SkillInstallResult> {
    if (!force) {
      const ongoing = this.installLocks.get(skillId)
      if (ongoing) return ongoing
    }

    const installTask = this.installSkillInternal(skillId, force)
      .finally(() => {
        this.installLocks.delete(skillId)
      })
    this.installLocks.set(skillId, installTask)
    return installTask
  }

  async runSkill(request: SkillRunRequest): Promise<SkillRunResult> {
    const triggerType = request.triggerType || 'manual'
    const jobId = this.recordJobStart({
      skillId: request.skillId,
      action: request.action,
      params: request.params,
      triggerType,
      scheduleId: request.scheduleId || null,
    })
    const finish = (result: SkillRunResult): SkillRunResult => {
      this.recordJobFinish(jobId, result)
      return result
    }

    try {
      const resolved = await this.resolveSkillForExecution(request.skillId)
      if (!resolved) {
        return finish(this.invalidParams(request.skillId, request.action, `Unknown skill: ${request.skillId}`))
      }

      const action = resolved.definition.actions.find((item) => item.name === request.action)
      if (!action) {
        return finish(this.invalidParams(resolved.definition.id, request.action, `Unknown action: ${request.action}`))
      }

      const shouldStartWorkflow =
        resolved.definition.executionMode === 'workflow' &&
        isWorkflowStarterAction(resolved.definition, request.action) &&
        request.executionMode !== 'direct' &&
        (request.executionMode === 'workflow' || request.executionMode === 'auto' || request.executionMode === undefined)

      if (shouldStartWorkflow) {
        const execution = await this.getExecutionCoordinator().startExecution({
          definition: resolved.definition,
          entryAction: request.action,
          inputs: (request.params || {}) as Record<string, SkillInputValue>,
          sessionId: request.sessionId || null,
        })
        return finish(this.toWorkflowRunResult(resolved.definition.id, request.action, execution))
      }

      return finish(await this.runDefinitionActionDirect(
        resolved.definition,
        action,
        request.params || {},
        Math.max(3_000, request.timeoutMs || action.timeoutMs || DEFAULT_TIMEOUT_MS),
        request.env,
        resolved.installResult.venvPython,
      ))
    } catch (error) {
      return finish(this.invalidParams(
        request.skillId,
        request.action,
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  private invalidParams(skillId: SkillId, action: string, error: string): SkillRunResult {
    return {
      success: false,
      skillId,
      action,
      stdout: '',
      stderr: '',
      command: [],
      error,
    }
  }

  private buildActionArgs(params: Record<string, unknown>, action: SkillActionDefinition): string[] {
    const args = [...(action.baseArgs || [])]
    if (action.inputMode === 'json') {
      if (Object.keys(params).length > 0) {
        args.push('--payload-json', JSON.stringify(params))
      }
      return args
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
      if (typeof value === 'boolean') {
        if (value) args.push(flag)
        continue
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          args.push(flag, String(entry))
        }
        continue
      }
      if (typeof value === 'object') {
        args.push(flag, JSON.stringify(value))
        continue
      }
      args.push(flag, String(value))
    }
    return args
  }

  private async resolveSkillForExecution(skillId: SkillId): Promise<{ definition: SkillDefinition; installResult: SkillInstallResult } | null> {
    this.ensureRuntimeDirs()
    const installResult = await this.ensureSkillInstalled(skillId)
    if (!installResult.success || !installResult.skillPath) {
      return null
    }
    const manifest = getEmbeddedSkillManifest(skillId)
    if (manifest) {
      this.ensureSkillCompatibilityFiles(manifest.id, installResult.skillPath)
    }
    const definition = this.getSkillLoader().loadSkill(skillId, installResult.skillPath)
    if (!definition) {
      return null
    }
    return { definition, installResult }
  }

  private async runDefinitionActionDirect(
    definition: SkillDefinition,
    action: SkillActionDefinition,
    params: Record<string, unknown>,
    timeoutMs: number,
    envOverrides?: Record<string, string>,
    venvPython?: string,
  ): Promise<SkillRunResult> {
    const skillPath = definition.source === 'embedded'
      ? this.getSkillRuntimePath(definition.id)
      : (definition.managedPath || definition.sourcePath)
    const entryPath = join(skillPath, action.entry)

    if (action.runtime === 'reference') {
      // Reference skills are advisory/guidance loads — readFileSync of SKILL.md
      // with no subprocess, no side-effects, no execution state to track. The
      // previous implementation faked `command: ['read', path]` which caused
      // formatRunResult to wrap the content in "Command: read .../SKILL.md\n
      // STDOUT:\n..." — confusing the model into thinking a shell executed and
      // sometimes triggering a follow-up `skill_get_state` probe for an
      // execution that never exists. `mode: 'reference'` lets formatRunResult
      // render the file content with a compact guidance header instead.
      try {
        const stdout = readFileSync(entryPath, 'utf-8')
        return {
          success: true,
          skillId: definition.id,
          action: action.name,
          stdout: truncateOutput(stdout),
          stderr: '',
          command: [],
          mode: 'reference',
        }
      } catch (error) {
        return {
          success: false,
          skillId: definition.id,
          action: action.name,
          stdout: '',
          stderr: '',
          command: [],
          error: error instanceof Error ? error.message : String(error),
          mode: 'reference',
        }
      }
    }

    const args = this.buildActionArgs(params, action)
    if (action.runtime === 'python') {
      if (!venvPython) {
        return this.invalidParams(definition.id, action.name, 'Python skill runtime is unavailable')
      }
      return this.runDirectScript(definition.id, skillPath, action, venvPython, [entryPath, ...args], timeoutMs, envOverrides)
    }

    if (action.runtime === 'node') {
      return this.runDirectScript(definition.id, skillPath, action, 'node', [entryPath, ...args], timeoutMs, envOverrides)
    }

    return this.runDirectScript(definition.id, skillPath, action, entryPath, args, timeoutMs, envOverrides)
  }

  private async runDirectScript(
    skillId: SkillId,
    cwd: string,
    action: SkillActionDefinition,
    commandBin: string,
    commandArgs: string[],
    timeoutMs: number,
    envOverrides?: Record<string, string>,
  ): Promise<SkillRunResult> {
    const executed = await this.executeProcessWithStructuredResult({
      skillId,
      actionName: action.name,
      runtime: action.runtime,
      cwd,
      commandBin,
      commandArgs,
      timeoutMs,
      envOverrides,
      preferStructuredResult: true,
    })
    return this.toDirectRunResult(skillId, action.name, executed)
  }

  async executeWorkflowRuntimeAction(params: {
    definition: SkillDefinition
    actionName: string
    stepId: string
    params: Record<string, SkillInputValue>
    sessionId?: string | null
  }): Promise<SkillActionResult> {
    const resolved = await this.resolveSkillForExecution(params.definition.id)
    if (!resolved) {
      return {
        ok: false,
        status: 'failed',
        outputs: {},
        artifacts: [],
        logs: { stdout: '', stderr: '' },
        error: { message: `Unknown skill: ${params.definition.id}` },
      }
    }
    const action = resolved.definition.actions.find((entry) => entry.name === params.actionName)
    if (!action) {
      return {
        ok: false,
        status: 'failed',
        outputs: {},
        artifacts: [],
        logs: { stdout: '', stderr: '' },
        error: { message: `Unknown action: ${params.actionName}` },
      }
    }
    if (action.runtime === 'reference') {
      const stdout = readFileSync(join(
        resolved.definition.source === 'embedded'
          ? this.getSkillRuntimePath(resolved.definition.id)
          : (resolved.definition.managedPath || resolved.definition.sourcePath),
        action.entry,
      ), 'utf-8')
      return {
        ok: true,
        status: 'success',
        outputs: {
          textContent: stdout,
        },
        artifacts: [],
        logs: { stdout: truncateOutput(stdout), stderr: '' },
      }
    }

    const skillPath = resolved.definition.source === 'embedded'
      ? this.getSkillRuntimePath(resolved.definition.id)
      : (resolved.definition.managedPath || resolved.definition.sourcePath)
    const entryPath = join(skillPath, action.entry)
    const args = this.buildActionArgs(params.params as Record<string, unknown>, action)
    if (action.runtime === 'python' && !resolved.installResult.venvPython) {
      return {
        ok: false,
        status: 'failed',
        outputs: {},
        artifacts: [],
        logs: { stdout: '', stderr: '' },
        error: { message: 'Python skill runtime is unavailable' },
      }
    }
    const executed = await this.executeProcessWithStructuredResult({
      skillId: resolved.definition.id,
      actionName: action.name,
      runtime: action.runtime,
      cwd: skillPath,
      commandBin: action.runtime === 'python'
        ? (resolved.installResult.venvPython || '')
        : action.runtime === 'node'
          ? 'node'
          : entryPath,
      commandArgs: action.runtime === 'python' || action.runtime === 'node'
        ? [entryPath, ...args]
        : args,
      timeoutMs: Math.max(3_000, action.timeoutMs || DEFAULT_TIMEOUT_MS),
      preferStructuredResult: true,
      envOverrides: {
        ...(params.sessionId ? { READY_SKILL_SESSION_ID: params.sessionId } : {}),
      },
    })
    if (executed.structuredResult) {
      return executed.structuredResult
    }
    return {
      ok: executed.success,
      status: executed.success ? 'success' : 'failed',
      outputs: executed.outputDir ? { outputDir: executed.outputDir } : {},
      artifacts: [],
      logs: {
        stdout: executed.stdout,
        stderr: executed.stderr,
      },
      error: executed.success ? undefined : { message: executed.error || `Step ${params.stepId} failed` },
    }
  }

  private createStructuredResultPath(skillId: string, actionName: string): string {
    const dir = join(this.runtimeRoot, 'results')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${skillId}-${actionName}-${randomUUID()}.json`)
  }

  private async executeProcessWithStructuredResult(params: {
    skillId: string
    actionName: string
    runtime: SkillRuntimeKind
    cwd: string
    commandBin: string
    commandArgs: string[]
    timeoutMs: number
    envOverrides?: Record<string, string>
    preferStructuredResult: boolean
  }): Promise<{
    success: boolean
    stdout: string
    stderr: string
    command: string[]
    error?: string
    outputDir?: string
    structuredResult?: SkillActionResult
  }> {
    const command = [params.commandBin, ...params.commandArgs]
    const resultPath = params.preferStructuredResult ? this.createStructuredResultPath(params.skillId, params.actionName) : null
    const env = {
      ...this.getBaseEnv(),
      ...(params.envOverrides || {}),
      ...(resultPath ? { READY_SKILL_RESULT_PATH: resultPath } : {}),
    }

    try {
      const { stdout, stderr } = await execFileAsync(params.commandBin, params.commandArgs, {
        cwd: params.cwd,
        timeout: params.timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env,
      })
      const structuredResult = resultPath && existsSync(resultPath)
        ? this.parseJson<SkillActionResult>(readFileSync(resultPath, 'utf-8'), undefined as never)
        : undefined
      const outputDir = structuredResult?.outputs && typeof structuredResult.outputs.outputDir === 'string'
        ? structuredResult.outputs.outputDir
        : undefined
      return {
        success: true,
        stdout: truncateOutput(stdout || structuredResult?.logs.stdout || ''),
        stderr: truncateOutput(stderr || structuredResult?.logs.stderr || ''),
        command,
        outputDir,
        structuredResult,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      const structuredResult = resultPath && existsSync(resultPath)
        ? this.parseJson<SkillActionResult>(readFileSync(resultPath, 'utf-8'), undefined as never)
        : undefined
      const outputDir = structuredResult?.outputs && typeof structuredResult.outputs.outputDir === 'string'
        ? structuredResult.outputs.outputDir
        : undefined
      return {
        success: structuredResult?.ok || false,
        stdout: truncateOutput(err.stdout || structuredResult?.logs.stdout || ''),
        stderr: truncateOutput(err.stderr || structuredResult?.logs.stderr || ''),
        command,
        outputDir,
        structuredResult,
        error: params.runtime === 'node' && err.message.includes('ENOENT')
          ? 'Node.js runtime not found. Please install Node.js or use python/shell based custom skills.'
          : (structuredResult?.error?.message || err.message),
      }
    }
  }

  private toDirectRunResult(
    skillId: string,
    actionName: string,
    executed: {
      success: boolean
      stdout: string
      stderr: string
      command: string[]
      error?: string
      outputDir?: string
      structuredResult?: SkillActionResult
    },
  ): SkillRunResult {
    const structured = executed.structuredResult
    const outputs = structured?.outputs || {}
    const extraStdout = [
      typeof outputs.outputDir === 'string' ? `Output directory: ${outputs.outputDir}` : '',
      ...Object.entries(outputs)
        .filter(([key, value]) => key !== 'outputDir' && typeof value === 'string' && value.length > 0)
        .map(([key, value]) => `${key}: ${value}`),
    ].filter(Boolean).join('\n')

    return {
      success: structured ? structured.ok : executed.success,
      skillId,
      action: actionName,
      stdout: [executed.stdout, extraStdout].filter(Boolean).join('\n').trim(),
      stderr: executed.stderr,
      outputDir: executed.outputDir,
      command: executed.command,
      error: structured?.ok ? undefined : (structured?.error?.message || executed.error),
      mode: 'direct',
    }
  }

  private toWorkflowRunResult(skillId: string, actionName: string, execution: SkillExecutionDetail): SkillRunResult {
    const summary = [
      `Execution ID: ${execution.id}`,
      `Status: ${execution.status}`,
      execution.currentStepId ? `Current step: ${execution.currentStepId}` : '',
      execution.blocker ? `Blocker: ${execution.blocker.type} - ${execution.blocker.message}` : '',
    ].filter(Boolean).join('\n')
    return {
      success: execution.status !== 'failed' && execution.status !== 'cancelled',
      skillId,
      action: actionName,
      stdout: summary,
      stderr: '',
      command: [],
      mode: 'workflow',
      execution,
      blocker: execution.blocker || null,
    }
  }

  listJobs(limit = 80): SkillJobRecord[] {
    const db = this.getRawDatabase()
    if (!db) return []
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const rows = db.prepare('SELECT * FROM skills_jobs ORDER BY created_at DESC LIMIT ?').all<SkillJobRow>(safeLimit)
    return rows.map((row) => this.mapJobRow(row))
  }

  listSchedules(): SkillScheduleRecord[] {
    const db = this.getRawDatabase()
    if (!db) return []
    const rows = db.prepare('SELECT * FROM skills_schedules ORDER BY created_at DESC').all<SkillScheduleRow>()
    return rows.map((row) => this.mapScheduleRow(row))
  }

  createSchedule(request: CreateSkillScheduleRequest): SkillScheduleRecord {
    const knownSkill = this.listSkills().some((skill) => skill.id === request.skillId)
    if (!knownSkill) {
      throw new Error(`Unknown skill: ${request.skillId}`)
    }

    const db = this.getRawDatabase()
    if (!db) {
      throw new Error('Database not available')
    }

    const intervalMinutes = Math.max(1, Math.floor(request.intervalMinutes))
    const nowIso = new Date().toISOString()
    const parsedStart = request.startAt ? new Date(request.startAt).getTime() : Number.NaN
    const firstRunIso = Number.isFinite(parsedStart)
      ? new Date(parsedStart).toISOString()
      : new Date(Date.now() + intervalMinutes * 60_000).toISOString()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO skills_schedules (
        id, skill_id, action, params_json, interval_minutes, next_run_at, last_run_at, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
    `).run(
      id,
      request.skillId,
      request.action,
      JSON.stringify(request.params || {}),
      intervalMinutes,
      firstRunIso,
      nowIso,
      nowIso,
    )
    this.runSchedulerTickSoon()
    const created = db.prepare('SELECT * FROM skills_schedules WHERE id = ?').all<SkillScheduleRow>(id)[0]
    if (!created) {
      throw new Error('Failed to create schedule')
    }
    return this.mapScheduleRow(created)
  }

  updateScheduleEnabled(scheduleId: string, enabled: boolean): SkillScheduleRecord | null {
    const db = this.getRawDatabase()
    if (!db) return null
    db.prepare('UPDATE skills_schedules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), scheduleId)
    const row = db.prepare('SELECT * FROM skills_schedules WHERE id = ?').all<SkillScheduleRow>(scheduleId)[0]
    if (!row) return null
    this.runSchedulerTickSoon()
    return this.mapScheduleRow(row)
  }

  deleteSchedule(scheduleId: string): boolean {
    const db = this.getRawDatabase()
    if (!db) return false
    db.prepare('DELETE FROM skills_schedules WHERE id = ?').run(scheduleId)
    this.runningScheduleIds.delete(scheduleId)
    return true
  }

  private getRawDatabase(): DatabaseConnection | null {
    return getDatabase().getDatabase() as DatabaseConnection | null
  }

  private mapJobRow(row: SkillJobRow): SkillJobRecord {
    return {
      id: row.id,
      skillId: row.skill_id,
      action: row.action,
      status: row.status,
      triggerType: row.trigger_type,
      scheduleId: row.schedule_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      stdout: row.stdout || '',
      stderr: row.stderr || '',
      outputDir: row.output_dir,
      error: row.error,
      command: row.command_json ? this.parseJson<string[]>(row.command_json, []) : [],
    }
  }

  private mapScheduleRow(row: SkillScheduleRow): SkillScheduleRecord {
    return {
      id: row.id,
      skillId: row.skill_id,
      action: row.action,
      params: this.parseJson<Record<string, unknown>>(row.params_json || '{}', {}),
      intervalMinutes: row.interval_minutes,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private parseJson<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private recordJobStart(params: {
    skillId: SkillId
    action: string
    params?: Record<string, unknown>
    triggerType: SkillTriggerType
    scheduleId: string | null
  }): string {
    const db = this.getRawDatabase()
    if (!db) return randomUUID()
    const id = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO skills_jobs (
        id, skill_id, action, params_json, status, trigger_type, schedule_id, created_at, started_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      id,
      params.skillId,
      params.action,
      JSON.stringify(params.params || {}),
      params.triggerType,
      params.scheduleId,
      now,
      now,
    )
    return id
  }

  private recordJobFinish(jobId: string, result: SkillRunResult): void {
    const db = this.getRawDatabase()
    if (!db) return
    const now = new Date().toISOString()
    const started = db.prepare('SELECT started_at FROM skills_jobs WHERE id = ?').all<{ started_at: string | null }>(jobId)[0]
    const durationMs = started?.started_at ? Math.max(0, Date.now() - new Date(started.started_at).getTime()) : null
    db.prepare(`
      UPDATE skills_jobs
      SET
        status = ?,
        finished_at = ?,
        duration_ms = ?,
        stdout = ?,
        stderr = ?,
        output_dir = ?,
        error = ?,
        command_json = ?
      WHERE id = ?
    `).run(
      result.success ? 'success' : 'failed',
      now,
      durationMs,
      result.stdout,
      result.stderr,
      result.outputDir || null,
      result.error || null,
      JSON.stringify(result.command || []),
      jobId,
    )
  }

  private startScheduler(): void {
    if (this.schedulerTimer) return
    this.schedulerTimer = setInterval(() => {
      void this.tickSchedules()
    }, SCHEDULER_INTERVAL_MS)
    this.runSchedulerTickSoon()
  }

  private runSchedulerTickSoon(): void {
    setTimeout(() => {
      void this.tickSchedules()
    }, 300)
  }

  private async tickSchedules(): Promise<void> {
    const db = this.getRawDatabase()
    if (!db) return
    const nowIso = new Date().toISOString()
    const due = db.prepare(`
      SELECT * FROM skills_schedules
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 20
    `).all<SkillScheduleRow>(nowIso)
    for (const schedule of due) {
      if (this.runningScheduleIds.has(schedule.id)) continue
      this.runningScheduleIds.add(schedule.id)
      void this.runScheduledTask(schedule)
    }
  }

  private async runScheduledTask(schedule: SkillScheduleRow): Promise<void> {
    try {
      const params = this.parseJson<Record<string, unknown>>(schedule.params_json || '{}', {})
      await this.runSkill({
        skillId: schedule.skill_id,
        action: schedule.action,
        params,
        triggerType: 'schedule',
        scheduleId: schedule.id,
      })
      const db = this.getRawDatabase()
      if (!db) return
      const now = Date.now()
      const nextRunAt = new Date(now + Math.max(1, schedule.interval_minutes) * 60_000).toISOString()
      db.prepare(`
        UPDATE skills_schedules
        SET last_run_at = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(new Date(now).toISOString(), nextRunAt, new Date(now).toISOString(), schedule.id)
    } catch {
      // Keep scheduler resilient. Failure details are recorded in skills_jobs.
      const db = this.getRawDatabase()
      if (!db) return
      const retryRunAt = new Date(Date.now() + 5 * 60_000).toISOString()
      db.prepare('UPDATE skills_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(retryRunAt, new Date().toISOString(), schedule.id)
    } finally {
      this.runningScheduleIds.delete(schedule.id)
    }
  }

  private async installSkillInternal(skillId: SkillId, force: boolean): Promise<SkillInstallResult> {
    const manifest = getEmbeddedSkillManifest(skillId)
    if (manifest) {
      this.ensureRuntimeDirs()
      const skillPath = this.syncEmbeddedSkill(manifest)
      const statePath = getInstallStatePath(skillPath)
      const requirementsPath = join(skillPath, manifest.requirementsFile)
      const digest = requirementsDigest(requirementsPath)

      if (!force && existsSync(statePath)) {
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf-8')) as SkillInstallState
          if (state.version === manifest.version && state.requirementsDigest === digest) {
            const venvPython = await this.ensurePythonVenv()
            return { success: true, skillId: manifest.id, skillPath, venvPython }
          }
        } catch {
          // Invalid state file, continue to reinstall.
        }
      }

      try {
        const venvPython = await this.ensurePythonVenv()
        await this.ensureRuntimeToolchain()
        if (existsSync(requirementsPath)) {
          await this.installRequirements(venvPython, requirementsPath)
        }
        const state: SkillInstallState = {
          version: manifest.version,
          requirementsDigest: digest,
          installedAt: new Date().toISOString(),
        }
        writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
        return { success: true, skillId: manifest.id, skillPath, venvPython }
      } catch (error) {
        return {
          success: false,
          skillId: manifest.id,
          skillPath,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const customSkill = getManagedCustomSkill(this.customSkillsRoot, skillId)
    if (!customSkill) {
      return { success: false, skillId, error: `Unknown skill: ${skillId}` }
    }

    const statePath = getInstallStatePath(customSkill.managedPath)
    const requiresPython = customSkill.runtime === 'python' || customSkill.actions.some((action) => action.runtime === 'python')
    const requirementsPath = customSkill.requirementsFile ? join(customSkill.managedPath, customSkill.requirementsFile) : ''
    const digest = customSkill.requirementsFile ? requirementsDigest(requirementsPath) : 'none'

    if (!force && existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8')) as SkillInstallState
        if (state.version === customSkill.version && state.requirementsDigest === digest) {
          const venvPython = requiresPython ? await this.ensurePythonVenv() : undefined
          return { success: true, skillId: customSkill.id, skillPath: customSkill.managedPath, venvPython }
        }
      } catch {
        // continue to reinstall
      }
    }

    try {
      let venvPython: string | undefined
      if (requiresPython) {
        venvPython = await this.ensurePythonVenv()
        await this.ensureRuntimeToolchain()
        if (customSkill.requirementsFile && existsSync(requirementsPath)) {
          await this.installRequirements(venvPython, requirementsPath)
        }
      }
      const state: SkillInstallState = {
        version: customSkill.version,
        requirementsDigest: digest,
        installedAt: new Date().toISOString(),
      }
      writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8')
      return { success: true, skillId: customSkill.id, skillPath: customSkill.managedPath, venvPython }
    } catch (error) {
      return {
        success: false,
        skillId: customSkill.id,
        skillPath: customSkill.managedPath,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private ensureRuntimeDirs(): void {
    mkdirSync(this.runtimeRoot, { recursive: true })
    mkdirSync(this.skillsRoot, { recursive: true })
    mkdirSync(this.customSkillsRoot, { recursive: true })
    mkdirSync(this.runtimeBin, { recursive: true })
    mkdirSync(this.cacheRoot, { recursive: true })
    mkdirSync(this.modelscopeCache, { recursive: true })
    mkdirSync(this.pipCache, { recursive: true })
    mkdirSync(this.outputsRoot, { recursive: true })
  }

  private resolveEmbeddedSkillsRoot(): string {
    const candidates = [
      join(process.resourcesPath, 'embedded-skills'),
      join(app.getAppPath(), 'assets', 'embedded-skills'),
      join(process.cwd(), 'assets', 'embedded-skills'),
    ]
    const found = candidates.find((candidate) => existsSync(candidate))
    if (!found) {
      throw new Error(`Embedded skills directory not found. Checked: ${candidates.join(', ')}`)
    }
    return found
  }

  private syncEmbeddedSkill(manifest: EmbeddedSkillManifest): string {
    const sourceRoot = this.resolveEmbeddedSkillsRoot()
    const source = join(sourceRoot, manifest.id)
    if (!existsSync(source)) {
      throw new Error(`Embedded skill source missing: ${source}`)
    }
    const destination = this.getSkillRuntimePath(manifest.id)
    mkdirSync(destination, { recursive: true })
    cpSync(source, destination, { recursive: true, force: true })
    return destination
  }

  private getSkillRuntimePath(skillId: SkillId): string {
    return join(this.skillsRoot, skillId)
  }

  private async ensurePythonVenv(): Promise<string> {
    const pythonPath = this.getVenvPythonPath()
    if (existsSync(pythonPath)) return pythonPath

    const basePython = await this.findPythonExecutable()
    await execFileAsync(basePython, ['-m', 'venv', this.venvRoot], {
      timeout: 180_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(),
    })

    const venvPython = this.getVenvPythonPath()
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      timeout: 300_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(),
    })
    return venvPython
  }

  private getVenvPythonPath(): string {
    if (process.platform === 'win32') {
      return join(this.venvRoot, 'Scripts', 'python.exe')
    }
    return join(this.venvRoot, 'bin', 'python')
  }

  private async findPythonExecutable(): Promise<string> {
    const configured = getDatabase().getSetting('skills_python_path')
    const candidates = [configured, process.env.PYTHON3, 'python3', 'python'].filter((item): item is string => Boolean(item))
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000 })
        return candidate
      } catch {
        // Continue trying candidates.
      }
    }
    throw new Error('Python runtime not found. Please install Python 3.9+ or set setting key `skills_python_path`.')
  }

  private async installRequirements(venvPython: string, requirementsPath: string): Promise<void> {
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], {
      timeout: 3_600_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(),
    })
  }

  private async ensureRuntimeToolchain(): Promise<void> {
    await this.linkIfFound('ffmpeg')
    await this.linkIfFound('ffprobe')
  }

  private async linkIfFound(binaryName: string): Promise<void> {
    const destination = join(this.runtimeBin, binaryName)
    if (existsSync(destination)) return

    try {
      const { stdout } = await execFileAsync(getWhichCommand(), [binaryName], { timeout: 10_000 })
      // Windows 'where' may return multiple lines, take the first one
      const source = stdout.trim().split('\n')[0]
      if (!source) return
      symlinkSync(source, destination)
    } catch {
      // Keep silent: certain skills can still run without this binary.
    }
  }

  private getBaseEnv(): NodeJS.ProcessEnv {
    const venvBinDir = process.platform === 'win32'
      ? join(this.venvRoot, 'Scripts')
      : join(this.venvRoot, 'bin')
    return {
      ...process.env,
      PATH: [this.runtimeBin, venvBinDir, process.env.PATH || ''].join(delimiter),
      PIP_CACHE_DIR: this.pipCache,
      XDG_CACHE_HOME: this.cacheRoot,
      MODELSCOPE_CACHE: this.modelscopeCache,
      HF_HOME: join(this.cacheRoot, 'huggingface'),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    }
  }

  private resolveOutputDir(candidate: string | null, skillId: SkillId): string {
    const outputDir = candidate || join(this.outputsRoot, skillId)
    mkdirSync(outputDir, { recursive: true })
    return outputDir
  }

  private ensureSkillCompatibilityFiles(skillId: SkillId, skillPath: string): void {
    if (skillId !== 'video-expert-analyzer') return
    const scriptsDir = join(skillPath, 'scripts')
    const downloadScript = join(scriptsDir, 'download_douyin.py')
    const compatScript = join(scriptsDir, 'douyin_downloader.py')
    if (!existsSync(downloadScript) || existsSync(compatScript)) return
    try {
      writeFileSync(compatScript, DOUYIN_COMPAT_SHIM, 'utf-8')
      console.log('[skills-runtime] repaired missing douyin_downloader.py compatibility shim')
    } catch (error) {
      console.warn('[skills-runtime] failed to repair douyin_downloader.py', error)
    }
  }

  private async runPythonScript(
    manifest: EmbeddedSkillManifest,
    venvPython: string,
    scriptRelativePath: string,
    scriptArgs: string[],
    timeoutMs: number,
    outputDir?: string,
    envOverrides?: Record<string, string>,
  ): Promise<SkillRunResult> {
    const skillPath = this.getSkillRuntimePath(manifest.id)
    const scriptPath = join(skillPath, scriptRelativePath)
    const command = [venvPython, scriptPath, ...scriptArgs]

    try {
      const { stdout, stderr } = await execFileAsync(venvPython, [scriptPath, ...scriptArgs], {
        cwd: skillPath,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env: {
          ...this.getBaseEnv(),
          ...(envOverrides || {}),
        },
      })
      return {
        success: true,
        skillId: manifest.id,
        action: scriptRelativePath,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        outputDir,
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        skillId: manifest.id,
        action: scriptRelativePath,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        outputDir,
        command,
        error: err.message,
      }
    }
  }
}

let runtimeManager: SkillsRuntimeManager | null = null

export function getSkillsRuntimeManager(): SkillsRuntimeManager {
  if (!runtimeManager) {
    runtimeManager = new SkillsRuntimeManager()
  }
  return runtimeManager
}
