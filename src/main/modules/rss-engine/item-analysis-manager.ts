import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import {
  type RSSAnalysisAction,
  type RSSAnalysisJob,
  type RSSAnalysisJobStatus,
} from '../database'
import { RSSRepository } from '../repositories/rss-repository'
import {
  getSkillsRuntimeManager,
  startSkillChildRunAndWait,
  type StartSkillChildRunAndWaitResult,
} from '../skills-runtime/runtime-manager'
import { getChildRunRetryPolicy } from '../agent-control/child-run/child-run-retry-policy'
import { extractWebContentToFile } from './content-extractor'
import { rssSubagentRunner } from './subagent-runner'
import {
  BROWSER_VIDEO_FILE_EXTENSIONS,
  canAttemptVisualAnalysis,
  hasLikelyVideoResource,
} from '../../../shared/browser-tab-resource-classifier'

export interface StartRSSItemAnalysisPayload {
  itemId: string
  action: RSSAnalysisAction
  link: string
  title: string
  targetDir: string
  source?: string
  summary?: string
  publishedAt?: string
  force?: boolean
}

export interface RSSItemAnalysisProgress {
  itemId: string
  jobId: string
  action: RSSAnalysisAction
  status: RSSAnalysisJobStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

function sanitizeName(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const normalized = cleaned || 'rss-item'
  return normalized.slice(0, 56)
}

export function isLikelyVideoLink(url: string): boolean {
  return hasLikelyVideoResource(url)
}

function safeJson(input: unknown): string {
  try {
    return JSON.stringify(input)
  } catch {
    return '{}'
  }
}

function parseMetaJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getOutputPath(outputs: Record<string, string> | undefined, key: string): string | null {
  const value = outputs?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stripKnownTranscriptSuffix(filePath: string): string {
  const name = basename(filePath)
  return name
    .replace(/_文字稿\.md$/i, '')
    .replace(/\.md$/i, '')
}

function stripKnownVideoSuffix(filePath: string): string {
  const name = basename(filePath)
  const lower = name.toLowerCase()
  const ext = BROWSER_VIDEO_FILE_EXTENSIONS.find((item) => lower.endsWith(item))
  return ext ? name.slice(0, -ext.length) : name
}

interface VisualRunStateSnapshot {
  path: string
  status: string
  stage: string
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
  lastError: string | null
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(98, Math.round(value)))
}

function deriveVisualRunProgress(snapshot: VisualRunStateSnapshot): number {
  const status = snapshot.status.toLowerCase()
  const stage = snapshot.stage.toLowerCase()
  const ratio = Math.max(
    0,
    Math.min(
      1,
      snapshot.coverageRatio
        ?? (snapshot.totalScenes && snapshot.totalScenes > 0 && snapshot.completedScenes !== null
          ? snapshot.completedScenes / snapshot.totalScenes
          : 0),
    ),
  )
  if (status === 'completed' || stage === 'completed') return 98
  if (stage === 'finalize') return status === 'blocked' || status === 'failed' ? 92 : 90 + ratio * 6
  if (stage === 'merge_validate') return 86 + ratio * 4
  if (stage === 'score_batches') return 40 + ratio * 45
  if (stage === 'prepare') return 22 + ratio * 18
  return 22
}

function visualRunProgressMessage(snapshot: VisualRunStateSnapshot): string {
  const status = snapshot.status.toLowerCase()
  const stage = snapshot.stage.toLowerCase()
  if (status === 'blocked') return '视觉分析已到最后收尾，但视听剖析正文生成被阻塞'
  if (status === 'failed') return '视觉分析子流程失败'
  if (stage === 'finalize') return '正在生成视听剖析正文'
  if (stage === 'merge_validate') return '正在校验视觉分析结果'
  if (stage === 'score_batches') {
    const total = snapshot.totalScenes ?? 0
    const completed = snapshot.completedScenes ?? 0
    return total > 0 ? `正在评分视觉场景 ${completed}/${total}` : '正在评分视觉场景'
  }
  if (stage === 'prepare') return '正在准备视频素材与场景'
  return '正在执行视觉脚本分析'
}

function extractVideoIdHint(source: string): string | null {
  const text = String(source || '').trim()
  const bilibili = text.match(/(?:^|[/?&_=.-])(BV[\w]+)/i)
  if (bilibili?.[1]) return bilibili[1]
  const youtube = text.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  if (youtube?.[1]) return youtube[1]
  const localName = stripKnownVideoSuffix(text)
  return localName && localName !== text ? localName : null
}

function pathParts(filePath: string): string[] {
  return filePath.split(/[\\/]+/).map((part) => part.toLowerCase()).filter(Boolean)
}

function isGeneratedVideoDerivativePath(filePath: string): boolean {
  const parts = pathParts(filePath)
  return parts.includes('scenes') || parts.includes('frames') || parts.includes('best_shots')
}

async function isUsableVideoFile(filePath: string): Promise<boolean> {
  const lower = basename(filePath).toLowerCase()
  if (!BROWSER_VIDEO_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false
  if (isGeneratedVideoDerivativePath(filePath)) return false
  const fileStat = await stat(filePath).catch(() => null)
  return Boolean(fileStat?.isFile() && fileStat.size > 0)
}

function scoreReusableVideo(filePath: string, videoIdHint: string | null): number {
  const parts = pathParts(filePath)
  const stem = stripKnownVideoSuffix(filePath).toLowerCase()
  const hint = videoIdHint?.toLowerCase() || ''
  let score = 0
  if (hint && stem === hint) score += 1000
  else if (hint && stem.includes(hint)) score += 300
  if (parts.includes('copy-analysis')) score += 200
  if (parts.includes('visual-analysis')) score += 120
  return score
}

export async function findReusableVideoFile(
  rootDir: string,
  source: string,
  depth = 0,
): Promise<string | null> {
  if (depth > 5) return null
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => [])
  const videoIdHint = extractVideoIdHint(source)
  const candidates: Array<{ path: string; score: number; mtime: number }> = []

  for (const entry of entries) {
    const absolute = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      const lower = entry.name.toLowerCase()
      if (lower === 'scenes' || lower === 'frames' || lower === 'best_shots') continue
      const nested = await findReusableVideoFile(absolute, source, depth + 1)
      if (nested) {
        const nestedStat = await stat(nested).catch(() => null)
        candidates.push({
          path: nested,
          score: scoreReusableVideo(nested, videoIdHint),
          mtime: nestedStat?.mtimeMs || 0,
        })
      }
      continue
    }
    if (!entry.isFile()) continue
    if (!await isUsableVideoFile(absolute)) continue
    const fileStat = await stat(absolute).catch(() => null)
    candidates.push({
      path: absolute,
      score: scoreReusableVideo(absolute, videoIdHint),
      mtime: fileStat?.mtimeMs || 0,
    })
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.mtime - a.mtime))
  return candidates[0]?.path || null
}

async function collectTextFiles(
  dirPath: string,
  extensions: string[],
  maxChars: number,
  depth = 0,
): Promise<string> {
  if (depth > 4) return ''
  let output = ''
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (output.length >= maxChars) break
    const absolute = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      output += await collectTextFiles(absolute, extensions, maxChars - output.length, depth + 1)
      continue
    }
    const lower = entry.name.toLowerCase()
    if (!extensions.some((ext) => lower.endsWith(ext))) continue
    const content = await readFile(absolute, 'utf-8').catch(() => '')
    if (!content) continue
    output += `\n\n# ${entry.name}\n${content}`
  }
  return output.slice(0, maxChars)
}

async function findFileByName(dirPath: string, fileName: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const absolute = join(dirPath, entry.name)
    if (entry.isFile() && entry.name === fileName) return absolute
    if (entry.isDirectory()) {
      const hit = await findFileByName(absolute, fileName, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

async function findFilesByName(dirPath: string, fileName: string, depth = 0): Promise<string[]> {
  if (depth > 6) return []
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  const hits: string[] = []
  for (const entry of entries) {
    const absolute = join(dirPath, entry.name)
    if (entry.isFile() && entry.name === fileName) {
      hits.push(absolute)
      continue
    }
    if (entry.isDirectory()) {
      hits.push(...await findFilesByName(absolute, fileName, depth + 1))
    }
  }
  return hits
}

async function readLatestVisualRunState(outputDir: string): Promise<VisualRunStateSnapshot | null> {
  const paths = await findFilesByName(outputDir, 'run_state.json')
  const candidates: Array<{ path: string; mtime: number }> = []
  for (const path of paths) {
    const fileStat = await stat(path).catch(() => null)
    candidates.push({ path, mtime: fileStat?.mtimeMs || 0 })
  }
  candidates.sort((left, right) => right.mtime - left.mtime)
  for (const candidate of candidates) {
    const raw = await readFile(candidate.path, 'utf-8').catch(() => '')
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const record = parsed as Record<string, unknown>
      return {
        path: candidate.path,
        status: stringField(record, ['status', 'state', 'phase']),
        stage: stringField(record, ['current_stage', 'currentStage', 'stage', 'current_step', 'currentStep']),
        totalScenes: numberField(record, ['total_scenes', 'totalScenes', 'total']),
        completedScenes: numberField(record, ['completed_scenes', 'completedScenes', 'completed']),
        coverageRatio: numberField(record, ['coverage_ratio', 'coverageRatio', 'coverage']),
        lastError: stringField(record, ['last_error', 'lastError', 'error']) || null,
      }
    } catch {
      continue
    }
  }
  return null
}

async function findFileBySuffix(dirPath: string, suffix: string, depth = 0): Promise<string | null> {
  if (depth > 5) return null
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const absolute = join(dirPath, entry.name)
    if (entry.isFile() && entry.name.endsWith(suffix)) return absolute
    if (entry.isDirectory()) {
      const hit = await findFileBySuffix(absolute, suffix, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function toProgress(job: RSSAnalysisJob): RSSItemAnalysisProgress {
  return {
    itemId: job.item_id,
    jobId: job.id,
    action: job.action,
    status: job.status,
    progress: Math.max(0, Math.min(100, Number(job.progress) || 0)),
    message: job.message ?? null,
    error: job.error ?? null,
    outputDir: job.output_dir,
    reportPath: job.report_path ?? null,
    updatedAt: job.updated_at,
  }
}

/**
 * Phase 7 — VEA long actions are routed through `startSkillChildRunAndWait`.
 * `queued_global_concurrency` is the only terminal-on-launch reason that
 * deserves a retry; everything else (failed_skill / child_process_crashed /
 * cancelled_user / blocked_*) is propagated to the caller. Bounded retry
 * keeps RSS visual flow alive when the user has 3 other VEA child runs in
 * flight.
 */
const QUEUED_GLOBAL_CONCURRENCY_RETRY_POLICY = getChildRunRetryPolicy('queued_global_concurrency')
const VEA_AWAIT_RETRY_LIMIT = QUEUED_GLOBAL_CONCURRENCY_RETRY_POLICY.maxAttempts
const VEA_AWAIT_RETRY_DELAY_MS = QUEUED_GLOBAL_CONCURRENCY_RETRY_POLICY.backoffMs[0] ?? 0

export interface RSSItemAnalysisManagerDeps {
  /**
   * Test seam — defaults to the production helper. Tests inject a stub so
   * the manager can be exercised without booting the child-run runtime.
   */
  startSkillChildRunAndWait?: typeof startSkillChildRunAndWait
  /**
   * Test seam — override the bounded-retry sleep between
   * `queued_global_concurrency` attempts so retry tests don't take 10+
   * seconds. Defaults to the production constant.
   */
  veaAwaitRetryDelayMs?: number
}

export class RSSItemAnalysisManager {
  private readonly repository = new RSSRepository()
  private readonly queues: Record<RSSAnalysisAction, Array<{ jobId: string; run: () => Promise<void> }>> = {
    copy: [],
    visual: [],
  }
  private readonly running: Record<RSSAnalysisAction, boolean> = {
    copy: false,
    visual: false,
  }
  private initialized = false
  private readonly veaChildAwait: typeof startSkillChildRunAndWait
  private readonly veaAwaitRetryDelayMs: number

  constructor(deps: RSSItemAnalysisManagerDeps = {}) {
    this.veaChildAwait = deps.startSkillChildRunAndWait || startSkillChildRunAndWait
    this.veaAwaitRetryDelayMs =
      typeof deps.veaAwaitRetryDelayMs === 'number' && Number.isFinite(deps.veaAwaitRetryDelayMs) && deps.veaAwaitRetryDelayMs >= 0
        ? deps.veaAwaitRetryDelayMs
        : VEA_AWAIT_RETRY_DELAY_MS
  }

  /**
   * Phase 7 — test seam. Production code never calls this; the
   * `rss-visual-skill-child-run` test exercises it directly to verify
   * VEA dispatch + bounded retry + close-event translation without
   * booting the full job queue / SQLite repository. Keeping it on the
   * class (rather than a top-level export) means private fields like
   * `veaChildAwait` and `translateVeaCloseToError` stay encapsulated.
   */
  async __awaitVeaChildRunForTesting(args: {
    skillId: 'video-expert-analyzer'
    action: 'video_expert_pipeline' | 'video_expert_ai_analyze'
    params: Record<string, unknown>
    timeoutMs?: number
  }): Promise<StartSkillChildRunAndWaitResult> {
    return this.awaitVeaChildRun(args)
  }

  /** Phase 7 — test seam (paired with `__awaitVeaChildRunForTesting`). */
  __translateVeaCloseToErrorForTesting(
    result: StartSkillChildRunAndWaitResult,
    fallbackMessage: string,
  ): Error {
    return this.translateVeaCloseToError(result, fallbackMessage)
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true
    const interrupted = this.repository.markInterruptedRSSAnalysisJobs()
    if (interrupted > 0) {
      console.log(`[rss:analysis] marked interrupted jobs=${interrupted}`)
    }
    this.repository.cleanupRSSAnalysisJobs(30, 500)
  }

  async startItemAnalysis(payload: StartRSSItemAnalysisPayload): Promise<RSSAnalysisJob> {
    this.ensureInitialized()
    const safeTitle = sanitizeName(payload.title)
    const folderSuffix = payload.itemId.slice(0, 8)
    const rootDir = join(payload.targetDir, `${safeTitle}-${folderSuffix}`)
    const outputDir = join(rootDir, payload.action === 'copy' ? 'copy-analysis' : 'visual-analysis')
    mkdirSync(outputDir, { recursive: true })

    if (!payload.force) {
      const active = this.repository.findActiveRSSAnalysisJob(payload.itemId, payload.action)
      if (active) return active
    }

    const now = new Date().toISOString()
    const job = this.repository.createRSSAnalysisJob({
      id: randomUUID(),
      itemId: payload.itemId,
      action: payload.action,
      sourceUrl: payload.link,
      title: payload.title,
      targetDir: payload.targetDir,
      outputDir,
      status: 'queued',
      progress: 5,
      message: '已排队，等待执行',
      metaJson: safeJson({
        source: payload.source || '',
        summary: payload.summary || '',
        publishedAt: payload.publishedAt || '',
        queuedAt: now,
      }),
    })

    this.enqueue(payload.action, job.id, async () => {
      await this.executeJob(job.id, payload, rootDir, outputDir)
    })
    return job
  }

  getItemProgress(itemIds?: string[]): Record<string, RSSItemAnalysisProgress> {
    this.ensureInitialized()
    let latest: Record<string, RSSAnalysisJob> = {}
    if (Array.isArray(itemIds) && itemIds.length > 0) {
      latest = this.repository.getLatestRSSAnalysisByItemIds(itemIds)
    } else {
      const rows = this.repository.listRSSAnalysisJobs(undefined, 400)
      for (const row of rows) {
        if (!latest[row.item_id]) latest[row.item_id] = row
      }
    }

    const result: Record<string, RSSItemAnalysisProgress> = {}
    for (const [itemId, job] of Object.entries(latest)) {
      result[itemId] = toProgress(job)
    }
    return result
  }

  listJobs(itemId?: string, limit = 50): RSSAnalysisJob[] {
    this.ensureInitialized()
    return this.repository.listRSSAnalysisJobs(itemId, limit)
  }

  pauseJob(jobId: string): RSSAnalysisJob {
    this.ensureInitialized()
    const job = this.repository.getRSSAnalysisJob(jobId)
    if (!job) {
      throw new Error('任务不存在')
    }
    if (job.status === 'paused') {
      return job
    }
    if (job.status !== 'queued') {
      throw new Error('仅排队中的任务可暂停')
    }
    this.queues[job.action] = this.queues[job.action].filter((task) => task.jobId !== jobId)
    const updated = this.repository.updateRSSAnalysisJob(jobId, {
      status: 'paused',
      message: '任务已暂停',
    })
    if (!updated) throw new Error('暂停任务失败')
    return updated
  }

  resumeJob(jobId: string): RSSAnalysisJob {
    this.ensureInitialized()
    const job = this.repository.getRSSAnalysisJob(jobId)
    if (!job) {
      throw new Error('任务不存在')
    }
    if (job.status !== 'paused') {
      throw new Error('仅暂停中的任务可继续')
    }

    const meta = parseMetaJson(job.meta_json)
    const payload: StartRSSItemAnalysisPayload = {
      itemId: job.item_id,
      action: job.action,
      link: job.source_url,
      title: job.title,
      targetDir: job.target_dir,
      source: typeof meta.source === 'string' ? meta.source : undefined,
      summary: typeof meta.summary === 'string' ? meta.summary : undefined,
      publishedAt: typeof meta.publishedAt === 'string' ? meta.publishedAt : undefined,
      force: true,
    }
    const updated = this.repository.updateRSSAnalysisJob(jobId, {
      status: 'queued',
      progress: Math.max(5, Number(job.progress) || 5),
      message: '已继续，等待执行',
      error: null,
      finishedAt: null,
      startedAt: null,
      reportPath: null,
    })
    if (!updated) throw new Error('继续任务失败')
    const rootDir = dirname(job.output_dir)
    this.enqueue(job.action, job.id, async () => {
      await this.executeJob(job.id, payload, rootDir, job.output_dir)
    })
    return updated
  }

  deleteJob(jobId: string): { deleted: boolean; reason?: string } {
    this.ensureInitialized()
    const job = this.repository.getRSSAnalysisJob(jobId)
    if (!job) {
      return { deleted: false, reason: '任务不存在' }
    }
    if (job.status === 'running_script' || job.status === 'running_subagent') {
      return { deleted: false, reason: '运行中的任务暂不支持删除' }
    }
    if (job.status === 'queued') {
      this.queues[job.action] = this.queues[job.action].filter((task) => task.jobId !== jobId)
    }
    return { deleted: this.repository.deleteRSSAnalysisJob(jobId) }
  }

  private enqueue(action: RSSAnalysisAction, jobId: string, task: () => Promise<void>): void {
    this.queues[action].push({ jobId, run: task })
    this.pump(action)
  }

  private pump(action: RSSAnalysisAction): void {
    if (this.running[action]) return
    const next = this.queues[action].shift()
    if (!next) return
    this.running[action] = true
    void next.run()
      .catch((error) => {
        console.error('[rss:analysis] queue task failed', error)
      })
      .finally(() => {
        this.running[action] = false
        this.pump(action)
      })
  }

  private async executeJob(
    jobId: string,
    payload: StartRSSItemAnalysisPayload,
    rootDir: string,
    outputDir: string,
  ): Promise<void> {
    try {
      this.updateJob(jobId, {
        status: 'running_script',
        progress: 12,
        message: '脚本阶段执行中',
        startedAt: new Date().toISOString(),
      })

      if (payload.action === 'copy') {
        await this.runCopyFlow(jobId, payload, rootDir, outputDir)
      } else {
        await this.runVisualFlow(jobId, payload, rootDir, outputDir)
      }

      this.updateJob(jobId, {
        status: 'success',
        progress: 100,
        message: '分析完成',
        error: null,
        finishedAt: new Date().toISOString(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const veaCause = error && typeof error === 'object' && 'veaCause' in error
        ? String((error as { veaCause?: unknown }).veaCause || '')
        : ''
      if (payload.action === 'visual') {
        await this.refreshVisualJobProgressFromRunState(jobId, outputDir)
      }
      const latest = this.repository.getRSSAnalysisJob(jobId)
      const visualBlocked = payload.action === 'visual' && veaCause === 'blocked'
      const failurePatch: Partial<{
        status: RSSAnalysisJobStatus
        progress: number
        message: string | null
        error: string | null
        finishedAt: string | null
      }> = {
        status: 'failed',
        message: visualBlocked ? '视觉分析卡在最后收尾，可重试视听剖析正文' : '分析失败',
        error: payload.action === 'visual' && latest?.error ? latest.error : message,
        finishedAt: new Date().toISOString(),
      }
      if (latest) {
        failurePatch.progress = Math.max(Number(latest.progress) || 0, visualBlocked ? 92 : 0)
      }
      this.updateJob(jobId, failurePatch)
      console.error('[rss:analysis] job failed', jobId, message)
    } finally {
      this.repository.cleanupRSSAnalysisJobs(30, 500)
    }
  }

  private async runCopyFlow(
    jobId: string,
    payload: StartRSSItemAnalysisPayload,
    rootDir: string,
    outputDir: string,
  ): Promise<void> {
    const runtime = getSkillsRuntimeManager()
    const isVideo = isLikelyVideoLink(payload.link)
    let extractedText = ''
    let transcriptPath: string | null = null
    let sourceVideoPath: string | null = null

    if (isVideo) {
      sourceVideoPath = await findReusableVideoFile(rootDir, payload.link)
      this.updateJob(jobId, {
        status: 'running_script',
        progress: 24,
        message: sourceVideoPath ? '复用已下载视频，正在提取文案' : '正在下载并提取视频文案',
      })
      const skillResult = await runtime.runSkill({
        skillId: 'video-copy-analyzer',
        action: 'video_copy_analyze',
        params: {
          input: sourceVideoPath || payload.link,
          outputDir,
          language: 'auto',
        },
        timeoutMs: 30 * 60 * 1000,
        triggerType: 'tool',
      })
      if (!skillResult.success) {
        throw new Error(skillResult.error || '文案脚本执行失败')
      }
      this.updateJob(jobId, {
        progress: 70,
        message: '文案提取完成，正在校正文稿',
      })
      transcriptPath = getOutputPath(skillResult.outputs, 'transcriptPath')
      sourceVideoPath = getOutputPath(skillResult.outputs, 'videoPath')
        || sourceVideoPath
        || await findReusableVideoFile(outputDir, payload.link)
      if (transcriptPath) {
        extractedText = await readFile(transcriptPath, 'utf-8').catch(() => '')
      }
      if (!extractedText) {
        extractedText = await collectTextFiles(outputDir, ['.md', '.txt'], 12_000)
      }
      if (!extractedText) {
        extractedText = `${skillResult.stdout}\n${skillResult.stderr}`.trim()
      }
    } else {
      this.updateJob(jobId, {
        status: 'running_script',
        progress: 45,
        message: '正在提取网页正文',
      })
      const extracted = await extractWebContentToFile(payload.link, outputDir)
      extractedText = extracted.text
      this.updateJob(jobId, {
        progress: 72,
        message: '正文提取完成，正在生成总结',
      })
    }

    this.updateJob(jobId, {
      status: 'running_subagent',
      progress: 86,
      message: 'subagent 正在校正文字稿并撰写文案报告',
    })

    const deliverables = await rssSubagentRunner.buildCopyDeliverables({
      title: payload.title,
      link: payload.link,
      source: payload.source,
      summary: payload.summary,
      publishedAt: payload.publishedAt,
      extractedText,
    })

    const existingTranscriptPath = transcriptPath || await findFileBySuffix(outputDir, '_文字稿.md')
    const baseVideoId = existingTranscriptPath ? stripKnownTranscriptSuffix(existingTranscriptPath) : sanitizeName(payload.title)
    const correctedTranscriptPath = existingTranscriptPath || join(outputDir, `${baseVideoId}_文字稿.md`)
    const structuredTranscriptPath = join(outputDir, `${baseVideoId}_结构化文字稿.md`)
    await writeFile(correctedTranscriptPath, deliverables.correctedTranscript.trim() + '\n', 'utf-8')
    await writeFile(structuredTranscriptPath, deliverables.structuredTranscript.trim() + '\n', 'utf-8')

    const reportPath = join(outputDir, '文案分析报告.md')
    await writeFile(
      reportPath,
      [
        '# 文案分析报告',
        '',
        `- 标题: ${payload.title}`,
        `- 链接: ${payload.link}`,
        `- 来源: ${payload.source || '未知来源'}`,
        '',
        deliverables.report.trim(),
        '',
      ].join('\n'),
      'utf-8',
    )

    const manifestPath = join(outputDir, 'manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          action: payload.action,
          itemId: payload.itemId,
          title: payload.title,
          link: payload.link,
          outputDir,
          rootDir,
          reportPath,
          correctedTranscriptPath,
          structuredTranscriptPath,
          sourceVideoPath,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    )

    this.updateJob(jobId, {
      progress: 98,
      message: '文案报告已生成',
      reportPath,
    })
  }

  /**
   * Phase 7 — wait on a VEA child run with bounded retry on global
   * concurrency. Distinguishes failed / killed / blocked semantics so
   * callers can map them to the manager's distinct outcomes.
   */
  private async awaitVeaChildRun(args: {
    skillId: 'video-expert-analyzer'
    action: 'video_expert_pipeline' | 'video_expert_ai_analyze'
    params: Record<string, unknown>
    timeoutMs?: number
    sessionId?: string | null
    scopeId?: string | null
  }): Promise<StartSkillChildRunAndWaitResult> {
    let attempt = 0
    while (true) {
      const result = await this.veaChildAwait({
        skillId: args.skillId,
        action: args.action,
        params: args.params,
        sessionId: args.sessionId ?? null,
        scopeId: args.scopeId ?? null,
        timeoutMs: args.timeoutMs,
        triggerType: 'product',
      })
      // queued_global_concurrency is the one terminal-on-launch reason
      // that deserves a retry — the next slot opens once another VEA
      // child completes. Bounded so a fully saturated host doesn't hang
      // the RSS queue.
      const close = result.closeEvent
      if (
        close?.terminalReason === 'queued_global_concurrency'
        && attempt < VEA_AWAIT_RETRY_LIMIT - 1
      ) {
        attempt += 1
        await new Promise((resolve) => setTimeout(resolve, this.veaAwaitRetryDelayMs))
        continue
      }
      return result
    }
  }

  private async awaitVeaChildRunWithProgress(args: {
    jobId: string
    outputDir: string
    skillId: 'video-expert-analyzer'
    action: 'video_expert_pipeline' | 'video_expert_ai_analyze'
    params: Record<string, unknown>
    timeoutMs?: number
  }): Promise<StartSkillChildRunAndWaitResult> {
    let stopped = false
    const refresh = async (): Promise<void> => {
      if (stopped) return
      await this.refreshVisualJobProgressFromRunState(args.jobId, args.outputDir)
    }
    const interval = setInterval(() => {
      void refresh().catch((error) => {
        console.error('[rss:analysis] visual progress refresh failed', error)
      })
    }, 2_000)
    try {
      await refresh()
      return await this.awaitVeaChildRun(args)
    } finally {
      stopped = true
      clearInterval(interval)
      await this.refreshVisualJobProgressFromRunState(args.jobId, args.outputDir)
    }
  }

  private async refreshVisualJobProgressFromRunState(
    jobId: string,
    outputDir: string,
  ): Promise<VisualRunStateSnapshot | null> {
    const snapshot = await readLatestVisualRunState(outputDir)
    if (!snapshot) return null
    const job = this.repository.getRSSAnalysisJob(jobId)
    if (!job || job.status === 'success' || job.status === 'failed') return snapshot
    const progress = Math.max(Number(job.progress) || 0, clampProgress(deriveVisualRunProgress(snapshot)))
    this.updateJob(jobId, {
      status: 'running_script',
      progress,
      message: visualRunProgressMessage(snapshot),
      error: snapshot.status === 'blocked' || snapshot.status === 'failed' ? snapshot.lastError : null,
    })
    return snapshot
  }

  /**
   * Phase 7 — translate a non-success VEA close event into a manager
   * Error that preserves distinct failed / killed / blocked / paused
   * semantics. Cancellation MUST NOT be reported as a generic failure.
   */
  private translateVeaCloseToError(
    result: StartSkillChildRunAndWaitResult,
    fallbackMessage: string,
  ): Error {
    const close = result.closeEvent
    if (!close) {
      const error = new Error(`${fallbackMessage}（仍在后台运行：observer_timeout）`)
      ;(error as Error & { veaCause?: string }).veaCause = 'paused'
      return error
    }
    const baseMessage = close.error?.message || fallbackMessage
    let qualifier = ''
    let cause: 'killed' | 'blocked' | 'paused' | 'failed' = 'failed'
    if (close.status === 'killed') {
      qualifier = `（已取消：${close.terminalReason}）`
      cause = 'killed'
    } else if (close.status === 'blocked') {
      qualifier = `（已阻塞：${close.terminalReason}）`
      cause = 'blocked'
    } else if (close.status === 'recoverable_paused' || close.status === 'budget_paused') {
      qualifier = `（已暂停：${close.terminalReason}）`
      cause = 'paused'
    }
    const error = new Error(`${baseMessage}${qualifier}`)
    ;(error as Error & { veaCause?: string }).veaCause = cause
    return error
  }

  private async runVisualFlow(
    jobId: string,
    payload: StartRSSItemAnalysisPayload,
    rootDir: string,
    outputDir: string,
  ): Promise<void> {
    if (!canAttemptVisualAnalysis(payload.link)) {
      throw new Error('视觉分析仅支持视频链接')
    }

    this.updateJob(jobId, {
      status: 'running_script',
      progress: 20,
      message: '正在执行视觉脚本分析',
    })

    const reusableVideoPath = await findReusableVideoFile(rootDir, payload.link)
    if (reusableVideoPath) {
      this.updateJob(jobId, {
        progress: 22,
        message: '复用已下载视频，正在执行视觉脚本分析',
      })
    }

    // Phase 7 — VEA long actions run as child runs. RSS visual flow keeps
    // its await-style behavior; internally the long work is now child-owned.
    const pipelineResult = await this.awaitVeaChildRunWithProgress({
      jobId,
      outputDir,
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      params: {
        url: reusableVideoPath || payload.link,
        outputDir,
      },
      timeoutMs: 35 * 60 * 1000,
    })
    if (!pipelineResult.success) {
      throw this.translateVeaCloseToError(pipelineResult, '视觉脚本分析失败')
    }

    const sceneScoresPath = await findFileByName(outputDir, 'scene_scores.json')
    if (!sceneScoresPath) {
      throw new Error('未找到 scene_scores.json，无法继续视觉评分')
    }
    const sourceVideoPath = reusableVideoPath || await findReusableVideoFile(outputDir, payload.link)
    const afterPipelineJob = this.repository.getRSSAnalysisJob(jobId)

    this.updateJob(jobId, {
      status: 'running_script',
      progress: Math.max(64, Number(afterPipelineJob?.progress) || 0),
      message: '正在执行 AI 视觉评分',
    })

    const aiResult = await this.awaitVeaChildRunWithProgress({
      jobId,
      outputDir,
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      params: {
        sceneScoresPath,
        mode: 'api',
        // Pass the same outputDir the pipeline used so the child driver
        // can resolve run_state.json without inferring it from the scene
        // scores path. Reduces ambiguity but the driver's cold-start
        // path no longer requires it.
        outputDir,
      },
      timeoutMs: 35 * 60 * 1000,
    })
    if (!aiResult.success) {
      throw this.translateVeaCloseToError(aiResult, '视觉 AI 评分失败')
    }
    const afterAiJob = this.repository.getRSSAnalysisJob(jobId)

    this.updateJob(jobId, {
      status: 'running_subagent',
      progress: Math.max(92, Number(afterAiJob?.progress) || 0),
      message: 'subagent 正在汇总视觉结论',
    })

    const outputSummary = await collectTextFiles(outputDir, ['.md', '.json', '.txt'], 7_000)
    const summary = await rssSubagentRunner.summarizeVisual({
      title: payload.title,
      link: payload.link,
      source: payload.source,
      pipelineSummary: outputSummary,
    })

    const reportPath = join(outputDir, '视觉分析总结.md')
    await writeFile(
      reportPath,
      [
        '# 视觉分析总结',
        '',
        `- 标题: ${payload.title}`,
        `- 链接: ${payload.link}`,
        `- 来源: ${payload.source || '未知来源'}`,
        '',
        summary.trim(),
        '',
      ].join('\n'),
      'utf-8',
    )

    const manifestPath = join(outputDir, 'manifest.json')
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          action: payload.action,
          itemId: payload.itemId,
          title: payload.title,
          link: payload.link,
          outputDir,
          rootDir,
          reportPath,
          sceneScoresPath,
          sourceVideoPath,
          reusedSourceVideo: Boolean(reusableVideoPath),
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    )

    this.updateJob(jobId, {
      progress: 98,
      message: '视觉报告已生成',
      reportPath,
    })
  }

  private updateJob(
    jobId: string,
    patch: Partial<{
      status: RSSAnalysisJobStatus
      progress: number
      message: string | null
      error: string | null
      reportPath: string | null
      finishedAt: string | null
      startedAt: string | null
    }>,
  ): RSSAnalysisJob | null {
    return this.repository.updateRSSAnalysisJob(jobId, patch)
  }
}

let managerInstance: RSSItemAnalysisManager | null = null

export function getRSSItemAnalysisManager(): RSSItemAnalysisManager {
  if (!managerInstance) {
    managerInstance = new RSSItemAnalysisManager()
  }
  return managerInstance
}
