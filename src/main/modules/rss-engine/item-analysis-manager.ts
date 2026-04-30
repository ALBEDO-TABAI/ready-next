import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { readFile, readdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
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
import { extractWebContentToFile } from './content-extractor'
import { rssSubagentRunner } from './subagent-runner'

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

const VIDEO_HOST_HINTS = [
  'youtube.com',
  'youtu.be',
  'bilibili.com',
  'b23.tv',
  'bili2233.cn',
  'vimeo.com',
  'douyin.com',
  'tiktok.com',
  'xiaohongshu.com',
  'xhslink.com',
]

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv']

function sanitizeName(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const normalized = cleaned || 'rss-item'
  return normalized.slice(0, 56)
}

function isLikelyVideoLink(url: string): boolean {
  const lower = (url || '').trim().toLowerCase()
  if (!lower) return false
  if (VIDEO_EXTS.some((ext) => lower.endsWith(ext))) return true
  if (lower.includes('/video/')) return true
  try {
    const parsed = new URL(lower)
    if (VIDEO_HOST_HINTS.some((host) => parsed.hostname.includes(host))) return true
    if (VIDEO_EXTS.some((ext) => parsed.pathname.endsWith(ext))) return true
  } catch {
    return VIDEO_EXTS.some((ext) => lower.endsWith(ext))
  }
  return false
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
 * deserves a retry; everything else (failed_skill / infra_error /
 * cancelled_user / blocked_*) is propagated to the caller. Bounded retry
 * keeps RSS visual flow alive when the user has 3 other VEA child runs in
 * flight.
 */
const VEA_AWAIT_RETRY_LIMIT = 3
const VEA_AWAIT_RETRY_DELAY_MS = 5000

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
      this.updateJob(jobId, {
        status: 'failed',
        message: '分析失败',
        error: message,
        finishedAt: new Date().toISOString(),
      })
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

    if (isVideo) {
      this.updateJob(jobId, {
        status: 'running_script',
        progress: 24,
        message: '正在提取视频文案',
      })
      const skillResult = await runtime.runSkill({
        skillId: 'video-copy-analyzer',
        action: 'video_copy_analyze',
        params: {
          input: payload.link,
          outputDir,
          model: 'small',
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
        message: '文案提取完成，正在生成总结',
      })
      extractedText = await collectTextFiles(outputDir, ['.md', '.txt', '.srt'], 12_000)
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
      message: 'subagent 正在撰写文案报告',
    })

    const summary = await rssSubagentRunner.summarizeCopy({
      title: payload.title,
      link: payload.link,
      source: payload.source,
      summary: payload.summary,
      publishedAt: payload.publishedAt,
      extractedText,
    })

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
      if (
        result.closeEvent.terminalReason === 'queued_global_concurrency'
        && attempt < VEA_AWAIT_RETRY_LIMIT - 1
      ) {
        attempt += 1
        await new Promise((resolve) => setTimeout(resolve, this.veaAwaitRetryDelayMs))
        continue
      }
      return result
    }
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
    if (!isLikelyVideoLink(payload.link)) {
      throw new Error('视觉分析仅支持视频链接')
    }

    this.updateJob(jobId, {
      status: 'running_script',
      progress: 20,
      message: '正在执行视觉脚本分析',
    })

    // Phase 7 — VEA long actions run as child runs. RSS visual flow keeps
    // its await-style behavior; internally the long work is now child-owned.
    const pipelineResult = await this.awaitVeaChildRun({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      params: {
        url: payload.link,
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

    this.updateJob(jobId, {
      status: 'running_script',
      progress: 64,
      message: '正在执行 AI 视觉评分',
    })

    const aiResult = await this.awaitVeaChildRun({
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      params: {
        sceneScoresPath,
        mode: 'api',
      },
      timeoutMs: 35 * 60 * 1000,
    })
    if (!aiResult.success) {
      throw this.translateVeaCloseToError(aiResult, '视觉 AI 评分失败')
    }

    this.updateJob(jobId, {
      status: 'running_subagent',
      progress: 92,
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
