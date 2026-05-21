import { domainsLikelyMatch } from '../agent-control/session/session-continuity'
import type { BrowserPageState } from '../../../shared/browser-agent-task'

function normalizeText(value: string): string {
  return String(value || '').trim().toLowerCase()
}

export class BrowserEvidenceService {
  isTargetPageMatched(state: BrowserPageState, targetUrl?: string | null): boolean {
    const target = String(targetUrl || '').trim()
    if (!target) return false
    if (!state.page.url) return false
    return domainsLikelyMatch(state.page.url, target) || normalizeText(state.page.url) === normalizeText(target)
  }

  isUploadComplete(state: BrowserPageState): boolean {
    if (state.upload.complete) return true
    const evidence = state.upload.evidence.map((item) => normalizeText(item))
    return (
      state.upload.previewVisible ||
      state.upload.attachmentNameMatched ||
      state.upload.removeActionVisible ||
      evidence.includes('preview_visible') ||
      evidence.includes('attachment_name_matched')
    )
  }

  isPromptComplete(state: BrowserPageState, promptCandidate: string): boolean {
    const normalizedPrompt = normalizeText(promptCandidate)
    const normalizedPromptText = normalizeText(state.prompt.promptText)
    if (!normalizedPrompt) return Boolean(state.prompt.promptMatched || state.prompt.promptFilled)
    return Boolean(
      state.prompt.promptMatched ||
      state.prompt.promptFilled ||
      (normalizedPromptText && normalizedPromptText.includes(normalizedPrompt))
    )
  }

  isRunningState(state: BrowserPageState): boolean {
    const evidence = state.prompt.submitEvidence.map((item) => normalizeText(item))
    return Boolean(
      state.prompt.generating ||
      state.prompt.sendButtonDisabled ||
      evidence.includes('running_state') ||
      evidence.includes('submit_confirmed')
    )
  }

  looksLikeModeSelectionPage(state: BrowserPageState): boolean {
    const body = normalizeText(state.dom.bodyStateText)
    if (!body) return false
    if (state.dom.inputCandidateCount > 0) return false
    return /(图片生成|视频生成|选择模式|ai 创作|立即开始|创作模式|开始创作)/.test(body)
  }

  canReuseCurrentPage(state: BrowserPageState): boolean {
    return Boolean(
      state.evidence.targetMatched &&
      !state.risks.modalVisible &&
      !state.risks.modeSelection &&
      !state.risks.offTarget,
    )
  }

  getBlockingReasons(state: BrowserPageState): string[] {
    const reasons: string[] = []
    if (state.risks.modalVisible) reasons.push('页面存在遮挡或弹层')
    if (state.risks.modeSelection) reasons.push('当前仍停留在模式选择页')
    if (state.risks.offTarget) reasons.push('当前页面与目标页不一致')
    if (!state.evidence.uploadComplete) reasons.push('附件未挂载')
    if (!state.evidence.promptComplete) reasons.push('提示词未确认写入')
    if (!state.evidence.running) reasons.push('页面未进入运行态')
    if (state.continuity.lastFailureReason) reasons.push(`上次失败原因：${state.continuity.lastFailureReason}`)
    return reasons
  }
}
