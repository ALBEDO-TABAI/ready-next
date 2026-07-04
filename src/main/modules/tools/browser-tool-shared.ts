/**
 * P3 Phase B4（2026-07-04，纯移动拆分）— browser-tools 共享叶子 helper。
 *
 * 从 browser-tools.ts 逐字搬出被 Power 工具组与非 Power case 同时引用的
 * 工具函数：truncate / activeBrowserToolUrl(Title) / 交易确认页面态判定链。
 * browser-tools 会 import browser-power-tools，本模块作为两侧共同的下游，
 * 绝不 import 上述两个模块，防循环依赖。行为零变更。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import {
  createBrowserTransactionConfirmation,
  type BrowserTransactionConfirmation,
} from '../browser-engine/browser-action-session'

const MAX_RESULT_LENGTH = 20_000

export function truncate(s: string, max = MAX_RESULT_LENGTH): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... (truncated, ${s.length} total chars)`
}

export function activeBrowserToolUrl(controller: BrowserController, tabId: string | null): string | null {
  const tabs = controller.getTabList?.() || []
  const tab = (tabId ? tabs.find((item) => item.id === tabId) : null)
    || tabs.find((item) => item.active)
    || controller.getActiveTab?.()
    || null
  return typeof tab?.url === 'string' ? tab.url : null
}

function activeBrowserToolTitle(controller: BrowserController, tabId: string | null): string | null {
  const tabs = controller.getTabList?.() || []
  const tab = (tabId ? tabs.find((item) => item.id === tabId) : null)
    || tabs.find((item) => item.active)
    || controller.getActiveTab?.()
    || null
  return typeof tab?.title === 'string' ? tab.title : null
}

function browserTransactionResourceIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const candidates = parsed.pathname.split('/').filter(Boolean).reverse()
    return candidates.find((segment) => /^[A-Za-z0-9_-]{8,}$/.test(segment)) || null
  } catch {
    // silent-catch: URL 解析失败即无交易资源 id。
    return null
  }
}

function looksLikeEditorUrl(url: string | null | undefined): boolean {
  const value = String(url || '')
  return /(?:draft|edit|editor|compose|create|publish|upload|creator|post\/edit|note\/edit)/i.test(value)
}

export function normalizeTransactionText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function detectTransactionConfirmationFromPageState(pageState: {
  url?: string | null
  title?: string | null
  text?: string | null
}): BrowserTransactionConfirmation | null {
  const text = normalizeTransactionText([pageState.title, pageState.text].filter(Boolean).join(' '))
  const successText = text.match(/(?:发布成功|提交成功|发送成功|已发布|发布完成|提交完成|posted|published|success(?:fully)?)/i)?.[0] || null
  if (successText && !/(?:草稿|draft|自动保存|autosave|保存成功)/i.test(text)) {
    return createBrowserTransactionConfirmation({
      source: 'page_text',
      signal: successText,
      url: pageState.url || null,
      text,
    })
  }
  const url = String(pageState.url || '')
  const resourceId = browserTransactionResourceIdFromUrl(url)
  if (url && resourceId && !looksLikeEditorUrl(url)) {
    return createBrowserTransactionConfirmation({
      source: 'public_url',
      signal: 'public_resource_url',
      url,
      resourceId,
    })
  }
  return null
}

export async function detectBrowserPageTransactionConfirmation(
  controller: BrowserController,
  tabId: string | null,
): Promise<BrowserTransactionConfirmation | null> {
  const url = activeBrowserToolUrl(controller, tabId)
  const title = activeBrowserToolTitle(controller, tabId)
  try {
    const page = await controller.executeJS(tabId, `
      (() => ({
        url: String(location.href || ''),
        title: String(document.title || ''),
        text: String(document.body?.innerText || '').slice(0, 4000)
      }))()
    `) as { url?: string; title?: string; text?: string } | null
    return detectTransactionConfirmationFromPageState({
      url: page?.url || url,
      title: page?.title || title,
      text: page?.text || '',
    })
  } catch {
    // silent-catch: 网络侧探测失败回退到页面状态判定。
    return detectTransactionConfirmationFromPageState({ url, title, text: '' })
  }
}
