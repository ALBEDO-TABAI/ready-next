import type { BrowserActionTarget, BrowserPageState } from '../../../shared/browser-agent-task'
import {
  buildBrowserReadonlyProbeJs,
  type BrowserReadonlyProbeNode,
  type BrowserReadonlyProbeResult,
} from '../../../shared/browser-readonly-probe'
import type { BrowserAgentRuntime } from './agent-runtime-adapter'

function asTargets(input: unknown): BrowserActionTarget[] {
  if (!Array.isArray(input)) return []
  return input.filter((item) => item && typeof item === 'object') as BrowserActionTarget[]
}

export class BrowserPageStateService {
  constructor(private readonly runtime: BrowserAgentRuntime) {}

  async getPageIdentity(): Promise<BrowserPageState['page']> {
    const result = await this.runtime.executeJS(null, `(() => { const __READY_PAGE_IDENTITY__ = true; return ({ url: String(window.location.href || ''), title: String(document.title || ''), activeElement: String(document.activeElement?.tagName || '').toLowerCase() + ':' + String(document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.getAttribute?.('placeholder') || document.activeElement?.id || '') }) })()`)
    const activeTab = this.runtime.getActiveTab()
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {}
    return {
      url: String(record.url || activeTab?.url || ''),
      title: String(record.title || activeTab?.title || ''),
      domain: activeTab?.domain || '',
      activeElement: String(record.activeElement || ''),
    }
  }

  composePageState(params: {
    page: BrowserPageState['page']
    promptCandidate: string
    attachmentName?: string
    targetUrl?: string
    upload?: Partial<BrowserPageState['upload']>
    prompt?: Partial<BrowserPageState['prompt']>
    dom?: Partial<BrowserPageState['dom']>
    candidates?: Partial<BrowserPageState['candidates']>
    evidence?: Partial<BrowserPageState['evidence']>
    risks?: Partial<BrowserPageState['risks']>
    continuity?: Partial<BrowserPageState['continuity']>
  }): BrowserPageState {
    const normalizedTarget = String(params.targetUrl || '').trim()
    const targetMatched = normalizedTarget
      ? (params.page.url
        ? (params.page.url === normalizedTarget || params.page.url.startsWith(normalizedTarget.split('?')[0] || normalizedTarget))
        : false)
      : Boolean(params.evidence?.targetMatched)
    const uploadComplete = Boolean(
      params.evidence?.uploadComplete ??
      params.upload?.complete ??
      params.upload?.previewVisible ??
      params.upload?.attachmentNameMatched ??
      params.upload?.removeActionVisible
    )
    const promptComplete = Boolean(
      params.evidence?.promptComplete ??
      params.prompt?.promptMatched ??
      params.prompt?.promptFilled
    )
    const running = Boolean(
      params.evidence?.running ??
      params.prompt?.generating ??
      params.prompt?.sendButtonDisabled
    )
    const recentEvidence = Array.from(new Set([
      ...(Array.isArray(params.upload?.evidence) ? params.upload.evidence : []),
      ...(Array.isArray(params.prompt?.submitEvidence) ? params.prompt.submitEvidence : []),
      ...(Array.isArray(params.evidence?.recentEvidence) ? params.evidence.recentEvidence : []),
    ].map((item) => String(item || '').trim()).filter(Boolean)))
    const modeSelection = Boolean(
      params.risks?.modeSelection ??
      (!params.dom?.inputCandidateCount && /(图片生成|视频生成|选择模式|ai 创作|立即开始|创作模式|开始创作)/.test(String(params.dom?.bodyStateText || '').toLowerCase()))
    )
    const modalVisible = Boolean(params.risks?.modalVisible ?? params.dom?.modalVisible)
    const offTarget = Boolean(params.risks?.offTarget ?? (normalizedTarget ? !targetMatched : false))
    const canReuseCurrentPage = Boolean(params.continuity?.canReuseCurrentPage ?? (targetMatched && !modeSelection && !modalVisible && !offTarget))
    const continuitySource = params.continuity?.source || 'none'
    return {
      page: params.page,
      promptCandidate: params.promptCandidate,
      attachmentName: params.attachmentName,
      upload: {
        complete: Boolean(params.upload?.complete),
        evidence: Array.isArray(params.upload?.evidence) ? params.upload.evidence.map((item) => String(item || '').trim()).filter(Boolean) : [],
        inputHasFiles: Boolean(params.upload?.inputHasFiles),
        previewVisible: Boolean(params.upload?.previewVisible),
        attachmentNameMatched: Boolean(params.upload?.attachmentNameMatched),
        removeActionVisible: Boolean(params.upload?.removeActionVisible),
      },
      prompt: {
        promptMatched: Boolean(params.prompt?.promptMatched),
        promptFilled: Boolean(params.prompt?.promptFilled),
        promptText: String(params.prompt?.promptText || ''),
        generating: Boolean(params.prompt?.generating),
        submitEvidence: Array.isArray(params.prompt?.submitEvidence) ? params.prompt.submitEvidence.map((item) => String(item || '').trim()).filter(Boolean) : [],
        sendButtonCount: Number(params.prompt?.sendButtonCount || 0),
        sendButtonDisabled: Boolean(params.prompt?.sendButtonDisabled),
        uploadChipVisible: Boolean(params.prompt?.uploadChipVisible),
      },
      dom: {
        inputCandidateCount: Number(params.dom?.inputCandidateCount || 0),
        sendCandidateCount: Number(params.dom?.sendCandidateCount || 0),
        uploadCandidateCount: Number(params.dom?.uploadCandidateCount || 0),
        modalVisible: Boolean(params.dom?.modalVisible),
        bodyStateText: String(params.dom?.bodyStateText || ''),
      },
      candidates: {
        uploadTargets: asTargets(params.candidates?.uploadTargets),
        inputTargets: asTargets(params.candidates?.inputTargets),
        activeInputTarget: params.candidates?.activeInputTarget || null,
        nearbySendTargets: asTargets(params.candidates?.nearbySendTargets),
        sendTargets: asTargets(params.candidates?.sendTargets),
      },
      evidence: {
        targetMatched,
        uploadComplete,
        promptComplete,
        running,
        recentEvidence,
      },
      risks: {
        modalVisible,
        modeSelection,
        offTarget,
      },
      continuity: {
        canReuseCurrentPage,
        source: continuitySource,
        lastStableStage: params.continuity?.lastStableStage || null,
        lastFailureReason: params.continuity?.lastFailureReason || null,
      },
    }
  }

  async capturePageState(params: {
    promptCandidate: string
    attachmentName?: string
    targetUrl?: string
    candidates?: Partial<BrowserPageState['candidates']>
    continuity?: Partial<BrowserPageState['continuity']>
  }): Promise<BrowserPageState> {
    const [page, formsProbe, documentProbe] = await Promise.all([
      this.getPageIdentity(),
      this.runtime.executeJS(null, buildBrowserReadonlyProbeJs({
        generation: 0,
        scope: 'forms',
        maxNodes: 60,
        includeHidden: true,
      })),
      this.runtime.executeJS(null, buildBrowserReadonlyProbeJs({
        generation: 0,
        scope: 'document',
        maxNodes: 60,
        includeHidden: true,
      })),
    ])

    const derived = derivePageStateFromReadonlyProbe({
      formsProbe: coerceReadonlyProbe(formsProbe),
      documentProbe: coerceReadonlyProbe(documentProbe),
      promptCandidate: params.promptCandidate,
      attachmentName: params.attachmentName,
    })

    return this.composePageState({
      page,
      promptCandidate: params.promptCandidate,
      attachmentName: params.attachmentName,
      targetUrl: params.targetUrl,
      upload: derived.upload,
      prompt: derived.prompt,
      dom: derived.dom,
      evidence: { recentEvidence: derived.recentEvidence },
      candidates: params.candidates,
      continuity: params.continuity,
    })
  }

  async probeEmptyPageDiagnostic(params: {
    targetUrl?: string
    itemSelector?: string
  } = {}): Promise<BrowserEmptyPageDiagnostic> {
    const state = await this.capturePageState({
      promptCandidate: '',
      targetUrl: params.targetUrl,
    })
    return diagnoseEmptyPageState(state, { itemSelector: params.itemSelector })
  }
}

export type BrowserEmptyPageReason =
  | 'login_wall'
  | 'empty_list'
  | 'selector_mismatch'
  | 'still_loading'

export interface BrowserEmptyPageDiagnostic {
  reason: BrowserEmptyPageReason
  evidence: string[]
}

const EMPTY_PAGE_REASONS = new Set<BrowserEmptyPageReason>([
  'login_wall',
  'empty_list',
  'selector_mismatch',
  'still_loading',
])

export function normalizeEmptyPageDiagnostic(input: unknown, fallback: BrowserEmptyPageReason = 'selector_mismatch'): BrowserEmptyPageDiagnostic {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const reason = EMPTY_PAGE_REASONS.has(record.reason as BrowserEmptyPageReason)
    ? record.reason as BrowserEmptyPageReason
    : fallback
  const evidence = Array.isArray(record.evidence)
    ? record.evidence.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : []
  return { reason, evidence }
}

export function diagnoseEmptyPageState(state: BrowserPageState, opts: { itemSelector?: string } = {}): BrowserEmptyPageDiagnostic {
  const bodyText = normalizeProbeText(state.dom.bodyStateText)
  const evidence = [
    ...state.evidence.recentEvidence,
    state.evidence.running || state.prompt.generating ? 'page_reports_running' : '',
    state.risks.modalVisible ? 'modal_visible' : '',
    opts.itemSelector ? `item_selector:${opts.itemSelector}` : '',
  ].filter(Boolean).slice(0, 6)

  if (
    state.evidence.running ||
    state.prompt.generating ||
    /(loading|generating|running|处理中|加载中|生成中|排队|稍候)/.test(bodyText)
  ) {
    return { reason: 'still_loading', evidence }
  }

  if (
    state.risks.modalVisible &&
    /(login|log in|sign in|signin|captcha|verify|登录|登陆|验证码|验证|请先登录)/.test(bodyText)
  ) {
    return { reason: 'login_wall', evidence }
  }

  if (/(no results|no content|nothing here|empty|暂无|没有内容|没有结果|空列表|还没有)/.test(bodyText)) {
    return { reason: 'empty_list', evidence }
  }

  return {
    reason: opts.itemSelector ? 'selector_mismatch' : 'empty_list',
    evidence,
  }
}

function coerceReadonlyProbe(input: unknown): BrowserReadonlyProbeResult | null {
  if (!input || typeof input !== 'object') return null
  const record = input as BrowserReadonlyProbeResult
  return record.ok === true && Array.isArray(record.nodes) ? record : null
}

function normalizeProbeText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function nodeText(node: BrowserReadonlyProbeNode): string {
  return [
    node.text,
    node.href,
    node.src,
    node.selectorHint,
    node.inputType,
    node.valuePreview,
    ...(Array.isArray(node.fileNames) ? node.fileNames : []),
  ].map((value) => String(value || '')).filter(Boolean).join(' ')
}

function derivePageStateFromReadonlyProbe(params: {
  formsProbe: BrowserReadonlyProbeResult | null
  documentProbe: BrowserReadonlyProbeResult | null
  promptCandidate: string
  attachmentName?: string
}): {
  upload: Partial<BrowserPageState['upload']>
  prompt: Partial<BrowserPageState['prompt']>
  dom: Partial<BrowserPageState['dom']>
  recentEvidence: string[]
} {
  const formNodes = params.formsProbe?.nodes || []
  const documentNodes = params.documentProbe?.nodes || []
  const allText = normalizeProbeText([...formNodes, ...documentNodes].map(nodeText).join(' '))
  const promptNeedle = normalizeProbeText(params.promptCandidate)
  const attachmentNeedle = normalizeProbeText(params.attachmentName)
  const inputNodes = formNodes.filter((node) => node.kind === 'input')
  const fileInputs = inputNodes.filter((node) => normalizeProbeText(node.inputType) === 'file')
  const editableInputs = inputNodes.filter((node) => {
    const type = normalizeProbeText(node.inputType || 'text')
    return !['file', 'hidden', 'button', 'submit', 'reset', 'checkbox', 'radio'].includes(type)
  })
  const sendTargets = formNodes.filter((node) => {
    const text = normalizeProbeText(nodeText(node))
    return /(send|submit|generate|发送|提交|生成|发布|运行)/.test(text)
  })
  const fileNames = fileInputs.flatMap((node) => Array.isArray(node.fileNames) ? node.fileNames : [])
  const inputHasFiles = fileNames.length > 0
  const attachmentNameMatched = Boolean(
    attachmentNeedle &&
    (fileNames.some((name) => normalizeProbeText(name).includes(attachmentNeedle)) || allText.includes(attachmentNeedle))
  )
  const promptText = editableInputs
    .map((node) => String(node.valuePreview || '').trim())
    .find((value) => value.length > 0) || ''
  const promptMatched = Boolean(promptNeedle && normalizeProbeText(promptText).includes(promptNeedle))
  const promptFilled = Boolean(promptText)
  const bodyStateText = [
    params.documentProbe?.summary || '',
    ...documentNodes.slice(0, 12).map((node) => node.text),
  ].join(' ').slice(0, 1200)
  const modalVisible = /(dialog|modal|弹窗|验证码|登录|sign in|captcha)/i.test(bodyStateText)
  const recentEvidence = [
    params.formsProbe ? 'readonly_probe_forms' : '',
    params.documentProbe ? 'readonly_probe_document' : '',
    inputHasFiles ? 'input_has_files' : '',
    attachmentNameMatched ? 'attachment_name_matched' : '',
    promptMatched ? 'prompt_matched' : promptFilled ? 'prompt_filled' : '',
  ].filter(Boolean)

  return {
    upload: {
      complete: Boolean(inputHasFiles && (attachmentNameMatched || !attachmentNeedle)),
      evidence: recentEvidence,
      inputHasFiles,
      previewVisible: Boolean(attachmentNameMatched && (params.documentProbe?.counts.media || 0) > 0),
      attachmentNameMatched,
      removeActionVisible: /(remove|delete|clear|close|删除|移除|清除)/.test(allText),
    },
    prompt: {
      promptMatched,
      promptFilled,
      promptText,
      generating: /(generating|running|排队|生成中|处理中)/.test(allText),
      submitEvidence: sendTargets.length > 0 ? ['send_target_detected'] : [],
      sendButtonCount: sendTargets.length,
      sendButtonDisabled: false,
      uploadChipVisible: attachmentNameMatched,
    },
    dom: {
      inputCandidateCount: editableInputs.length,
      sendCandidateCount: sendTargets.length,
      uploadCandidateCount: fileInputs.length,
      modalVisible,
      bodyStateText,
    },
    recentEvidence,
  }
}
