import type { DocActionFailureReason, DocActionMutationOutcome, DocActionPayload } from './types'
import { hashContent, normalizeContentForCompare } from './text-utils'
import { buildWidgetBoundaryRejection, buildWidgetBoundaryRejectionForRanges } from './visual-validation'

export function describeWidgetSkip(existing: string, incoming: string): {
  reason: 'byte_identical' | 'normalized_identical' | 'mismatch'
  summary: string
  detail: {
    existingLen: number
    incomingLen: number
    existingHash: string
    incomingHash: string
    normalizedExistingHash: string
    normalizedIncomingHash: string
    firstDiffOffset: number | null
  }
} {
  const normalizedExisting = normalizeContentForCompare(existing)
  const normalizedIncoming = normalizeContentForCompare(incoming)
  let firstDiffOffset: number | null = null
  const minLen = Math.min(existing.length, incoming.length)
  for (let i = 0; i < minLen; i++) {
    if (existing.charCodeAt(i) !== incoming.charCodeAt(i)) { firstDiffOffset = i; break }
  }
  if (firstDiffOffset === null && existing.length !== incoming.length) firstDiffOffset = minLen
  const detail = {
    existingLen: existing.length,
    incomingLen: incoming.length,
    existingHash: hashContent(existing),
    incomingHash: hashContent(incoming),
    normalizedExistingHash: hashContent(normalizedExisting),
    normalizedIncomingHash: hashContent(normalizedIncoming),
    firstDiffOffset,
  }
  if (existing === incoming) {
    return { reason: 'byte_identical', summary: `完全一致 hash=${detail.existingHash} len=${detail.existingLen}`, detail }
  }
  if (normalizedExisting === normalizedIncoming) {
    return {
      reason: 'normalized_identical',
      summary: `规范化后一致 len=${detail.existingLen}/${detail.incomingLen} diff@${detail.firstDiffOffset}`,
      detail,
    }
  }
  return {
    reason: 'mismatch',
    summary: `存在实际差异 len=${detail.existingLen}/${detail.incomingLen} diff@${detail.firstDiffOffset}`,
    detail,
  }
}

export function logWidgetSkip(scope: string, tabTitle: string, info: ReturnType<typeof describeWidgetSkip>): void {
  try {
    console.info(`[widget-skip:${scope}]`, { tab: tabTitle, reason: info.reason, ...info.detail })
  } catch {
    // Best-effort diagnostics must never block widget updates.
  }
}


export { buildWidgetBoundaryRejection, buildWidgetBoundaryRejectionForRanges }

export function classifyDocActionMutationOutcome(
  action: DocActionPayload,
  summary: string,
): DocActionMutationOutcome {
  const type = String(action.type || '').trim()
  const normalized = summary.trim()

  if (type === 'save_tab') {
    if (/保存失败|不支持保存|另存为已取消|当前环境不支持/.test(normalized)) {
      return { mutated: false, mutationReason: 'validation_failed' }
    }
    return {
      mutated: false,
      mutationReason: 'saved',
      documentSaved: /已保存文档|已另存文档/.test(normalized),
    }
  }

  const mutationActions = new Set([
    'set_content',
    'append_content',
    'insert_widget',
    'update_widget',
    'remove_widget',
    'replace_text',
    'replace_exact',
    'format_section',
    'rewrite_section',
  ])
  if (!mutationActions.has(type)) {
    return { mutated: false, mutationReason: 'not_mutation' }
  }
  if (/不能用普通文本替换工具修改 show-widget/.test(normalized)) {
    return {
      mutated: false,
      mutationReason: 'rejected',
      errorKind: 'widget_boundary_violation',
      recoverable: true,
    }
  }
  if (/Mermaid|show-widget JSON|show-widget SVG|视觉|源码裸露/.test(normalized) && /已拒绝|不能进入完成态|无法解析|没有闭合/.test(normalized)) {
    return {
      mutated: false,
      mutationReason: 'validation_failed',
      errorKind: 'document_visual_syntax_invalid',
      recoverable: true,
    }
  }
  if (/已取消|被取消/.test(normalized)) return { mutated: false, mutationReason: 'cancelled' }
  if (/未匹配到|未找到|没有可|缺少/.test(normalized)) return { mutated: false, mutationReason: 'no_match' }
  if (/内容未变化|无变化|未做改动|已跳过|已是目标格式/.test(normalized)) {
    return { mutated: false, mutationReason: 'identical' }
  }
  if (/已写入|已追加|已插入|已在[^，。]*插入|已更新|已删除|已替换|已精准替换|已优化章节格式|已重写/.test(normalized)) {
    return { mutated: true, mutationReason: 'changed' }
  }
  if (/已拒绝|失败|无法/.test(normalized)) return { mutated: false, mutationReason: 'rejected' }
  return { mutated: false, mutationReason: 'validation_failed' }
}


const DOC_ACTION_TARGET_NOT_RESOLVED_PATTERNS: ReadonlyArray<RegExp> = [
  /未找到与你选择的卡片对应的 widget/,
  /未找到可更新的 widget，请用标题或序号重试/,
  /当前文档里还没有 widget，请先插入一个再发起修改/,
  /未找到序号为\s*\d+\s*的 widget/,
  /未找到标题匹配.+?的 widget/,
]

export function classifyDocActionFailureReason(
  action: DocActionPayload,
  summary: string,
): DocActionFailureReason | null {
  if (!summary) return null
  const type = String(action.type || '').trim()
  if (type !== 'update_widget') return null
  return DOC_ACTION_TARGET_NOT_RESOLVED_PATTERNS.some((re) => re.test(summary))
    ? 'target_not_resolved'
    : null
}
