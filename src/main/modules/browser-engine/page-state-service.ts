import type { BrowserActionTarget, BrowserPageState } from '../../../shared/browser-agent-task'
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
    upload?: Partial<BrowserPageState['upload']>
    prompt?: Partial<BrowserPageState['prompt']>
    dom?: Partial<BrowserPageState['dom']>
    candidates?: Partial<BrowserPageState['candidates']>
  }): BrowserPageState {
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
    }
  }

  async capturePageState(params: {
    promptCandidate: string
    attachmentName?: string
    candidates?: Partial<BrowserPageState['candidates']>
  }): Promise<BrowserPageState> {
    const [page, upload, prompt, dom] = await Promise.all([
      this.getPageIdentity(),
      this.runtime.executeJS(null, `(() => { const __READY_UPLOAD_STATE__ = true; return null })()`),
      this.runtime.executeJS(null, `(() => { const __READY_PROMPT_STATE__ = true; return null })()`),
      this.runtime.executeJS(null, `(() => { const __READY_DOM_STATE__ = true; return null })()`),
    ])

    const uploadRecord = upload && typeof upload === 'object' ? upload as Record<string, unknown> : {}
    const promptRecord = prompt && typeof prompt === 'object' ? prompt as Record<string, unknown> : {}
    const domRecord = dom && typeof dom === 'object' ? dom as Record<string, unknown> : {}

    return this.composePageState({
      page,
      promptCandidate: params.promptCandidate,
      attachmentName: params.attachmentName,
      upload: uploadRecord,
      prompt: promptRecord,
      dom: domRecord,
      candidates: params.candidates,
    })
  }
}
