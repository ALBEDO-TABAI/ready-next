import type { BrowserAttentionReason } from '../../../shared/browser-user-attention'
import type { BrowserTaskAction } from './browser-task-work'

// What the band above the page and the task card say when the assistant needs the person (W7 §4.7). The button's
// label is Main's (attention.action.label); these are the heading and one line of what happens next.
export const BROWSER_TASK_NEED_COPY: Record<BrowserAttentionReason, { title: string; hint: string }> = {
  login: { title: '需要你来完成登录', hint: '登录好后点继续，助手会重新检查这个页面。' },
  captcha: { title: '需要你来完成验证', hint: '完成验证后点继续，助手会重新检查这个页面。' },
  takeover: { title: '你接管了这个页面', hint: '助手已停下。处理完后，可以让它从这里接着做。' },
  review_rejected: { title: '复核没有通过', hint: '结果没通过独立复核，可以让助手按原因重做。' },
}

/** The button's label while its input is on the way, or the action's own label. */
export function browserTaskButtonLabel(label: string, action: BrowserTaskAction | undefined, attentionId: string): string {
  if (!action || action.attentionId !== attentionId) return label
  if (action.phase === 'sending') return '正在交给助手…'
  if (action.phase === 'sent') return '已交给助手'
  return label
}

export const browserTaskButtonBusy = (action: BrowserTaskAction | undefined, attentionId: string) =>
  Boolean(action && action.attentionId === attentionId && action.phase !== 'refused')

/** Bytes in the units people read: 980 B, 12 KB, 3.4 MB. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** A downloaded file's name, from its path. */
export const fileNameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path

/**
 * A one-click help message (Main writes it, W7 §4.7) carries the original task's ids after its fixed sentence: the
 * assistant needs them, the person does not. The conversation shows the sentence; the stored message is unchanged.
 */
export function browserHelpDisplayText(content: string, meta: unknown): string | null {
  const ref = meta && typeof meta === 'object' ? (meta as { browserTaskRef?: unknown }).browserTaskRef : undefined
  if (!ref || typeof ref !== 'object') return null
  return content.split('\n')[0]?.trim() || null
}
