import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { getDatabase } from '../database'
import { EMBEDDED_SKILLS, type EmbeddedSkillId, type EmbeddedSkillManifest, getEmbeddedSkillManifest } from './manifest'
import {
  type RegisteredCustomSkill,
  type SkillActionDefinition,
  type SkillParamDefinition,
  type SkillRuntimeKind,
  type SkillSource,
  getManagedCustomSkill,
  importCustomSkillFolder,
  listManagedCustomSkills,
  removeManagedCustomSkill,
  updateManagedCustomSkillDescription,
} from './custom-skill-registry'

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
}

export interface SkillRunRequest {
  skillId: SkillId
  action: string
  params?: Record<string, unknown>
  timeoutMs?: number
  triggerType?: SkillTriggerType
  scheduleId?: string
  env?: Record<string, string>
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
  private installLocks = new Map<SkillId, Promise<SkillInstallResult>>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private runningScheduleIds = new Set<string>()

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
  }

  private getEmbeddedDefaultAction(skillId: EmbeddedSkillId): string {
    switch (skillId) {
      case 'video-expert-analyzer':
        return 'video_expert_pipeline'
      case 'video-copy-analyzer':
        return 'video_copy_analyze'
      case 'lets-go-rss':
        return 'rss_update'
      default:
        return ''
    }
  }

  private getEmbeddedActions(skillId: EmbeddedSkillId): SkillActionDefinition[] {
    switch (skillId) {
      case 'video-expert-analyzer':
        return [
          {
            name: 'video_expert_pipeline',
            description: '运行 Video Expert Analyzer 主流程：下载视频、分镜、提取字幕并生成分析模板。',
            runtime: 'python',
            entry: 'scripts/pipeline_enhanced.py',
            timeoutMs: 60 * 60 * 1000,
            params: [
              { name: 'url', type: 'string', description: '视频 URL（B站/YouTube/抖音等）', required: true },
              { name: 'outputDir', type: 'string', description: '可选输出目录', required: false },
              { name: 'sceneThreshold', type: 'number', description: '可选分镜阈值', required: false },
              { name: 'bestThreshold', type: 'number', description: '可选精选片段阈值', required: false },
            ],
          },
          {
            name: 'video_expert_ai_analyze',
            description: '对 scene_scores.json 执行 AI 评分（agent/api）。',
            runtime: 'python',
            entry: 'scripts/ai_analyzer.py',
            timeoutMs: 30 * 60 * 1000,
            params: [
              { name: 'sceneScoresPath', type: 'string', description: 'scene_scores.json 绝对路径', required: true },
              { name: 'mode', type: 'string', description: '评分模式', required: false, enum: ['agent', 'api'] },
            ],
          },
        ]
      case 'video-copy-analyzer':
        return [
          {
            name: 'video_copy_analyze',
            description: '运行 Video Copy Analyzer，生成字幕与文字稿。',
            runtime: 'python',
            entry: 'main.py',
            timeoutMs: 60 * 60 * 1000,
            params: [
              { name: 'input', type: 'string', description: '视频 URL 或本地文件路径', required: true },
              { name: 'outputDir', type: 'string', description: '可选输出目录', required: false },
              { name: 'model', type: 'string', description: 'whisper 模型 tiny/base/small/medium/large', required: false },
              { name: 'language', type: 'string', description: '语言 zh/en/auto', required: false },
            ],
          },
        ]
      case 'lets-go-rss':
        return [
          {
            name: 'rss_add',
            description: '向 Lets Go RSS 添加一个订阅源 URL。',
            runtime: 'python',
            entry: 'scripts/lets_go_rss.py',
            timeoutMs: 5 * 60 * 1000,
            params: [{ name: 'url', type: 'string', description: '订阅源或平台账号 URL', required: true }],
          },
          {
            name: 'rss_update',
            description: '执行 Lets Go RSS 更新任务（支持 digest/no_llm）。',
            runtime: 'python',
            entry: 'scripts/lets_go_rss.py',
            timeoutMs: 15 * 60 * 1000,
            params: [
              { name: 'digest', type: 'boolean', description: '摘要模式（每账号 1 条）', required: false },
              { name: 'noLlm', type: 'boolean', description: '禁用 LLM 分类', required: false },
            ],
          },
          {
            name: 'rss_status',
            description: '读取 Lets Go RSS 最近一次缓存报告。',
            runtime: 'python',
            entry: 'scripts/lets_go_rss.py',
            timeoutMs: 60_000,
            params: [],
          },
          {
            name: 'rss_list',
            description: '列出 Lets Go RSS 当前订阅列表。',
            runtime: 'python',
            entry: 'scripts/lets_go_rss.py',
            timeoutMs: 60_000,
            params: [],
          },
          {
            name: 'rss_stats',
            description: '查看 Lets Go RSS 订阅统计。',
            runtime: 'python',
            entry: 'scripts/lets_go_rss.py',
            timeoutMs: 60_000,
            params: [],
          },
        ]
      default:
        return []
    }
  }

  private toEmbeddedSkillState(skill: EmbeddedSkillManifest): SkillState {
    const skillPath = this.getSkillRuntimePath(skill.id)
    const statePath = getInstallStatePath(skillPath)
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      installed: existsSync(statePath),
      installStatePath: statePath,
      source: 'embedded',
      manifestValid: true,
      defaultAction: this.getEmbeddedDefaultAction(skill.id),
      actions: this.getEmbeddedActions(skill.id),
      managedPath: skillPath,
    }
  }

  private toCustomSkillState(skill: RegisteredCustomSkill): SkillState {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      installed: true,
      installStatePath: getInstallStatePath(skill.managedPath),
      source: 'custom',
      manifestValid: true,
      defaultAction: skill.defaultAction,
      actions: skill.actions,
      managedPath: skill.managedPath,
      sourcePath: skill.sourcePath,
    }
  }

  private listCustomSkillStates(): SkillState[] {
    this.ensureRuntimeDirs()
    return listManagedCustomSkills(this.customSkillsRoot).map((skill) => this.toCustomSkillState(skill))
  }

  listSkills(): SkillState[] {
    this.ensureRuntimeDirs()
    return [
      ...EMBEDDED_SKILLS.map((skill) => this.toEmbeddedSkillState(skill)),
      ...this.listCustomSkillStates(),
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

  importCustomSkill(sourcePath: string): SkillState {
    this.ensureRuntimeDirs()
    const record = importCustomSkillFolder(sourcePath, this.customSkillsRoot)
    return this.toCustomSkillState(record)
  }

  removeCustomSkill(skillId: string): { removed: boolean } {
    this.ensureRuntimeDirs()
    return { removed: removeManagedCustomSkill(this.customSkillsRoot, skillId) }
  }

  updateCustomSkillDescription(skillId: string, description: string): SkillState {
    this.ensureRuntimeDirs()
    const record = updateManagedCustomSkillDescription(this.customSkillsRoot, skillId, description)
    return this.toCustomSkillState(record)
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

    const manifest = getEmbeddedSkillManifest(request.skillId)
    if (!manifest) {
      const customSkill = getManagedCustomSkill(this.customSkillsRoot, request.skillId)
      if (!customSkill) {
        return finish({
          success: false,
          skillId: request.skillId,
          action: request.action,
          stdout: '',
          stderr: '',
          command: [],
          error: `Unknown skill: ${request.skillId}`,
        })
      }

      const action = customSkill.actions.find((item) => item.name === request.action)
      if (!action) {
        return finish(this.invalidParams(customSkill.id, request.action, `Unknown action: ${request.action}`))
      }

      const installResult = await this.ensureSkillInstalled(customSkill.id)
      if (!installResult.success || !installResult.skillPath) {
        return finish({
          success: false,
          skillId: customSkill.id,
          action: request.action,
          stdout: '',
          stderr: '',
          command: [],
          error: installResult.error || 'Skill installation failed',
        })
      }

      return finish(await this.runCustomSkillAction(
        customSkill,
        action,
        request.params || {},
        Math.max(3_000, request.timeoutMs || action.timeoutMs || DEFAULT_TIMEOUT_MS),
        request.env,
        installResult.venvPython,
      ))
    }

    const installResult = await this.ensureSkillInstalled(manifest.id)
    if (!installResult.success || !installResult.skillPath || !installResult.venvPython) {
      return finish({
        success: false,
        skillId: manifest.id,
        action: request.action,
        stdout: '',
        stderr: '',
        command: [],
        error: installResult.error || 'Skill installation failed',
      })
    }
    this.ensureSkillCompatibilityFiles(manifest.id, installResult.skillPath)

    const params = request.params || {}
    const envOverrides = request.env
    const timeoutMs = Math.max(3_000, request.timeoutMs || DEFAULT_TIMEOUT_MS)

    switch (request.action) {
      case 'video_expert_pipeline': {
        const url = asString(params.url)
        if (!url) return finish(this.invalidParams(manifest.id, request.action, 'params.url is required'))
        const outputDir = this.resolveOutputDir(asString(params.outputDir), manifest.id)
        const args = [url, '-o', outputDir]
        const sceneThreshold = asNumber(params.sceneThreshold)
        const bestThreshold = asNumber(params.bestThreshold)
        if (sceneThreshold !== null) args.push('--scene-threshold', String(sceneThreshold))
        if (bestThreshold !== null) args.push('--best-threshold', String(bestThreshold))
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/pipeline_enhanced.py',
            args,
            timeoutMs,
            outputDir,
            envOverrides,
          )
        )
      }

      case 'video_expert_ai_analyze': {
        const sceneScoresPath = asString(params.sceneScoresPath)
        if (!sceneScoresPath) return finish(this.invalidParams(manifest.id, request.action, 'params.sceneScoresPath is required'))
        const mode = asString(params.mode) || 'agent'
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/ai_analyzer.py',
            [sceneScoresPath, '--mode', mode],
            timeoutMs,
            undefined,
            envOverrides,
          )
        )
      }

      case 'video_copy_analyze': {
        const input = asString(params.input)
        if (!input) return finish(this.invalidParams(manifest.id, request.action, 'params.input is required'))
        const outputDir = this.resolveOutputDir(asString(params.outputDir), manifest.id)
        const model = asString(params.model) || 'medium'
        const language = asString(params.language) || 'auto'
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'main.py',
            [input, outputDir, model, language],
            timeoutMs,
            outputDir,
            envOverrides,
          )
        )
      }

      case 'rss_add': {
        const url = asString(params.url)
        if (!url) return finish(this.invalidParams(manifest.id, request.action, 'params.url is required'))
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/lets_go_rss.py',
            ['--add', url, '--skip-setup'],
            timeoutMs,
            undefined,
            envOverrides,
          )
        )
      }

      case 'rss_update': {
        const digest = asBoolean(params.digest) ?? true
        const noLlm = asBoolean(params.noLlm) ?? true
        const args = ['--update', '--skip-setup']
        if (digest) args.push('--digest')
        if (noLlm) args.push('--no-llm')
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/lets_go_rss.py',
            args,
            timeoutMs,
            undefined,
            envOverrides,
          )
        )
      }

      case 'rss_status':
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/lets_go_rss.py',
            ['--status'],
            timeoutMs,
            undefined,
            envOverrides,
          )
        )

      case 'rss_list':
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/lets_go_rss.py',
            ['--list', '--skip-setup'],
            timeoutMs,
            undefined,
            envOverrides,
          )
        )

      case 'rss_stats':
        return finish(
          await this.runPythonScript(
            manifest,
            installResult.venvPython,
            'scripts/lets_go_rss.py',
            ['--stats', '--skip-setup'],
            timeoutMs,
            undefined,
            envOverrides,
          )
        )

      default:
        return finish(this.invalidParams(manifest.id, request.action, `Unknown action: ${request.action}`))
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

  private async runCustomSkillAction(
    skill: RegisteredCustomSkill,
    action: SkillActionDefinition,
    params: Record<string, unknown>,
    timeoutMs: number,
    envOverrides?: Record<string, string>,
    venvPython?: string,
  ): Promise<SkillRunResult> {
    const skillPath = skill.managedPath
    const entryPath = join(skillPath, action.entry)

    if (action.runtime === 'reference') {
      try {
        const stdout = readFileSync(entryPath, 'utf-8')
        return {
          success: true,
          skillId: skill.id,
          action: action.name,
          stdout: truncateOutput(stdout),
          stderr: '',
          command: ['read', entryPath],
        }
      } catch (error) {
        return {
          success: false,
          skillId: skill.id,
          action: action.name,
          stdout: '',
          stderr: '',
          command: ['read', entryPath],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const args = this.buildActionArgs(params, action)
    if (action.runtime === 'python') {
      if (!venvPython) {
        return this.invalidParams(skill.id, action.name, 'Python skill runtime is unavailable')
      }
      return this.runCustomScript(skill.id, skillPath, action.name, action.runtime, venvPython, [entryPath, ...args], timeoutMs, envOverrides)
    }

    if (action.runtime === 'node') {
      return this.runCustomScript(skill.id, skillPath, action.name, action.runtime, 'node', [entryPath, ...args], timeoutMs, envOverrides)
    }

    return this.runCustomScript(skill.id, skillPath, action.name, action.runtime, entryPath, args, timeoutMs, envOverrides)
  }

  private async runCustomScript(
    skillId: SkillId,
    cwd: string,
    actionName: string,
    runtime: SkillRuntimeKind,
    commandBin: string,
    commandArgs: string[],
    timeoutMs: number,
    envOverrides?: Record<string, string>,
  ): Promise<SkillRunResult> {
    const command = [commandBin, ...commandArgs]
    try {
      const { stdout, stderr } = await execFileAsync(commandBin, commandArgs, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env: {
          ...this.getBaseEnv(),
          ...(envOverrides || {}),
        },
      })
      return {
        success: true,
        skillId,
        action: actionName,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        skillId,
        action: actionName,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        command,
        error: runtime === 'node' && err.message.includes('ENOENT')
          ? 'Node.js runtime not found. Please install Node.js or use python/shell based custom skills.'
          : err.message,
      }
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
      const { stdout } = await execFileAsync('which', [binaryName], { timeout: 10_000 })
      const source = stdout.trim()
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
      PATH: `${this.runtimeBin}:${venvBinDir}:${process.env.PATH || ''}`,
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
