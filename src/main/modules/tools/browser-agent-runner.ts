import { appendFileSync } from 'fs'
import type { BrowserController } from '../browser-engine/ipc-handler'
import { rememberBrowserWorkflowState } from '../agent-control/session-continuity'
import { executeBrowserTool } from './browser-tools'
import { getLogPath } from '../../utils/platform'

type BrowserAgentSessionState =
  | 'queued'
  | 'planning'
  | 'acting'
  | 'waiting'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'partial'
  | 'cancelled'

type BrowserWorkflowStage =
  | 'resolve_target_page'
  | 'resolve_attachment'
  | 'navigate_target'
  | 'ensure_upload'
  | 'ensure_prompt'
  | 'submit'
  | 'final_reconcile'
  | 'recover'

export interface BrowserAgentRunResult {
  handled: boolean
  state: BrowserAgentSessionState
  message: string
  details?: Record<string, unknown>
  continueToolLoop?: boolean
  nudge?: string
}

interface BrowserTaskAttachmentResourceLike {
  attachmentId: string
  name: string
  type: string
  mimeType?: string
  path?: string
  createdAt?: string
  state?: 'selected' | 'injected' | 'mounted_on_page' | 'consumed'
}

interface BrowserTaskLinkResourceLike {
  url: string
  order: number
  source: 'markdown' | 'raw'
}

interface BrowserPlanStepLike {
  id: BrowserWorkflowStage
  goal: string
  action: string
  verify: string[]
  skipIf: string[]
  failIf: string[]
  retryLimit: number
  recoverWith: string[]
}

interface BrowserTaskPlanLike {
  taskKind: 'upload_generate' | 'upload_edit' | 'pure_web_action' | 'multi_page_sequence' | 'clarify'
  taskGoal?: string
  expectedOutcome?: string
  resources?: {
    attachments: BrowserTaskAttachmentResourceLike[]
    links: BrowserTaskLinkResourceLike[]
  }
  attachmentIntent: {
    mode: 'latest' | 'specific' | 'none'
    attachmentId?: string
    latestName?: string
  }
  targetUrl?: string
  promptIntent: {
    raw: string
    refined: string
    confidence: 'high' | 'medium' | 'low'
    mustUse?: string
    source?: string
  }
  steps?: BrowserPlanStepLike[]
  requiredStages: BrowserWorkflowStage[]
  completionCriteria: string[]
  skipRules: string[]
  successCriteria?: string[]
  failureCriteria?: string[]
  retryPolicy?: string
  finalCheck?: {
    expectedOutcome: string
    successCriteria: string[]
  }
}

interface BrowserTaskDecisionLike {
  mode: 'free_tool_loop' | 'browser_workflow' | 'browser_upload_workflow' | 'clarify_first'
  reason: string
  attachmentSelection?: {
    count: number
    latestName?: string
  }
  promptIntent?: {
    raw: string
    refined: string
    confidence: 'high' | 'medium' | 'low'
    source: 'quoted' | 'keyword' | 'descriptive_clause' | 'model_refiner' | 'none'
    mustUse?: string
  }
  plan?: BrowserTaskPlanLike
}

interface WorkflowActionTarget {
  kind?: string
  label?: string
  selectorHint?: string
  x?: number
  y?: number
  confidence?: number
  evidence?: string[]
  focused?: boolean
  textLength?: number
  valuePreview?: string
  nearActiveInput?: boolean
  distanceToActiveInput?: number
}

interface ParsedActionTargetPayload {
  targets: WorkflowActionTarget[]
  activeTarget: WorkflowActionTarget | null
  nearbySendTargets: WorkflowActionTarget[]
}

interface PromptSubmissionProbe {
  promptMatched: boolean
  promptFilled: boolean
  promptText: string
  generating: boolean
  submitEvidence: string[]
  sendButtonCount: number
  sendButtonDisabled: boolean
  uploadChipVisible: boolean
}

interface PageIdentity {
  url: string
  title: string
  activeElement: string
}

interface UploadProbe {
  complete: boolean
  evidence: string[]
  inputHasFiles: boolean
  previewVisible: boolean
  attachmentNameMatched: boolean
  removeActionVisible: boolean
}

interface DomStateProbe {
  inputCandidateCount: number
  sendCandidateCount: number
  uploadCandidateCount: number
  modalVisible: boolean
  bodyStateText: string
}

interface WorkflowSnapshot {
  stage: BrowserWorkflowStage
  page: PageIdentity
  screenshotId?: string
  uploadState: UploadProbe
  promptState: PromptSubmissionProbe
  domState: DomStateProbe
  candidates?: {
    uploadTargets: WorkflowActionTarget[]
    inputTargets: WorkflowActionTarget[]
    activeInputTarget: WorkflowActionTarget | null
    nearbySendTargets: WorkflowActionTarget[]
    sendTargets: WorkflowActionTarget[]
  }
  evidenceIds?: string[]
  controllerId?: string
  tabRole?: string
  visionHints?: {
    upload?: WorkflowActionTarget[]
    input?: WorkflowActionTarget[]
    send?: WorkflowActionTarget[]
  }
}

interface StageExecutionResult {
  stage: BrowserWorkflowStage
  completed: boolean
  skipped: boolean
  evidence: string[]
  nextStage?: BrowserWorkflowStage | 'done' | 'failed' | 'clarify'
  recoverable: boolean
  snapshot: WorkflowSnapshot
}

interface PromptEntryResult {
  completed: boolean
  evidence: string[]
  snapshot: WorkflowSnapshot
}

interface SubmitStageResult {
  completed: boolean
  evidence: string[]
  snapshot: WorkflowSnapshot
}

interface BrowserAgentRunnerOptions {
  abortSignal?: AbortSignal
  sessionId?: string
  decision?: BrowserTaskDecisionLike
  emitToolEvent?: (type: 'tool_use' | 'tool_result', text: string) => void
}

const LOG = getLogPath('ready-tools.log')
const STAGE_ATTEMPTS: Record<'ensure_upload' | 'ensure_prompt' | 'submit' | 'final_reconcile' | 'recover', number> = {
  ensure_upload: 2,
  ensure_prompt: 2,
  submit: 3,
  final_reconcile: 2,
  recover: 2,
}

function log(message: string): void {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // ignore
  }
}

function parseJSONText(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  } catch {
    // ignore
  }
  return null
}

function normalizeComparableUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.origin}${pathname}`
  } catch {
    return raw.trim()
  }
}

function normalizeText(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function uniqueEvidence(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

export class BrowserAgentRunner {
  private readonly controller: BrowserController
  private readonly abortSignal?: AbortSignal
  private readonly sessionId?: string
  private readonly decision?: BrowserTaskDecisionLike
  private readonly emitToolEvent?: (type: 'tool_use' | 'tool_result', text: string) => void
  private activePlan: BrowserTaskPlanLike | null = null
  private state: BrowserAgentSessionState = 'queued'
  private readonly workflowSnapshotCache = new Map<string, { snapshot: WorkflowSnapshot; createdAt: number }>()
  private readonly visionHintCache = new Map<string, { targets: WorkflowActionTarget[]; createdAt: number }>()
  private promptAnchorLock: {
    pageUrl: string
    inputTarget: WorkflowActionTarget | null
    nearbySendTargets: WorkflowActionTarget[]
    capturedAt: number
  } | null = null

  constructor(controller: BrowserController, options?: BrowserAgentRunnerOptions) {
    this.controller = controller
    this.abortSignal = options?.abortSignal
    this.sessionId = options?.sessionId
    this.decision = options?.decision
    this.emitToolEvent = options?.emitToolEvent
  }

  private ensureNotAborted(): void {
    if (this.abortSignal?.aborted) {
      const error = new Error('Browser runner aborted')
      error.name = 'AbortError'
      throw error
    }
  }

  private emitStage(stage: BrowserWorkflowStage, message: string): void {
    const labels: Record<BrowserWorkflowStage, string> = {
      resolve_target_page: '确认目标页',
      resolve_attachment: '确认附件',
      navigate_target: '进入目标页',
      ensure_upload: '上传附件',
      ensure_prompt: '填写提示词',
      submit: '提交执行',
      final_reconcile: '结果复核',
      recover: '恢复页面',
    }
    const planSteps = this.activePlan?.steps || []
    const stepIndex = planSteps.findIndex((step) => step.id === stage)
    const stepPrefix = stepIndex >= 0 ? `步骤 ${stepIndex + 1}/${planSteps.length} ` : ''
    log(`[browser-v7][stage] ${stage} ${message}`)
    this.emitToolEvent?.('tool_result', `[阶段] ${stepPrefix}${labels[stage]}：${message}`)
  }

  private rememberContinuationState(
    stage: string,
    snapshot: WorkflowSnapshot,
    promptCandidate: string,
    attachmentName?: string,
    status?: 'running' | 'done' | 'partial' | 'failed',
  ): void {
    if (!this.sessionId) return
    const activeTab = this.controller.getActiveTab()
    rememberBrowserWorkflowState(this.sessionId, {
      tabId: activeTab?.id,
      url: snapshot.page.url,
      title: snapshot.page.title || activeTab?.title || '',
      workflowKind: this.activePlan?.taskKind || this.decision?.plan?.taskKind || 'browser_workflow',
      stage,
      attachmentName,
      promptPreview: promptCandidate.slice(0, 180),
      evidence: uniqueEvidence([
        ...snapshot.uploadState.evidence,
        ...snapshot.promptState.submitEvidence,
        snapshot.promptState.promptMatched ? 'prompt_matched' : '',
        snapshot.promptState.promptFilled ? 'prompt_filled' : '',
        snapshot.promptState.uploadChipVisible ? 'upload_chip_visible' : '',
        snapshot.domState.modalVisible ? 'modal_visible' : '',
      ]),
      running: this.isRunningState(snapshot),
      uploadMounted: this.isUploadComplete(snapshot),
      promptFilled: this.isPromptComplete(snapshot, promptCandidate),
      status: status || (this.isRunningState(snapshot) ? 'running' : 'partial'),
    })
  }

  private buildDefaultPlan(): BrowserTaskPlanLike {
    return this.decision?.plan || {
      taskKind: 'upload_generate',
      taskGoal: '在目标页面使用当前会话附件完成上传、填写提示词并提交任务。',
      expectedOutcome: '页面已挂载指定附件、提示词已进入正确输入区，且页面进入运行态。',
      resources: {
        attachments: this.decision?.attachmentSelection?.latestName
          ? [{
            attachmentId: 'latest',
            name: this.decision.attachmentSelection.latestName,
            type: 'image',
          }]
          : [],
        links: this.decision?.plan?.resources?.links || [],
      },
      attachmentIntent: {
        mode: this.decision?.attachmentSelection?.count ? 'latest' : 'none',
        attachmentId: this.decision?.plan?.attachmentIntent?.attachmentId,
        latestName: this.decision?.attachmentSelection?.latestName,
      },
      promptIntent: {
        raw: this.decision?.promptIntent?.raw || '',
        refined: this.decision?.promptIntent?.refined || '',
        confidence: this.decision?.promptIntent?.confidence || 'low',
      },
      steps: [
        {
          id: 'resolve_target_page',
          goal: '确认本轮操作的目标页',
          action: '从计划资源中解析目标页面，不立即导航。',
          verify: ['得到唯一 targetUrl 或继续使用当前页'],
          skipIf: ['目标页已锁定'],
          failIf: ['没有可用目标页'],
          retryLimit: 0,
          recoverWith: [],
        },
        {
          id: 'resolve_attachment',
          goal: '确认本轮使用的附件',
          action: '从会话附件中锁定一个明确附件。',
          verify: ['得到 attachmentId'],
          skipIf: ['附件已锁定'],
          failIf: ['没有可用附件'],
          retryLimit: 0,
          recoverWith: [],
        },
        {
          id: 'navigate_target',
          goal: '进入目标页面',
          action: '只在确认目标页后才导航。',
          verify: ['当前 URL 与目标匹配'],
          skipIf: ['已在目标页'],
          failIf: ['导航后仍无法确认目标页'],
          retryLimit: 1,
          recoverWith: ['返回目标页'],
        },
        {
          id: 'ensure_upload',
          goal: '让附件挂载到页面',
          action: '定位上传入口并上传附件。',
          verify: ['出现页面级附件证据'],
          skipIf: ['页面已有附件证据'],
          failIf: ['未检测到页面级附件证据'],
          retryLimit: 2,
          recoverWith: ['恢复页面后重试上传'],
        },
        {
          id: 'ensure_prompt',
          goal: '把最终提示词写入输入区',
          action: '先确认当前焦点或最高置信输入区确实是 prompt 输入区，再写入 mustUsePrompt。',
          verify: ['输入框文本与提示词匹配'],
          skipIf: ['页面已有匹配 prompt'],
          failIf: ['无法确认 prompt 已进入输入区'],
          retryLimit: 2,
          recoverWith: ['重新定位输入区并恢复焦点'],
        },
        {
          id: 'submit',
          goal: '触发提交或生成',
          action: '优先使用与当前输入区相邻的发送/生成控件；如果缺少输入锚点，先重新定位或改走键盘提交。',
          verify: ['页面进入运行态'],
          skipIf: ['页面已在运行中'],
          failIf: ['无法确认提交成功'],
          retryLimit: 3,
          recoverWith: ['恢复后重试提交，并重新确认输入锚点'],
        },
        {
          id: 'final_reconcile',
          goal: '复核结果与目标一致',
          action: '检查附件、prompt 和运行态是否满足预期。',
          verify: ['满足 successCriteria'],
          skipIf: [],
          failIf: ['关键证据缺失'],
          retryLimit: 1,
          recoverWith: ['建议重试或人工接管'],
        },
      ],
      requiredStages: [
        'resolve_target_page',
        'resolve_attachment',
        'navigate_target',
        'ensure_upload',
        'ensure_prompt',
        'submit',
        'final_reconcile',
      ],
      completionCriteria: [
        '上传附件已被页面确认',
        '提示词已进入输入区',
        '页面进入生成中或处理中状态',
      ],
      skipRules: [
        '检测到上传缩略图时跳过上传',
        '检测到提示词已在输入框时跳过填写',
        '检测到页面运行中时结束任务',
      ],
      successCriteria: [
        '页面已挂载附件',
        '提示词已写入',
        '页面已进入运行态',
      ],
      failureCriteria: [
        '无法确认目标页',
        '无法确认附件已挂载',
        '无法确认 prompt 已写入',
        '无法确认页面已进入运行态',
      ],
      retryPolicy: '关键步骤在独立预算下重试；证据不足时才继续。',
      finalCheck: {
        expectedOutcome: '页面已挂载附件、提示词已写入，并进入运行态。',
        successCriteria: [
          '页面已挂载附件',
          '提示词已写入',
          '页面已进入运行态',
        ],
      },
    }
  }

  private extractPromptCandidate(input: string): string {
    const compact = String(input || '').replace(/\s+/g, ' ').trim()
    const promptMatch =
      compact.match(/(?:提示词|prompt|文案|文字|描述)[：:]\s*["“]?(.+?)["”]?$/i) ||
      compact.match(/[“"]([^“”"]{4,240})[”"]/)
    if (promptMatch?.[1]) return promptMatch[1].trim()

    return compact
      .replace(/^(帮我|请你|请|麻烦你)/, '')
      .replace(/(把|将)?(刚发的图|这张图|上一张图|附件|这张附件|图片附件)/g, '')
      .replace(/(上传|放进|放到|塞进|导入)(网页|页面|网站|聊天框|输入框|即梦|画板)?/g, '')
      .replace(/(然后|再|并|并且).*/g, '')
      .replace(/(点击|输入|提交|发送|生成|生图|处理)/g, '')
      .replace(/[，。！!？?]+$/g, '')
      .trim()
  }

  private getPlannedTargetUrl(plan: BrowserTaskPlanLike): string | undefined {
    const firstLink = plan.resources?.links?.[0]?.url
    return String(firstLink || plan.targetUrl || '').trim() || undefined
  }

  private getPlannedAttachment(plan: BrowserTaskPlanLike): BrowserTaskAttachmentResourceLike | null {
    const attachments = plan.resources?.attachments || []
    if (attachments[0]) return attachments[0]
    if (plan.attachmentIntent.latestName) {
      return {
        attachmentId: plan.attachmentIntent.attachmentId || 'latest',
        name: plan.attachmentIntent.latestName,
        type: 'image',
      }
    }
    return null
  }

  private getPlanStep(plan: BrowserTaskPlanLike, stage: BrowserWorkflowStage): BrowserPlanStepLike | undefined {
    return plan.steps?.find((step) => step.id === stage)
  }

  private looksLikePromptWorkflowNoise(value: string): boolean {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    if (!text) return false
    if (/^[，。；;、,\s]+/.test(text)) return true
    if (/https?:\/\//i.test(text)) return true
    if (/(然后|接着|随后|再去|继续).{0,12}(即梦|jimeng|gemini|kimi|网页|页面|网站|浏览器)/i.test(text)) return true
    if (/(^|[，。,；;\s])(上传|点击|打开|进入|搜索|跳转|发送|提交|浏览器|网页|页面|网站|登录|去即梦|去jimeng|继续生图)([，。,；;\s]|$)/i.test(text)) return true
    return false
  }

  private isPromptCandidateConfident(value: string): boolean {
    const text = String(value || '').trim()
    if (!text) return false
    if (text.length < 2 || text.length > 180) return false
    if (this.looksLikePromptWorkflowNoise(text)) return false
    if (/(上传|附件|浏览器|页面|网站|点击|输入|提交|发送|继续操作|继续处理)/.test(text)) return false
    return true
  }

  private resolvePromptCandidate(input: string): { value: string; confidence: 'high' | 'medium' | 'low'; source: string } {
    const plan = this.activePlan || this.buildDefaultPlan()
    const mustUse = plan.promptIntent?.mustUse?.trim()
    if (mustUse && !this.looksLikePromptWorkflowNoise(mustUse)) {
      return {
        value: mustUse,
        confidence: plan.promptIntent.confidence || 'medium',
        source: plan.promptIntent.source || 'planner',
      }
    }
    const intent = this.decision?.promptIntent
    if (intent?.refined && !this.looksLikePromptWorkflowNoise(intent.refined)) {
      return {
        value: intent.refined.trim(),
        confidence: intent.confidence,
        source: intent.source,
      }
    }
    return {
      value: this.extractPromptCandidate(input),
      confidence: 'low',
      source: 'runner_fallback',
    }
  }

  private async invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    options?: { silent?: boolean },
  ): Promise<string> {
    if (!options?.silent) {
      this.emitToolEvent?.('tool_use', `${toolName}(${JSON.stringify(args).slice(0, 160)})`)
    }
    const result = await executeBrowserTool(
      toolName,
      args,
      this.controller,
      this.abortSignal,
      this.sessionId,
    )
    if (!options?.silent) {
      this.emitToolEvent?.('tool_result', result.slice(0, 220))
    }
    if ([
      'browser_navigate',
      'browser_upload_scope_attachment',
      'browser_click_at',
      'browser_click',
      'browser_click_text',
      'browser_type',
      'browser_type_smart',
      'browser_type_at',
      'browser_compose_message',
      'browser_send_keys',
      'browser_go_back',
      'browser_run_workflow',
      'browser_query_gemini',
    ].includes(toolName)) {
      this.invalidateWorkflowCaches()
    }
    return result
  }

  private invalidateWorkflowCaches(options?: { keepVision?: boolean }): void {
    this.workflowSnapshotCache.clear()
    if (!options?.keepVision) {
      this.visionHintCache.clear()
      this.promptAnchorLock = null
    }
  }

  private buildLivePageKey(): string {
    const activeTab = this.controller.getActiveTab()
    return [
      activeTab?.id || 'no-tab',
      normalizeComparableUrl(activeTab?.url || ''),
    ].join('::')
  }

  private buildSnapshotCacheKey(
    stage: BrowserWorkflowStage,
    promptCandidate: string,
    attachmentName?: string,
    visionAction?: 'upload' | 'input' | 'send',
  ): string {
    return [
      this.buildLivePageKey(),
      stage,
      normalizeText(promptCandidate).slice(0, 160),
      normalizeText(attachmentName || '').slice(0, 80),
      visionAction || 'none',
    ].join('::')
  }

  private getVisionCacheKey(action: 'upload' | 'input' | 'send'): string {
    return `${this.buildLivePageKey()}::${action}`
  }

  private rememberPromptAnchor(snapshot: WorkflowSnapshot): void {
    const pageUrl = normalizeComparableUrl(snapshot.page.url)
    if (!pageUrl) return
    const inputTarget = snapshot.candidates?.activeInputTarget || snapshot.candidates?.inputTargets?.[0] || null
    const nearbySendTargets = snapshot.candidates?.nearbySendTargets || []
    if (!inputTarget && nearbySendTargets.length === 0) return
    this.promptAnchorLock = {
      pageUrl,
      inputTarget,
      nearbySendTargets,
      capturedAt: Date.now(),
    }
  }

  private getLockedPromptAnchor(snapshot: WorkflowSnapshot): {
    inputTarget: WorkflowActionTarget | null
    nearbySendTargets: WorkflowActionTarget[]
  } | null {
    if (!this.promptAnchorLock) return null
    const samePage = this.promptAnchorLock.pageUrl === normalizeComparableUrl(snapshot.page.url)
    const fresh = Date.now() - this.promptAnchorLock.capturedAt <= 30_000
    if (!samePage || !fresh) return null
    return {
      inputTarget: this.promptAnchorLock.inputTarget,
      nearbySendTargets: this.promptAnchorLock.nearbySendTargets,
    }
  }

  private normalizeActionTargets(raw: unknown): WorkflowActionTarget[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw
      .filter((item) => item && typeof item === 'object')
      .map((item) => item as WorkflowActionTarget)
      .filter((item) => Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)))
      .filter((item) => {
        const key = `${String(item.kind || '')}|${String(item.label || '')}|${Number(item.x)}|${Number(item.y)}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) =>
        Number(Boolean(b.focused)) - Number(Boolean(a.focused)) ||
        Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
        Number(b.confidence || 0) - Number(a.confidence || 0)
      )
  }

  private parseActionTargetPayload(raw: string): ParsedActionTargetPayload {
    const payload = parseJSONText(raw)
    if (!payload) {
      return { targets: [], activeTarget: null, nearbySendTargets: [] }
    }
    const targets = this.normalizeActionTargets(payload.targets)
    const activeTarget = this.normalizeActionTargets(
      payload.active_target ? [payload.active_target] : payload.activeTarget ? [payload.activeTarget] : [],
    )[0] || null
    const nearbySendTargets = this.normalizeActionTargets(
      Array.isArray(payload.nearby_send_targets)
        ? payload.nearby_send_targets
        : Array.isArray(payload.nearbySendTargets)
          ? payload.nearbySendTargets
          : [],
    )
    return { targets, activeTarget, nearbySendTargets }
  }

  private parseActionTargets(raw: string): WorkflowActionTarget[] {
    return this.parseActionTargetPayload(raw).targets
  }

  private async getPageIdentity(): Promise<PageIdentity> {
    const result = await this.controller.executeJS(
      null,
      `(() => ({
        url: String(window.location.href || ''),
        title: String(document.title || ''),
        activeElement: String(document.activeElement?.tagName || '').toLowerCase() + ':' + String(document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.getAttribute?.('placeholder') || document.activeElement?.id || '')
      }))()`,
    ) as PageIdentity | null

    return {
      url: String(result?.url || ''),
      title: String(result?.title || ''),
      activeElement: String(result?.activeElement || ''),
    }
  }

  private async probeUploadState(attachmentName?: string): Promise<UploadProbe> {
    const safeName = String(attachmentName || '').trim()
    const basename = safeName.replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase()
    const result = await this.controller.executeJS(
      null,
      `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 12 || rect.height < 12) return false
          const style = getComputedStyle(el)
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false
          return Number(style.opacity || '1') > 0
        }
        const attachmentNeedle = ${JSON.stringify(basename)}
        const bodyText = normalize(document.body?.innerText || '')
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
          .filter((node) => node instanceof HTMLInputElement)
        const inputHasFiles = fileInputs.some((node) => node.files && node.files.length > 0)
        const viewportW = Math.max(1, window.innerWidth || 0)
        const viewportH = Math.max(1, window.innerHeight || 0)
        const previewNodes = Array.from(document.querySelectorAll('img,video,[role="img"],canvas,.thumbnail,[class*="thumb"],[class*="preview"],[data-testid*="upload" i],[data-testid*="preview" i]'))
          .filter((node) => visible(node))
        const removeNodes = Array.from(document.querySelectorAll('button,[role="button"],span,div,a'))
          .filter((node) => visible(node))
          .map((node) => normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || ''))
          .filter((text) => /remove|delete|clear|close|移除|删除|清除|取消|×|x/.test(text))
        const uploadMarkers = /upload|uploaded|preview|thumbnail|附件|参考图|素材|已上传|原图|参考/.test(bodyText)
        const attachmentNameMatched = Boolean(attachmentNeedle && bodyText.includes(attachmentNeedle))
        const previewVisible = previewNodes.some((node) => {
          if (!(node instanceof HTMLElement)) return false
          const rect = node.getBoundingClientRect()
          const meta = normalize([
            node.getAttribute?.('aria-label'),
            node.getAttribute?.('title'),
            node.getAttribute?.('data-testid'),
            node.getAttribute?.('class'),
            node.textContent,
          ].filter(Boolean).join(' '))
          const looksLikeNamedPreview = !attachmentNeedle || meta.includes(attachmentNeedle) || /preview|thumbnail|附件|已上传|upload|参考图|素材/.test(meta)
          const smallPreviewCluster =
            rect.width >= 24 &&
            rect.height >= 24 &&
            rect.width <= Math.min(220, viewportW * 0.28) &&
            rect.height <= Math.min(220, viewportH * 0.28) &&
            rect.top >= viewportH * 0.55
          return looksLikeNamedPreview || smallPreviewCluster || uploadMarkers || removeNodes.length > 0
        })
        const evidence = []
        if (inputHasFiles) evidence.push('file_input_has_files')
        if (attachmentNameMatched) evidence.push('attachment_name_visible')
        if (previewVisible) evidence.push('preview_or_chip_visible')
        if (removeNodes.length > 0) evidence.push('remove_action_visible')
        return {
          complete: Boolean(inputHasFiles || attachmentNameMatched || previewVisible),
          evidence,
          inputHasFiles,
          previewVisible,
          attachmentNameMatched,
          removeActionVisible: removeNodes.length > 0,
        }
      })()`,
    ) as UploadProbe | null

    return {
      complete: Boolean(result?.complete),
      evidence: Array.isArray(result?.evidence) ? result.evidence : [],
      inputHasFiles: Boolean(result?.inputHasFiles),
      previewVisible: Boolean(result?.previewVisible),
      attachmentNameMatched: Boolean(result?.attachmentNameMatched),
      removeActionVisible: Boolean(result?.removeActionVisible),
    }
  }

  private async probeDomState(): Promise<DomStateProbe> {
    const result = await this.controller.executeJS(
      null,
      `(() => {
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 10 || rect.height < 10) return false
          const style = getComputedStyle(el)
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false
          return Number(style.opacity || '1') > 0
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
          .filter((node) => visible(node))
        const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],label,[tabindex]'))
          .filter((node) => visible(node))
        const sendCandidateCount = buttons.filter((node) => {
          const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
          return /send|提交|发送|继续|generate|生成|创作|run|go|发布/.test(meta)
        }).length
        const uploadCandidateCount = buttons.filter((node) => {
          const meta = normalize(node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || node.getAttribute?.('data-testid') || node.getAttribute?.('class') || '')
          return /upload|上传|附件|图片|素材|参考图|file|image|plus|add|导入|拖拽/.test(meta)
        }).length
        const modalVisible = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog,.modal,.drawer,.popup'))
          .some((node) => visible(node))
        const bodyStateText = normalize(document.body?.innerText || '').slice(0, 1200)
        return {
          inputCandidateCount: editables.length,
          sendCandidateCount,
          uploadCandidateCount,
          modalVisible,
          bodyStateText,
        }
      })()`,
    ) as DomStateProbe | null

    return {
      inputCandidateCount: Number(result?.inputCandidateCount || 0),
      sendCandidateCount: Number(result?.sendCandidateCount || 0),
      uploadCandidateCount: Number(result?.uploadCandidateCount || 0),
      modalVisible: Boolean(result?.modalVisible),
      bodyStateText: String(result?.bodyStateText || ''),
    }
  }

  private async probePromptSubmissionState(expectedPrompt: string): Promise<PromptSubmissionProbe> {
    const result = await this.controller.executeJS(
      null,
      `(() => {
        const expected = ${JSON.stringify(String(expectedPrompt || '').trim().toLowerCase())}
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width <= 0 || rect.height <= 0) return false
          const style = getComputedStyle(el)
          if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') <= 0) return false
          return true
        }
        const blockedInputTypes = new Set(['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'range', 'color', 'date', 'time', 'month', 'week'])
        const isEditable = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const isTextInput = el instanceof HTMLInputElement && !blockedInputTypes.has((el.type || 'text').toLowerCase())
          const isTextarea = el instanceof HTMLTextAreaElement
          const role = (el.getAttribute('role') || '').toLowerCase()
          const roleTextbox = role === 'textbox' || role === 'searchbox'
          const hasContentEditableAttr = el.hasAttribute('contenteditable')
          const editableAttr = String(el.getAttribute('contenteditable') || '').toLowerCase()
          const isContentEditable =
            el.isContentEditable ||
            (hasContentEditableAttr && (editableAttr === '' || editableAttr === 'true' || editableAttr === 'plaintext-only'))
          if (!(isTextInput || isTextarea || roleTextbox || isContentEditable)) return false
          if (el.getAttribute('aria-disabled') === 'true') return false
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.disabled || el.readOnly) return false
          }
          return visible(el)
        }
        const editableText = (el) => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return String(el.value || '')
          return String(el.innerText || el.textContent || '')
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="searchbox"]'))
          .filter(isEditable)
        const promptCandidate = editables
          .map((el) => {
            const meta = normalize([
              el.getAttribute('placeholder'),
              el.getAttribute('aria-label'),
              el.getAttribute('name'),
              el.getAttribute('id'),
              el.getAttribute('title'),
              el.getAttribute('data-testid'),
              el.getAttribute('class'),
            ].filter(Boolean).join(' '))
            const rect = el.getBoundingClientRect()
            let score = 0
            if (/prompt|提示|文案|描述|输入|message|chat|ask|生成|创作|内容/.test(meta)) score += 12
            if (el.tagName.toLowerCase() === 'textarea') score += 4
            if ((el instanceof HTMLElement) && el.isContentEditable) score += 3
            if (rect.bottom > window.innerHeight * 0.45) score += 3
            if (rect.width > window.innerWidth * 0.25) score += 2
            if (/时间|生成类型|操作类型|筛选|排序|search|搜索/.test(meta)) score -= 14
            if (rect.top < window.innerHeight * 0.38) score -= 8
            return { text: editableText(el), meta, score }
          })
          .filter((item) => item.score >= 2)
          .sort((a, b) => b.score - a.score || b.text.length - a.text.length)[0]

        const promptText = normalize(promptCandidate?.text || '')
        const promptMatched =
          Boolean(expected) &&
          promptText.length >= Math.min(Math.max(12, Math.floor(expected.length * 0.4)), expected.length) &&
          (promptText === expected || promptText.includes(expected) || expected.includes(promptText))
        const promptFilled = Boolean(promptText)

        const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'))
          .filter(visible)
          .map((el) => {
            const meta = normalize([
              el.textContent,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('data-testid'),
              el.getAttribute('class'),
            ].filter(Boolean).join(' '))
            const disabled =
              (el instanceof HTMLButtonElement && el.disabled) ||
              (el instanceof HTMLInputElement && el.disabled) ||
              el.getAttribute('aria-disabled') === 'true'
            return { meta, disabled }
          })
        const sendButtons = buttons.filter((item) => /send|发送|提交|发布|继续|go|run|submit|generate|generating|生成|创作|开始/.test(item.meta))
        const sendButtonCount = sendButtons.length
        const sendButtonDisabled = sendButtons.length > 0 && sendButtons.every((item) => item.disabled)

        const bodyText = normalize(document.body?.innerText || '')
        const uploadChipVisible = /已上传|upload|preview|thumbnail|附件/.test(bodyText) && /remove|delete|移除|删除|清除/.test(bodyText)
        const submitEvidence = []
        if (/thinking|正在思考|思考中|生成中|creating|generating|uploading|上传中|处理中|responding|排队中/.test(bodyText)) {
          submitEvidence.push('page_processing_state')
        }

        return {
          promptMatched,
          promptFilled,
          promptText,
          generating: submitEvidence.length > 0,
          submitEvidence,
          sendButtonCount,
          sendButtonDisabled,
          uploadChipVisible,
        }
      })()`,
    ) as PromptSubmissionProbe | null

    return {
      promptMatched: Boolean(result?.promptMatched),
      promptFilled: Boolean(result?.promptFilled),
      promptText: String(result?.promptText || ''),
      generating: Boolean(result?.generating),
      submitEvidence: Array.isArray(result?.submitEvidence) ? result.submitEvidence : [],
      sendButtonCount: Number(result?.sendButtonCount || 0),
      sendButtonDisabled: Boolean(result?.sendButtonDisabled),
      uploadChipVisible: Boolean(result?.uploadChipVisible),
    }
  }

  private promptLooksSatisfied(expected: string, actual: string): boolean {
    const normalizedExpected = normalizeText(expected)
    const normalizedActual = normalizeText(actual)
    if (!normalizedExpected) return false
    if (!normalizedActual) return false
    if (normalizedActual === normalizedExpected) return true
    if (normalizedActual.includes(normalizedExpected) || normalizedExpected.includes(normalizedActual)) return true
    const expectedTokens = normalizedExpected.split(/[，,。.!！？?、\s]+/).filter((token) => token.length >= 2)
    if (expectedTokens.length === 0) return false
    const matched = expectedTokens.filter((token) => normalizedActual.includes(token)).length
    return matched / expectedTokens.length >= 0.7
  }

  private needsVisionFallback(action: 'upload' | 'input' | 'send', snapshot: WorkflowSnapshot): boolean {
    if (action === 'upload') {
      return !snapshot.uploadState.complete && snapshot.domState.uploadCandidateCount === 0
    }
    if (action === 'input') {
      return !snapshot.promptState.promptFilled && snapshot.domState.inputCandidateCount === 0
    }
    return !this.isRunningState(snapshot) && snapshot.domState.sendCandidateCount === 0
  }

  private async captureWorkflowSnapshot(
    stage: BrowserWorkflowStage,
    promptCandidate: string,
    attachmentName?: string,
    visionAction?: 'upload' | 'input' | 'send',
  ): Promise<WorkflowSnapshot> {
    this.ensureNotAborted()
    const cacheKey = this.buildSnapshotCacheKey(stage, promptCandidate, attachmentName, visionAction)
    const cached = this.workflowSnapshotCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= 1400) {
      return cached.snapshot
    }

    const visionCacheKey = visionAction ? this.getVisionCacheKey(visionAction) : null
    const cachedVision = visionCacheKey ? this.visionHintCache.get(visionCacheKey) : null
    const probeRaw = await this.invokeTool(
      'browser_probe_workflow_state',
      {
        prompt: promptCandidate,
        attachment_name: attachmentName,
        include_candidates: true,
        ...(visionAction && !cachedVision ? { vision_action: visionAction } : {}),
      },
      { silent: true },
    )
    const probePayload = parseJSONText(probeRaw)

    if (probePayload) {
      const screenshotPayload = probePayload.screenshot as Record<string, unknown> | undefined
      const candidatesPayload = probePayload.candidates as Record<string, unknown> | undefined
      const activeInputTarget = this.normalizeActionTargets(
        candidatesPayload?.activeInputTarget
          ? [candidatesPayload.activeInputTarget]
          : candidatesPayload?.active_input_target
            ? [candidatesPayload.active_input_target]
            : [],
      )[0] || null

      const snapshot: WorkflowSnapshot = {
        stage,
        page: {
          url: String((probePayload.page as Record<string, unknown> | undefined)?.url || ''),
          title: String((probePayload.page as Record<string, unknown> | undefined)?.title || ''),
          activeElement: String((probePayload.page as Record<string, unknown> | undefined)?.activeElement || ''),
        },
        screenshotId: typeof screenshotPayload?.image_id === 'string' ? screenshotPayload.image_id : undefined,
        uploadState: {
          complete: Boolean((probePayload.uploadState as Record<string, unknown> | undefined)?.complete),
          evidence: Array.isArray((probePayload.uploadState as Record<string, unknown> | undefined)?.evidence)
            ? ((probePayload.uploadState as Record<string, unknown>).evidence as string[])
            : [],
          inputHasFiles: Boolean((probePayload.uploadState as Record<string, unknown> | undefined)?.inputHasFiles),
          previewVisible: Boolean((probePayload.uploadState as Record<string, unknown> | undefined)?.previewVisible),
          attachmentNameMatched: Boolean((probePayload.uploadState as Record<string, unknown> | undefined)?.attachmentNameMatched),
          removeActionVisible: Boolean((probePayload.uploadState as Record<string, unknown> | undefined)?.removeActionVisible),
        },
        promptState: {
          promptMatched: Boolean((probePayload.promptState as Record<string, unknown> | undefined)?.promptMatched),
          promptFilled: Boolean((probePayload.promptState as Record<string, unknown> | undefined)?.promptFilled),
          promptText: String((probePayload.promptState as Record<string, unknown> | undefined)?.promptText || ''),
          generating: Boolean((probePayload.promptState as Record<string, unknown> | undefined)?.generating),
          submitEvidence: Array.isArray((probePayload.promptState as Record<string, unknown> | undefined)?.submitEvidence)
            ? ((probePayload.promptState as Record<string, unknown>).submitEvidence as string[])
            : [],
          sendButtonCount: Number((probePayload.promptState as Record<string, unknown> | undefined)?.sendButtonCount || 0),
          sendButtonDisabled: Boolean((probePayload.promptState as Record<string, unknown> | undefined)?.sendButtonDisabled),
          uploadChipVisible: Boolean((probePayload.promptState as Record<string, unknown> | undefined)?.uploadChipVisible),
        },
        domState: {
          inputCandidateCount: Number((probePayload.domState as Record<string, unknown> | undefined)?.inputCandidateCount || 0),
          sendCandidateCount: Number((probePayload.domState as Record<string, unknown> | undefined)?.sendCandidateCount || 0),
          uploadCandidateCount: Number((probePayload.domState as Record<string, unknown> | undefined)?.uploadCandidateCount || 0),
          modalVisible: Boolean((probePayload.domState as Record<string, unknown> | undefined)?.modalVisible),
          bodyStateText: String((probePayload.domState as Record<string, unknown> | undefined)?.bodyStateText || ''),
        },
        candidates: candidatesPayload
          ? {
              uploadTargets: this.normalizeActionTargets(candidatesPayload.uploadTargets),
              inputTargets: this.normalizeActionTargets(candidatesPayload.inputTargets),
              activeInputTarget,
              nearbySendTargets: this.normalizeActionTargets(candidatesPayload.nearbySendTargets || candidatesPayload.nearby_send_targets),
              sendTargets: this.normalizeActionTargets(candidatesPayload.sendTargets),
            }
          : undefined,
        evidenceIds: Array.isArray(probePayload.evidenceIds)
          ? (probePayload.evidenceIds as string[])
          : [],
        controllerId: typeof probePayload.controllerId === 'string' ? probePayload.controllerId : undefined,
        tabRole: typeof probePayload.tabRole === 'string' ? probePayload.tabRole : undefined,
      }

      const probeVisionTargets = visionAction
        ? this.normalizeActionTargets(probePayload.visionCandidates)
        : []
      if (visionAction && probeVisionTargets.length > 0) {
        snapshot.visionHints = {
          ...(snapshot.visionHints || {}),
          [visionAction]: probeVisionTargets,
        }
        this.visionHintCache.set(this.getVisionCacheKey(visionAction), {
          targets: probeVisionTargets,
          createdAt: Date.now(),
        })
      } else if (visionAction && cachedVision && Date.now() - cachedVision.createdAt <= 30_000) {
        snapshot.visionHints = {
          ...(snapshot.visionHints || {}),
          [visionAction]: cachedVision.targets,
        }
      }

      if (snapshot.candidates) {
        this.rememberPromptAnchor(snapshot)
      }
      const activeTab = this.controller.getActiveTab()
      if (activeTab?.id) {
        this.controller.updateTabRuntimeState(activeTab.id, { lastAuditedAt: Date.now() })
      }
      this.workflowSnapshotCache.set(cacheKey, { snapshot, createdAt: Date.now() })
      return snapshot
    }

    const [page, screenshotRaw, uploadState, promptState, domState] = await Promise.all([
      this.getPageIdentity(),
      this.invokeTool('browser_capture_viewport', { mode: 'viewport' }, { silent: true }),
      this.probeUploadState(attachmentName),
      this.probePromptSubmissionState(promptCandidate),
      this.probeDomState(),
    ])

    const screenshotPayload = parseJSONText(screenshotRaw)
    const snapshot: WorkflowSnapshot = {
      stage,
      page,
      screenshotId: typeof screenshotPayload?.image_id === 'string' ? screenshotPayload.image_id : undefined,
      uploadState,
      promptState,
      domState,
    }

    if (visionAction && this.needsVisionFallback(visionAction, snapshot)) {
      const analyzedRaw = await this.invokeTool(
        'browser_analyze_viewport',
        { action: visionAction, include_dom_candidates: true },
        { silent: true },
      )
      const analyzed = parseJSONText(analyzedRaw)
      const targets = Array.isArray((analyzed?.analysis as Record<string, unknown> | undefined)?.targets)
        ? this.parseActionTargets(JSON.stringify({ targets: (analyzed?.analysis as { targets: unknown[] }).targets }))
        : []
      snapshot.visionHints = {
        ...(snapshot.visionHints || {}),
        [visionAction]: targets,
      }
    }

    this.workflowSnapshotCache.set(cacheKey, { snapshot, createdAt: Date.now() })
    return snapshot
  }

  private isUploadComplete(snapshot: WorkflowSnapshot): boolean {
    return snapshot.uploadState.complete
  }

  private isPromptComplete(snapshot: WorkflowSnapshot, promptCandidate: string): boolean {
    return snapshot.promptState.promptMatched || this.promptLooksSatisfied(promptCandidate, snapshot.promptState.promptText)
  }

  private isRunningState(snapshot: WorkflowSnapshot): boolean {
    return snapshot.promptState.generating
  }

  private shouldNavigateToTarget(currentUrl: string, targetUrl?: string): boolean {
    if (!targetUrl) return false
    const current = normalizeComparableUrl(currentUrl)
    const target = normalizeComparableUrl(targetUrl)
    if (!current || !target) return false
    return current !== target
  }

  private async waitShort(timeoutMs = 700): Promise<void> {
    await this.invokeTool('browser_wait', { timeout_ms: timeoutMs }, { silent: true })
  }

  private async resolveTargetPageStep(plan: BrowserTaskPlanLike, snapshot: WorkflowSnapshot): Promise<StageExecutionResult> {
    const targetUrl = this.getPlannedTargetUrl(plan)
    if (!targetUrl) {
      if (snapshot.page.url) {
        this.emitStage('resolve_target_page', `计划未显式给出链接，继续使用当前页面：${snapshot.page.title || snapshot.page.url}`)
        return {
          stage: 'resolve_target_page',
          completed: true,
          skipped: true,
          evidence: ['use_current_page'],
          nextStage: 'resolve_attachment',
          recoverable: false,
          snapshot,
        }
      }
      this.emitStage('resolve_target_page', '未能形成唯一目标页，停止执行。')
      return {
        stage: 'resolve_target_page',
        completed: false,
        skipped: false,
        evidence: ['missing_target_page'],
        nextStage: 'failed',
        recoverable: false,
        snapshot,
      }
    }

    this.emitStage('resolve_target_page', `已锁定本轮目标页：${targetUrl}`)
    return {
      stage: 'resolve_target_page',
      completed: true,
      skipped: false,
      evidence: [`target_url:${targetUrl}`],
      nextStage: 'navigate_target',
      recoverable: false,
      snapshot,
    }
  }

  private async resolveAttachmentStep(plan: BrowserTaskPlanLike, snapshot: WorkflowSnapshot): Promise<StageExecutionResult> {
    const attachment = this.getPlannedAttachment(plan)
    if (!attachment) {
      this.emitStage('resolve_attachment', '当前任务缺少可用附件，无法继续上传型流程。')
      return {
        stage: 'resolve_attachment',
        completed: false,
        skipped: false,
        evidence: ['missing_attachment'],
        nextStage: 'clarify',
        recoverable: false,
        snapshot,
      }
    }

    this.emitStage('resolve_attachment', `已锁定附件：${attachment.name}`)
    return {
      stage: 'resolve_attachment',
      completed: true,
      skipped: false,
      evidence: [`attachment:${attachment.attachmentId}`, `attachment_name:${attachment.name}`],
      nextStage: 'navigate_target',
      recoverable: false,
      snapshot,
    }
  }

  private async navigateTargetStep(
    plan: BrowserTaskPlanLike,
    promptCandidate: string,
    attachmentName?: string,
    snapshot?: WorkflowSnapshot,
  ): Promise<StageExecutionResult> {
    let currentSnapshot = snapshot || await this.captureWorkflowSnapshot('navigate_target', promptCandidate, attachmentName)
    const targetUrl = this.getPlannedTargetUrl(plan)
    if (!targetUrl) {
      this.emitStage('navigate_target', '未提供目标链接，沿用当前页面。')
      return {
        stage: 'navigate_target',
        completed: true,
        skipped: true,
        evidence: ['no_target_url_use_current_page'],
        nextStage: 'ensure_upload',
        recoverable: false,
        snapshot: currentSnapshot,
      }
    }
    if (!this.shouldNavigateToTarget(currentSnapshot.page.url, targetUrl)) {
      this.emitStage('navigate_target', '当前页面已经是目标页，跳过导航。')
      return {
        stage: 'navigate_target',
        completed: true,
        skipped: true,
        evidence: ['already_on_target_page'],
        nextStage: 'ensure_upload',
        recoverable: false,
        snapshot: currentSnapshot,
      }
    }

    this.emitStage('navigate_target', `进入目标页面：${targetUrl}`)
    await this.invokeTool('browser_navigate', { url: targetUrl, allow_repeat: true }, { silent: true })
    await this.waitShort(1200)
    currentSnapshot = await this.captureWorkflowSnapshot('navigate_target', promptCandidate, attachmentName)
    if (!this.shouldNavigateToTarget(currentSnapshot.page.url, targetUrl)) {
      return {
        stage: 'navigate_target',
        completed: true,
        skipped: false,
        evidence: [`navigated:${targetUrl}`],
        nextStage: 'ensure_upload',
        recoverable: false,
        snapshot: currentSnapshot,
      }
    }

    this.emitStage('navigate_target', '导航后仍未确认到达目标页。')
    return {
      stage: 'navigate_target',
      completed: false,
      skipped: false,
      evidence: ['target_page_not_verified'],
      nextStage: 'failed',
      recoverable: true,
      snapshot: currentSnapshot,
    }
  }

  private async recoverPageState(snapshot: WorkflowSnapshot): Promise<WorkflowSnapshot> {
    const targetUrl = this.getPlannedTargetUrl(this.activePlan || this.buildDefaultPlan())
    if (targetUrl && this.shouldNavigateToTarget(snapshot.page.url, targetUrl)) {
      this.emitStage('recover', `当前页面偏离目标，直接返回目标页：${targetUrl}`)
      await this.invokeTool('browser_navigate', { url: targetUrl, allow_repeat: true }, { silent: true })
      await this.waitShort(1200)
      return this.captureWorkflowSnapshot('recover', '', this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name)
    }
    this.emitStage('recover', '尝试通过 Escape、关闭或返回恢复页面状态')
    await this.invokeTool('browser_send_keys', { key: 'Escape' }, { silent: true })
    await this.waitShort(260)

    const closeTargets = this.parseActionTargets(
      await this.invokeTool('browser_locate_action_targets', { action: 'close' }, { silent: true }),
    ).slice(0, 2)
    if (closeTargets[0]) {
      await this.invokeTool(
        'browser_click_at',
        { x: Number(closeTargets[0].x), y: Number(closeTargets[0].y) },
        { silent: true },
      )
      await this.waitShort(320)
    }

    const refreshed = await this.captureWorkflowSnapshot('recover', '', this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name)
    if (!refreshed.domState.modalVisible && refreshed.page.url === snapshot.page.url) {
      return refreshed
    }

    const backTargets = this.parseActionTargets(
      await this.invokeTool('browser_locate_action_targets', { action: 'back' }, { silent: true }),
    ).slice(0, 1)
    if (backTargets[0]) {
      await this.invokeTool(
        'browser_click_at',
        { x: Number(backTargets[0].x), y: Number(backTargets[0].y) },
        { silent: true },
      )
      await this.waitShort(400)
    } else if (snapshot.page.url && refreshed.page.url !== snapshot.page.url) {
      await this.invokeTool('browser_go_back', {}, { silent: true })
      await this.waitShort(420)
    }

    return this.captureWorkflowSnapshot('recover', '', this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name)
  }

  private async ensureUploadStage(
    promptCandidate: string,
    attachmentName?: string,
  ): Promise<StageExecutionResult> {
    const attachment = this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())
    let snapshot = await this.captureWorkflowSnapshot('ensure_upload', promptCandidate, attachmentName, 'upload')
    if (this.isUploadComplete(snapshot)) {
      this.emitStage('ensure_upload', `检测到上传证据：${snapshot.uploadState.evidence.join('、') || 'upload_state' }，跳过上传`)
      return {
        stage: 'ensure_upload',
        completed: true,
        skipped: true,
        evidence: snapshot.uploadState.evidence,
        nextStage: 'ensure_prompt',
        recoverable: false,
        snapshot,
      }
    }

    let evidence: string[] = []
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS.ensure_upload; attempt += 1) {
      this.emitStage('ensure_upload', `第 ${attempt} 次尝试上传当前会话附件`)
      const uploadArgs: Record<string, unknown> = attachment?.attachmentId && attachment.attachmentId !== 'latest'
        ? { attachment_id: attachment.attachmentId }
        : { latest: true }
      const uploadRaw = await this.invokeTool('browser_upload_scope_attachment', uploadArgs, { silent: true })
      const uploadPayload = parseJSONText(uploadRaw) || {}
      evidence = uniqueEvidence([
        ...evidence,
        String(uploadPayload.reason || ''),
        ...(Array.isArray((uploadPayload.verification as Record<string, unknown> | undefined)?.evidence)
          ? (((uploadPayload.verification as Record<string, unknown>).evidence) as string[])
          : []),
      ])
      const uploadConfirmedByTool =
        uploadPayload.ok === true &&
        (
          (uploadPayload.verification && (uploadPayload.verification as Record<string, unknown>).success === true) ||
          (uploadPayload.reason === 'attachment_already_uploaded_on_current_page')
        )
      const uploadAssignedOnly =
        uploadPayload.ok === true &&
        (((uploadPayload.setResult as Record<string, unknown> | undefined)?.filesAssigned) === true) &&
        !uploadConfirmedByTool
      if (uploadConfirmedByTool) {
        this.emitStage('ensure_upload', `上传工具已返回明确成功：${String(uploadPayload.reason || 'upload_confirmed')}`)
        snapshot = await this.captureWorkflowSnapshot('ensure_upload', promptCandidate, attachmentName, 'upload')
        if (this.isUploadComplete(snapshot)) {
          return {
            stage: 'ensure_upload',
            completed: true,
            skipped: false,
            evidence: uniqueEvidence([
              ...evidence,
              String(uploadPayload.reason || ''),
              ...snapshot.uploadState.evidence,
            ]),
            nextStage: 'ensure_prompt',
            recoverable: false,
            snapshot,
          }
        }
      }
      if (uploadAssignedOnly) {
        this.emitStage('ensure_upload', '文件已注入上传控件，等待页面出现附件缩略图或已上传证据')
      }
      if (uploadPayload.ok !== true && snapshot.visionHints?.upload?.[0]) {
        const visionTarget = snapshot.visionHints.upload[0]
        this.emitStage('ensure_upload', `DOM 入口不足，改用视觉候选：${visionTarget.label || visionTarget.kind || 'upload_target'}`)
        const secondRaw = await this.invokeTool(
          'browser_upload_scope_attachment',
          {
            ...(attachment?.attachmentId && attachment.attachmentId !== 'latest'
              ? { attachment_id: attachment.attachmentId }
              : { latest: true }),
            x: Number(visionTarget.x),
            y: Number(visionTarget.y),
          },
          { silent: true },
        )
        const secondPayload = parseJSONText(secondRaw) || {}
        evidence.push(String(secondPayload.reason || ''))
      }
      await this.waitShort(uploadAssignedOnly ? 980 : 520)
      snapshot = await this.captureWorkflowSnapshot('ensure_upload', promptCandidate, attachmentName, 'upload')
      if (this.isUploadComplete(snapshot)) {
        this.emitStage('ensure_upload', `已确认上传完成：${snapshot.uploadState.evidence.join('、') || 'upload_verified'}`)
        return {
          stage: 'ensure_upload',
          completed: true,
          skipped: false,
          evidence: uniqueEvidence([...evidence, ...snapshot.uploadState.evidence]),
          nextStage: 'ensure_prompt',
          recoverable: false,
          snapshot,
        }
      }
      const shouldRecover =
        attempt < STAGE_ATTEMPTS.ensure_upload &&
        (
          snapshot.domState.modalVisible ||
          this.shouldNavigateToTarget(snapshot.page.url, this.getPlannedTargetUrl(this.activePlan || this.buildDefaultPlan())) ||
          evidence.some((item) => /failed_to_open_upload_path|modal/i.test(String(item || '')))
        )
      if (shouldRecover) {
        snapshot = await this.recoverPageState(snapshot)
      }
    }

    this.emitStage('ensure_upload', '未能确认上传完成，结束在上传阶段')
    return {
      stage: 'ensure_upload',
      completed: false,
      skipped: false,
      evidence: uniqueEvidence([...evidence, ...snapshot.uploadState.evidence]),
      nextStage: 'failed',
      recoverable: true,
      snapshot,
    }
  }

  private async ensurePromptStage(
    promptCandidate: string,
    attachmentName?: string,
  ): Promise<StageExecutionResult> {
    let snapshot = await this.captureWorkflowSnapshot('ensure_prompt', promptCandidate, attachmentName, 'input')
    if (this.isPromptComplete(snapshot, promptCandidate)) {
      this.emitStage('ensure_prompt', '检测到提示词已经存在于输入区，跳过填写')
      return {
        stage: 'ensure_prompt',
        completed: true,
        skipped: true,
        evidence: ['prompt_already_present'],
        nextStage: 'submit',
        recoverable: false,
        snapshot,
      }
    }

    const evidence: string[] = []
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS.ensure_prompt; attempt += 1) {
      this.emitStage('ensure_prompt', `第 ${attempt} 次定位提示词输入框并填写 prompt`)
      const entry = await this.attemptPromptEntry(promptCandidate, snapshot)
      snapshot = entry.snapshot
      evidence.push(...entry.evidence)
      if (entry.completed || this.isPromptComplete(snapshot, promptCandidate)) {
        this.emitStage('ensure_prompt', '已确认提示词进入输入区')
        return {
          stage: 'ensure_prompt',
          completed: true,
          skipped: false,
          evidence: uniqueEvidence(evidence),
          nextStage: 'submit',
          recoverable: false,
          snapshot,
        }
      }
      if (attempt < STAGE_ATTEMPTS.ensure_prompt) {
        snapshot = await this.recoverPageState(snapshot)
      }
    }

    this.emitStage('ensure_prompt', '未能稳定写入提示词')
    return {
      stage: 'ensure_prompt',
      completed: false,
      skipped: false,
      evidence: uniqueEvidence(evidence),
      nextStage: 'failed',
      recoverable: true,
      snapshot,
    }
  }

  private async attemptPromptEntry(
    promptCandidate: string,
    initialSnapshot: WorkflowSnapshot,
  ): Promise<PromptEntryResult> {
    let snapshot = initialSnapshot
    const evidence: string[] = []
    const lockedAnchor = this.getLockedPromptAnchor(snapshot)
    let inputTargets = this.normalizeActionTargets([
      ...(lockedAnchor?.inputTarget ? [lockedAnchor.inputTarget] : []),
      ...(snapshot.candidates?.activeInputTarget ? [snapshot.candidates.activeInputTarget] : []),
      ...(snapshot.candidates?.inputTargets || []),
    ]).slice(0, 3)
    if (lockedAnchor?.inputTarget) {
      evidence.push('locked_prompt_anchor')
    }
    if (snapshot.candidates?.activeInputTarget) {
      evidence.push('focused_input_detected')
    }
    if (inputTargets.length === 0) {
      const inputTargetsRaw = await this.invokeTool(
        'browser_locate_input_targets',
        { target: '提示词 输入框 prompt 描述 文案 生成内容' },
        { silent: true },
      )
      const inputTargetPayload = this.parseActionTargetPayload(inputTargetsRaw)
      inputTargets = this.normalizeActionTargets([
        ...(inputTargetPayload.activeTarget ? [inputTargetPayload.activeTarget] : []),
        ...inputTargetPayload.targets,
      ]).slice(0, 3)
      if (inputTargetPayload.activeTarget) {
        evidence.push('focused_input_detected')
      }
      if (inputTargetPayload.activeTarget || inputTargetPayload.nearbySendTargets.length > 0) {
        this.promptAnchorLock = {
          pageUrl: normalizeComparableUrl(snapshot.page.url),
          inputTarget: inputTargetPayload.activeTarget || inputTargetPayload.targets[0] || null,
          nearbySendTargets: inputTargetPayload.nearbySendTargets,
          capturedAt: Date.now(),
        }
      }
    }
    if (inputTargets.length === 0) {
      inputTargets = snapshot.visionHints?.input?.slice(0, 3) || []
    }
    if (inputTargets.length === 0) {
      const analyzedRaw = await this.invokeTool(
        'browser_analyze_viewport',
        { action: 'input', include_dom_candidates: true },
        { silent: true },
      )
      inputTargets = this.parseActionTargets(analyzedRaw).slice(0, 3)
    }

    for (const target of inputTargets) {
      evidence.push(`type_at:${target.label || target.kind || 'input'}`)
      await this.invokeTool(
        'browser_type_at',
        {
          x: Number(target.x),
          y: Number(target.y),
          text: promptCandidate,
          press_enter: false,
          clear_before_typing: true,
        },
        { silent: true },
      )
      await this.waitShort(520)
      snapshot = await this.captureWorkflowSnapshot('ensure_prompt', promptCandidate, this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name, 'input')
      if (this.isPromptComplete(snapshot, promptCandidate)) {
        return { completed: true, evidence, snapshot }
      }
    }

    for (const target of [
      '提示词 输入框 prompt 描述 文案 生成内容 message chat',
      '提示词 prompt 文案 描述 输入 生成 创作',
    ]) {
      evidence.push(`compose_message:${target}`)
      await this.invokeTool(
        'browser_compose_message',
        {
          text: promptCandidate,
          target,
          clear_first: true,
          submit: false,
        },
        { silent: true },
      )
      await this.waitShort(520)
      snapshot = await this.captureWorkflowSnapshot('ensure_prompt', promptCandidate, this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name, 'input')
      if (this.isPromptComplete(snapshot, promptCandidate)) {
        return { completed: true, evidence, snapshot }
      }
    }

    return { completed: false, evidence, snapshot }
  }

  private async submitStage(
    promptCandidate: string,
    attachmentName?: string,
  ): Promise<StageExecutionResult> {
    let snapshot = await this.captureWorkflowSnapshot('submit', promptCandidate, attachmentName, 'send')
    if (this.isRunningState(snapshot)) {
      this.emitStage('submit', `页面已处于运行态：${snapshot.promptState.submitEvidence.join('、') || 'submit_state'}`)
      return {
        stage: 'submit',
        completed: true,
        skipped: true,
        evidence: snapshot.promptState.submitEvidence,
        nextStage: 'final_reconcile',
        recoverable: false,
        snapshot,
      }
    }

    const evidence: string[] = []
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS.submit; attempt += 1) {
      this.emitStage('submit', `第 ${attempt} 次尝试提交生成任务`)
      const result = await this.attemptSubmit(promptCandidate, snapshot)
      snapshot = result.snapshot
      evidence.push(...result.evidence)
      if (result.completed || this.isRunningState(snapshot)) {
        this.emitStage('submit', '已检测到提交后的页面运行证据')
        return {
          stage: 'submit',
          completed: true,
          skipped: false,
          evidence: uniqueEvidence(evidence),
          nextStage: 'final_reconcile',
          recoverable: false,
          snapshot,
        }
      }
      if (attempt < STAGE_ATTEMPTS.submit) {
        const shouldRecover =
          snapshot.domState.modalVisible ||
          this.shouldNavigateToTarget(snapshot.page.url, this.getPlannedTargetUrl(this.activePlan || this.buildDefaultPlan()))
        if (shouldRecover) {
          snapshot = await this.recoverPageState(snapshot)
        } else {
          snapshot = await this.captureWorkflowSnapshot('submit', promptCandidate, attachmentName, 'send')
        }
      }
    }

    this.emitStage('submit', '未找到稳定的发送/生成证据')
    return {
      stage: 'submit',
      completed: false,
      skipped: false,
      evidence: uniqueEvidence(evidence),
      nextStage: 'failed',
      recoverable: true,
      snapshot,
    }
  }

  private async attemptSubmit(
    promptCandidate: string,
    initialSnapshot: WorkflowSnapshot,
  ): Promise<SubmitStageResult> {
    let snapshot = initialSnapshot
    const evidence: string[] = []
    const lockedAnchor = this.getLockedPromptAnchor(snapshot)
    let anchorInput =
      lockedAnchor?.inputTarget ||
      snapshot.candidates?.activeInputTarget ||
      snapshot.candidates?.inputTargets?.[0] ||
      null
    let sendTargets = this.normalizeActionTargets([
      ...(lockedAnchor?.nearbySendTargets || []),
      ...(snapshot.candidates?.nearbySendTargets || []),
      ...(snapshot.candidates?.sendTargets || []),
    ]).slice(0, 4)

    if (lockedAnchor?.inputTarget) {
      evidence.push('locked_anchor_input')
    }
    if (!anchorInput && sendTargets.length === 0) {
      const inputTargetsRaw = await this.invokeTool(
        'browser_locate_input_targets',
        { target: '提示词 输入框 prompt 描述 文案 生成内容' },
        { silent: true },
      )
      const inputTargetPayload = this.parseActionTargetPayload(inputTargetsRaw)
      anchorInput = inputTargetPayload.activeTarget || inputTargetPayload.targets[0] || null
      sendTargets = this.normalizeActionTargets(inputTargetPayload.nearbySendTargets).slice(0, 4)
      if (anchorInput || inputTargetPayload.nearbySendTargets.length > 0) {
        this.promptAnchorLock = {
          pageUrl: normalizeComparableUrl(snapshot.page.url),
          inputTarget: anchorInput,
          nearbySendTargets: inputTargetPayload.nearbySendTargets,
          capturedAt: Date.now(),
        }
      }
    }

    if (sendTargets.length === 0) {
      const sendTargetsRaw = await this.invokeTool(
        'browser_locate_action_targets',
        { action: 'send' },
        { silent: true },
      )
      sendTargets = this.parseActionTargets(sendTargetsRaw).slice(0, 4)
    }
    if (sendTargets.length === 0) {
      sendTargets = snapshot.visionHints?.send?.slice(0, 3) || []
    }
    if (sendTargets.length === 0) {
      const analyzedRaw = await this.invokeTool(
        'browser_analyze_viewport',
        { action: 'send', include_dom_candidates: true },
        { silent: true },
      )
      sendTargets = this.parseActionTargets(analyzedRaw).slice(0, 3)
    }
    if (!anchorInput || !Number.isFinite(anchorInput.x) || !Number.isFinite(anchorInput.y)) {
      if (!snapshot.promptState.promptFilled) {
        return { completed: false, evidence: ['no_anchor'], snapshot }
      }
      evidence.push('no_anchor_prompt_already_filled')
      sendTargets = sendTargets.filter((target) => Boolean(target.nearActiveInput))
    } else {
      evidence.push((lockedAnchor?.inputTarget || snapshot.candidates?.activeInputTarget) ? 'focused_anchor_input' : 'ranked_anchor_input')
      const anchorX = Number(anchorInput.x)
      const anchorY = Number(anchorInput.y)
      const nearbyTargets = sendTargets
        .filter((target) => {
          if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return false
          if (target.nearActiveInput) return true
          const dx = Number(target.x) - anchorX
          const dy = Number(target.y) - anchorY
          const withinPromptBand = dx >= -120 && dx <= 240 && dy >= -60 && dy <= 180
          const obviousBottomRight = Number(target.x) >= 760 && Number(target.y) >= 700
          return withinPromptBand || obviousBottomRight
        })
        .sort((a, b) =>
          Number(Boolean(b.nearActiveInput)) - Number(Boolean(a.nearActiveInput)) ||
          Number(b.confidence || 0) - Number(a.confidence || 0)
        )
      if (nearbyTargets.length > 0) {
        sendTargets = nearbyTargets
      }
    }

    for (const target of sendTargets) {
      if ((target.confidence || 0) < 0.52) continue
      evidence.push(`click_send:${target.label || target.kind || 'target'}`)
      await this.invokeTool(
        'browser_click_at',
        { x: Number(target.x), y: Number(target.y) },
        { silent: true },
      )
      await this.waitShort(860)
      snapshot = await this.captureWorkflowSnapshot('submit', promptCandidate, this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name, 'send')
      if (this.isRunningState(snapshot) || (!this.isPromptComplete(snapshot, promptCandidate) && !snapshot.promptState.promptFilled)) {
        return { completed: true, evidence, snapshot }
      }
    }

    if (anchorInput || snapshot.promptState.promptFilled) {
      const keyFallbacks: Array<{ key: string; modifiers?: string[]; label: string }> = [
        { key: 'Enter', label: 'Enter' },
        { key: 'Enter', modifiers: ['Meta'], label: 'Meta+Enter' },
      ]
      for (const fallback of keyFallbacks) {
        evidence.push(`key_submit:${fallback.label}`)
        await this.invokeTool(
          'browser_send_keys',
          { key: fallback.key, modifiers: fallback.modifiers },
          { silent: true },
        )
        await this.waitShort(820)
        snapshot = await this.captureWorkflowSnapshot('submit', promptCandidate, this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())?.name, 'send')
        if (this.isRunningState(snapshot) || (!this.isPromptComplete(snapshot, promptCandidate) && !snapshot.promptState.promptFilled)) {
          return { completed: true, evidence, snapshot }
        }
      }
    }

    return { completed: false, evidence, snapshot }
  }

  private async verifyRunningStage(
    promptCandidate: string,
    attachmentName?: string,
  ): Promise<StageExecutionResult> {
    let snapshot = await this.captureWorkflowSnapshot('final_reconcile', promptCandidate, attachmentName, 'send')
    if (this.isRunningState(snapshot)) {
      this.emitStage('final_reconcile', `结果复核通过：${snapshot.promptState.submitEvidence.join('、') || 'running_state'}`)
      return {
        stage: 'final_reconcile',
        completed: true,
        skipped: false,
        evidence: snapshot.promptState.submitEvidence,
        nextStage: 'done',
        recoverable: false,
        snapshot,
      }
    }

    const evidence: string[] = uniqueEvidence([
      ...snapshot.uploadState.evidence,
      ...(this.isPromptComplete(snapshot, promptCandidate) ? ['prompt_matched'] : []),
      ...snapshot.promptState.submitEvidence,
    ])
    for (let attempt = 1; attempt <= STAGE_ATTEMPTS.final_reconcile; attempt += 1) {
      this.emitStage('final_reconcile', `复核页面是否进入运行态（第 ${attempt} 次）`)
      await this.waitShort(1100)
      snapshot = await this.captureWorkflowSnapshot('final_reconcile', promptCandidate, attachmentName, 'send')
      evidence.push(...snapshot.promptState.submitEvidence)
      if (this.isRunningState(snapshot)) {
        return {
          stage: 'final_reconcile',
          completed: true,
          skipped: false,
          evidence: uniqueEvidence(evidence),
          nextStage: 'done',
          recoverable: false,
          snapshot,
        }
      }
    }

    const missingEvidence = [
      !this.isUploadComplete(snapshot) ? '页面未确认附件挂载' : '',
      !this.isPromptComplete(snapshot, promptCandidate) ? '页面未确认提示词已写入' : '',
      !this.isRunningState(snapshot) ? '页面未确认进入运行态' : '',
    ].filter(Boolean)

    log(`[browser-v7][workflow] final_reconcile failed missing=[${missingEvidence.join(', ')}]`)

    return {
      stage: 'final_reconcile',
      completed: false,
      skipped: false,
      evidence: uniqueEvidence([...evidence, ...missingEvidence]),
      nextStage: 'failed',
      recoverable: true,
      snapshot,
    }
  }

  private shouldSkipStep(step: BrowserPlanStepLike, snapshot: WorkflowSnapshot): boolean {
    const plan = this.activePlan || this.buildDefaultPlan()
    for (const condition of step.skipIf || []) {
      if (condition === '目标页已锁定' && plan.targetUrl) return true
      if (condition === '附件已锁定' && plan.attachmentIntent.attachmentId) return true
      if (condition === '已在目标页' && plan.targetUrl && !this.shouldNavigateToTarget(snapshot.page.url, plan.targetUrl)) return true
      if (condition === '页面已有附件证据' && this.isUploadComplete(snapshot)) return true
      if (condition === '页面已有匹配 prompt' && this.isPromptComplete(snapshot, this.resolvePromptCandidate('').value)) return true
      if (condition === '页面已在运行中' && this.isRunningState(snapshot)) return true
    }
    return false
  }

  private shouldFailStep(step: BrowserPlanStepLike, snapshot: WorkflowSnapshot): boolean {
    const plan = this.activePlan || this.buildDefaultPlan()
    for (const condition of step.failIf || []) {
      if (condition === '没有可用附件' && !this.getPlannedAttachment(plan)) return true
      if (condition === '没有可用目标页' && !this.getPlannedTargetUrl(plan) && !snapshot.page.url) return true
    }
    return false
  }

  private verifyStepCompletion(step: BrowserPlanStepLike, result: StageExecutionResult): boolean {
    if (result.skipped) return true
    if (!result.completed) return false
    const snapshot = result.snapshot
    for (const condition of step.verify || []) {
      if (condition === '目标页已确认' && !this.getPlannedTargetUrl(this.activePlan || this.buildDefaultPlan())) return false
      if (condition === '附件已确认' && !this.getPlannedAttachment(this.activePlan || this.buildDefaultPlan())) return false
      if (condition === '已在目标页' && this.shouldNavigateToTarget(snapshot.page.url, this.getPlannedTargetUrl(this.activePlan || this.buildDefaultPlan()) || '')) return false
      if (condition === '页面已挂载附件' && !this.isUploadComplete(snapshot)) return false
      if (condition === 'prompt 已填写' && !this.isPromptComplete(snapshot, this.resolvePromptCandidate('').value)) return false
      if (condition === '页面已进入运行态' && !this.isRunningState(snapshot)) return false
    }
    return true
  }

  private async runUploadWorkflow(input: string): Promise<BrowserAgentRunResult> {
    const plan = this.buildDefaultPlan()
    this.activePlan = plan
    const promptResolution = this.resolvePromptCandidate(input)
    const promptCandidate = promptResolution.value
    const attachment = this.getPlannedAttachment(plan)
    const attachmentName = attachment?.name
    const targetUrl = this.getPlannedTargetUrl(plan)
    log(
      `[browser-v7][workflow] upload start session=${this.sessionId || 'none'} prompt=${promptCandidate.slice(0, 80)} source=${promptResolution.source} confidence=${promptResolution.confidence} target=${targetUrl || 'current_page'} attachment=${attachmentName || 'none'}`,
    )

    if (!attachmentName && !this.decision?.attachmentSelection?.count) {
      return {
        handled: true,
        state: 'partial',
        message: '当前上传型任务没有可用附件，请先把图片或文件发送到当前会话。',
      }
    }

    if (!promptCandidate || this.looksLikePromptWorkflowNoise(promptCandidate) || (promptResolution.confidence === 'low' && !this.isPromptCandidateConfident(promptCandidate))) {
      return {
        handled: true,
        state: 'partial',
        message: '我还没有提炼出足够明确的提示词。请直接补充要提交到网页中的核心 prompt，或把关键风格与主体要求说得更明确。',
        details: {
          promptSource: promptResolution.source,
          promptCandidate,
          plan,
        },
      }
    }

    this.state = 'planning'
    this.emitToolEvent?.('tool_result', `[计划] 目标：${plan.taskGoal || '浏览器任务执行'}\n[计划] 顺序：${(plan.steps || []).map((step) => step.id).join(' -> ')}`)
    let snapshot = await this.captureWorkflowSnapshot('resolve_target_page', promptCandidate, attachmentName)
    if (this.isRunningState(snapshot)) {
      this.rememberContinuationState('submit', snapshot, promptCandidate, attachmentName, 'done')
      return {
        handled: true,
        state: 'done',
        message: '页面已经处于生成中或处理中状态，无需重复提交。',
        details: { snapshot, plan },
      }
    }

    const stageResults: StageExecutionResult[] = []

    for (const step of plan.steps || []) {
      this.ensureNotAborted()

      // 检查 skipIf 条件
      if (this.shouldSkipStep(step, snapshot)) {
        log(`[browser-v7][workflow] skip step="${step.id}" reason="${step.skipIf?.join(', ')}"`)
        stageResults.push({
          stage: step.id,
          completed: true,
          skipped: true,
          evidence: [`步骤已跳过：${step.skipIf?.join('、')}`],
          nextStage: undefined,
          recoverable: true,
          snapshot,
        })
        continue
      }

      // 检查 failIf 条件
      if (this.shouldFailStep(step, snapshot)) {
        log(`[browser-v7][workflow] fail step="${step.id}" reason="${step.failIf?.join(', ')}"`)
        return {
          handled: true,
          state: 'failed',
          message: `任务失败：前置条件不满足 — ${step.goal}（${step.failIf?.join('、')}）`,
          details: { stage: step.id, step, stageResults, snapshot, plan },
        }
      }

      let result: StageExecutionResult
      if (step.id === 'resolve_target_page') {
        this.state = 'planning'
        result = await this.resolveTargetPageStep(plan, snapshot)
      } else if (step.id === 'resolve_attachment') {
        this.state = 'planning'
        result = await this.resolveAttachmentStep(plan, snapshot)
      } else if (step.id === 'navigate_target') {
        this.state = 'acting'
        result = await this.navigateTargetStep(plan, promptCandidate, attachmentName, snapshot)
      } else if (step.id === 'ensure_upload') {
        this.state = 'acting'
        result = await this.ensureUploadStage(promptCandidate, attachmentName)
      } else if (step.id === 'ensure_prompt') {
        this.state = 'acting'
        result = await this.ensurePromptStage(promptCandidate, attachmentName)
      } else if (step.id === 'submit') {
        this.state = 'acting'
        result = await this.submitStage(promptCandidate, attachmentName)
      } else {
        this.state = 'verifying'
        result = await this.verifyRunningStage(promptCandidate, attachmentName)
      }
      stageResults.push(result)
      snapshot = result.snapshot
      this.rememberContinuationState(
        step.id,
        snapshot,
        promptCandidate,
        attachmentName,
        result.completed ? (step.id === 'final_reconcile' ? 'done' : (this.isRunningState(snapshot) ? 'running' : 'partial')) : 'failed',
      )

      // 验证完成条件
      if (!this.verifyStepCompletion(step, result)) {
        log(`[browser-v7][workflow] verify failed step="${step.id}" verify="${step.verify?.join(', ')}"`)
        return {
          handled: true,
          state: 'failed',
          message: `任务失败：步骤未完成 — ${step.goal}（缺少：${step.verify?.join('、')}）`,
          details: { stage: step.id, step, stageResults, snapshot, plan },
        }
      }

      if (!result.completed) {
        const partial = result.stage === 'final_reconcile'
        const message = partial
          ? `任务部分完成：已完成附件和提示词阶段，但最终复核未通过。缺少证据：${result.evidence.join('、') || '页面未确认进入运行态'}`
          : `任务失败：卡在“${step.goal}”。当前缺少的证据：${result.evidence.join('、') || '未拿到足够明确的页面证据'}。建议重试或检查页面是否需要额外确认。`
        return {
          handled: true,
          state: partial ? 'partial' : 'failed',
          message,
          details: {
            stage: step.id,
            step,
            stageResults,
            snapshot,
            promptCandidate,
            promptSource: promptResolution.source,
            plan,
          },
        }
      }
    }

    this.state = 'done'

    // 生成验证报告
    const verification = {
      attachmentMounted: this.isUploadComplete(snapshot),
      promptFilled: this.isPromptComplete(snapshot, promptCandidate),
      pageRunning: this.isRunningState(snapshot),
      missingEvidence: [] as string[],
    }

    if (!verification.attachmentMounted) verification.missingEvidence.push('附件未挂载')
    if (!verification.promptFilled) verification.missingEvidence.push('prompt 未填写')
    if (!verification.pageRunning) verification.missingEvidence.push('页面未运行')

    log(`[browser-v7][workflow] done verification=${JSON.stringify(verification)}`)

    this.rememberContinuationState('final_reconcile', snapshot, promptCandidate, attachmentName, 'done')
    return {
      handled: true,
      state: 'done',
      message: '任务已完成：目标页面已挂载附件、提示词已填写，并且页面已进入生成或处理阶段。',
      details: {
        stageResults,
        snapshot,
        promptCandidate,
        promptSource: promptResolution.source,
        plan,
        verification,
      },
    }
  }

  async run(input: string): Promise<BrowserAgentRunResult> {
    const trimmed = String(input || '').trim()
    log(`[browser-v7][run] called input="${trimmed.slice(0, 100)}" decision.mode=${this.decision?.mode}`)
    if (!trimmed) {
      return { handled: false, state: 'failed', message: 'empty browser task input' }
    }

    this.ensureNotAborted()
    const decision = this.decision
    if (!decision || decision.mode === 'free_tool_loop') {
      return { handled: false, state: 'partial', message: 'no deterministic browser workflow needed' }
    }
    if (decision.mode === 'clarify_first') {
      return {
        handled: true,
        state: 'partial',
        message: '当前任务需要上传附件，但我还没有足够明确的附件目标。请补充附件名称，或直接说”用最新那张图”。',
      }
    }

    const activeTabId = this.controller.getActiveTab()?.id || null
    if (activeTabId) {
      this.controller.updateTabRuntimeState(activeTabId, {
        owner: 'agent',
        required: true,
        activity: 'running',
        lastAuditedAt: Date.now(),
      })
    }

    try {
      if (decision.mode === 'browser_upload_workflow' || decision.mode === 'browser_workflow') {
        return await this.runUploadWorkflow(trimmed)
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        this.state = 'cancelled'
        return { handled: true, state: this.state, message: '浏览器任务已取消。' }
      }
      this.state = 'failed'
      return {
        handled: true,
        state: this.state,
        message: `浏览器任务失败：${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      this.invalidateWorkflowCaches()
      if (activeTabId) {
        this.controller.updateTabRuntimeState(activeTabId, {
          owner: 'manual',
          required: false,
          activity: 'idle',
          lastAuditedAt: Date.now(),
        })
      }
    }

    return { handled: false, state: 'partial', message: 'browser runner no-op' }
  }
}
