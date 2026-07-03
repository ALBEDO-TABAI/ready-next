/**
 * P3 Phase B3（2026-07-04，纯移动拆分）— browser-tools Gemini 交互簇。
 *
 * 从 browser-tools.ts 两段逐字搬出（1545-2153 探测/提交机器 + 2808-3073
 * runGeminiQuery 主流程与聊天页判定）：响应/可编辑区/提交态探测、发送按钮
 * 点击与表单提交兜底、ensureGeminiSubmitted 提交保障、查询全流程。
 * 行为零变更；上层 browser_query_gemini / compose 路径经 browser-tools 回接。
 */
import type { BrowserController } from '../browser-engine/ipc-handler'
import {
  BROWSER_V2_STOP_LOADING_TIMEOUT_MS,
  buildSmartTypeJs,
  clearFocusedInput,
  dispatchClickAt,
  isBrowserAbortError,
  normalizeErrorCode,
  sendKeyStroke,
  sleepWithAbort,
  throwIfAborted,
  waitForLoadingStop,
  waitForReady,
} from './browser-input-actions'
import { createRotatingLogger } from '../../utils/rotating-logger'

const logger = createRotatingLogger('ready-tools.log')
function log(msg: string) {
  try { logger.append(`[${new Date().toISOString()}] ${msg}\n`) } catch { /* silent-catch: 日志写入失败不影响主流程。 */ }
}

const BROWSER_V2_WAIT_AFTER_NAV_MS = 250

interface GeminiResponseProbe {
  responseDetected: boolean
  responseText: string
  loginRequired: boolean
  captchaRequired: boolean
  editableCount: number
  thinking: boolean
}

async function probeGeminiResponse(
  controller: BrowserController,
  tabId: string | null,
  userText: string,
): Promise<GeminiResponseProbe> {
  const userSnippet = userText.trim().replace(/\s+/g, ' ').slice(0, 24)
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const text = (document.body?.innerText || '')
        const loginRequired = /登录|登入|Sign in|Log in|Choose an account/i.test(text)
        const captchaRequired = /captcha|验证|人机|I am not a robot/i.test(text)
        const selectors = [
          '[data-message-author-role="model"]',
          '[data-test-id*="model"]',
          '.model-response',
          'message-content',
        ]
        let responseText = ''
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const clean = (s) =>
          normalize(s)
            .replace(/^Gemini\\s*PRO?/i, '')
            .replace(/Gemini 是一款 AI 工具，其回答未必正确无误。?/g, '')
            .replace(/Pro\\s*$/g, '')
            .trim()
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector))
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            const t = clean(nodes[i].textContent || '')
            if (t.length > 20) {
              responseText = t.slice(0, 500)
              break
            }
          }
          if (responseText) break
        }
        const userSnippet = ${JSON.stringify(userSnippet)}
        if (!responseText) {
          const lines = text
            .split('\\n')
            .map((line) => clean(line))
            .filter((line) => line.length > 14)
            .filter((line) => !/需要我为你做些什么|制作图片|创作音乐|创作视频|给我的一天注入活力|帮我学习|随便写点什么/.test(line))
            .filter((line) => !userSnippet || !line.includes(userSnippet))
          const maybe = lines.slice(-8).join('\\n').trim()
          responseText = maybe.slice(0, 500)
        }
        const editableCount = document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]').length
        const thinking = /thinking|正在思考|思考中|生成中|generating|回答中|撰写中|loading/i.test(text)
        const cleanedResponse = clean(responseText)
        const userEcho = userSnippet && cleanedResponse.includes(userSnippet)
        const weakResponse = cleanedResponse.length < 40
        return {
          responseDetected: Boolean(cleanedResponse && !weakResponse && !thinking && !userEcho),
          responseText: cleanedResponse,
          loginRequired,
          captchaRequired,
          editableCount,
          thinking,
        }
      })()
    `,
  ) as GeminiResponseProbe

  return {
    responseDetected: Boolean(result?.responseDetected),
    responseText: String(result?.responseText || ''),
    loginRequired: Boolean(result?.loginRequired),
    captchaRequired: Boolean(result?.captchaRequired),
    editableCount: Number(result?.editableCount || 0),
    thinking: Boolean(result?.thinking),
  }
}

interface GeminiEditableCandidate {
  x: number
  y: number
  score: number
  reason: string
}

async function probeGeminiEditableCandidates(
  controller: BrowserController,
  tabId: string | null,
): Promise<GeminiEditableCandidate[]> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const isVisible = (el) => {
          const rect = el.getBoundingClientRect()
          if (!rect || rect.width < 12 || rect.height < 12) return false
          const style = getComputedStyle(el)
          if (!style) return false
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0
        }
        const nodes = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[role="textbox"],[role="combobox"]'))
        const out = []
        for (const el of nodes) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue
          const rect = el.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          let score = 10
          const meta = [
            el.getAttribute('placeholder') || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('name') || '',
            el.getAttribute('id') || '',
            el.getAttribute('data-testid') || '',
            el.getAttribute('role') || '',
          ].join(' ').toLowerCase()
          if (/gemini|chat|message|prompt|ask|输入|提问/.test(meta)) score += 80
          if (rect.width > window.innerWidth * 0.35) score += 18
          if (rect.bottom > window.innerHeight * 0.6) score += 14
          if (el.tagName.toLowerCase() === 'textarea') score += 20
          out.push({
            x: Math.max(0, Math.min(999, Math.round((centerX / Math.max(1, window.innerWidth)) * 999))),
            y: Math.max(0, Math.min(999, Math.round((centerY / Math.max(1, window.innerHeight)) * 999))),
            score,
            reason: meta.slice(0, 120) || el.tagName.toLowerCase(),
          })
        }
        return out.sort((a, b) => b.score - a.score).slice(0, 6)
      })()
    `,
  ) as GeminiEditableCandidate[]

  if (!Array.isArray(result)) return []
  return result
}

interface GeminiSubmissionProbe {
  inputHasText: boolean
  inputLength: number
  sendButtonEnabled: boolean
  userEchoDetected: boolean
  thinking: boolean
}

async function probeGeminiSubmissionState(
  controller: BrowserController,
  tabId: string | null,
  text: string,
): Promise<GeminiSubmissionProbe> {
  const previewToken = text.trim().replace(/\s+/g, ' ').slice(0, 22)
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const getEditableText = (el) => {
          if (!el) return ''
          const tag = String(el.tagName || '').toLowerCase()
          if (tag === 'textarea' || tag === 'input') return String(el.value || '')
          return String(el.innerText || el.textContent || '')
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]'))
        let best = ''
        const active = document.activeElement
        if (active instanceof HTMLElement) {
          const activeRect = active.getBoundingClientRect()
          const activeStyle = window.getComputedStyle(active)
          const activeVisible =
            activeRect.width >= 20 &&
            activeRect.height >= 20 &&
            activeStyle &&
            activeStyle.display !== 'none' &&
            activeStyle.visibility !== 'hidden' &&
            Number(activeStyle.opacity || '1') > 0
          const activeTag = String(active.tagName || '').toLowerCase()
          const activeRole = (active.getAttribute('role') || '').toLowerCase()
          const activeEditable =
            activeVisible &&
            (activeTag === 'textarea' ||
              activeTag === 'input' ||
              active.isContentEditable ||
              activeRole === 'textbox' ||
              activeRole === 'combobox' ||
              activeRole === 'searchbox')
          if (activeEditable) {
            best = getEditableText(active)
          }
        }
        for (const el of editables) {
          if (!(el instanceof HTMLElement)) continue
          const rect = el.getBoundingClientRect()
          if (rect.width < 20 || rect.height < 20) continue
          const style = window.getComputedStyle(el)
          if (!style || style.display === 'none' || style.visibility === 'hidden') continue
          const value = getEditableText(el)
          if (value.length > best.length) best = value
        }
        const sendSelectors = [
          'button[aria-label*="send" i]',
          'button[aria-label*="发送" i]',
          'button[aria-label*="提交" i]',
          'button[aria-label*="发布" i]',
          'button[aria-label*="继续" i]',
          'button[aria-label*="search" i]',
          'button[aria-label*="回车" i]',
          'button[aria-label*="ask" i]',
          'button[aria-label*="发送消息" i]',
          'button[data-testid*="send" i]',
          'button[data-testid*="submit" i]',
          'button[data-testid*="publish" i]',
          'button[data-testid*="continue" i]',
          '[role="button"][aria-label*="send" i]',
          '[role="button"][aria-label*="发送" i]',
          'button[title*="send" i]',
          'button[title*="发送" i]',
          'button[title*="提交" i]',
          'button[title*="发布" i]',
          'button[title*="继续" i]',
          'button[mattooltip*="send" i]',
        ]
        const sendButtons = sendSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        const sendButtonEnabled = sendButtons.some((node) => {
          if (!(node instanceof HTMLElement)) return false
          const ariaDisabled = (node.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
          const disabled =
            (node instanceof HTMLButtonElement && node.disabled === true) ||
            node.hasAttribute('disabled')
          const style = window.getComputedStyle(node)
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0
          return visible && !ariaDisabled && !disabled
        })
        const userSelectors = [
          '[data-message-author-role="user"]',
          '[data-author-role="user"]',
          '[data-role="user"]',
          '.message-user',
          '.user-message',
          '[class*="userMessage"]',
          '[class*="chat-user"]',
          '.user-query',
        ]
        const userNodes = userSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
        const userEchoDetected = userNodes.some((node) => normalize(node.textContent || '').includes(${JSON.stringify(previewToken)}))
        const inputHasText = normalize(best).length > 0
        const bodyText = normalize(document.body?.innerText || '')
        const thinking = /thinking|正在思考|思考中|生成中|回答中|撰写中|responding|loading|写作中|处理中/.test(bodyText)
        return {
          inputHasText,
          inputLength: normalize(best).length,
          sendButtonEnabled,
          userEchoDetected,
          thinking,
        }
      })()
    `,
  ) as GeminiSubmissionProbe

  return {
    inputHasText: Boolean(result?.inputHasText),
    inputLength: Number(result?.inputLength || 0),
    sendButtonEnabled: Boolean(result?.sendButtonEnabled),
    userEchoDetected: Boolean(result?.userEchoDetected),
    thinking: Boolean(result?.thinking),
  }
}

function isSubmissionLikelyAccepted(probe: GeminiSubmissionProbe): boolean {
  if (probe.userEchoDetected) return true
  if (probe.thinking) return true
  if (!probe.inputHasText && !probe.sendButtonEnabled) return true
  if (probe.inputLength <= 2 && !probe.sendButtonEnabled) return true
  return false
}

async function clickGeminiSendButton(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ clicked: boolean; reason: string }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const selectors = [
          'button[aria-label*="send" i]',
          'button[aria-label*="发送" i]',
          'button[aria-label*="提交" i]',
          'button[aria-label*="发布" i]',
          'button[aria-label*="继续" i]',
          'button[aria-label*="search" i]',
          'button[data-testid*="send" i]',
          'button[data-testid*="submit" i]',
          'button[data-testid*="publish" i]',
          'button[data-testid*="continue" i]',
          '[role="button"][aria-label*="send" i]',
          '[role="button"][aria-label*="发送" i]',
          '[role="button"][aria-label*="提交" i]',
          '[role="button"][aria-label*="发布" i]',
          '[role="button"][aria-label*="继续" i]',
          'button[mattooltip*="send" i]',
          'button[title*="send" i]',
          'button[title*="发送" i]',
          'button[title*="提交" i]',
          'button[title*="发布" i]',
          'button[title*="继续" i]',
          'input[type="submit"]',
          'button',
          '[role="button"]',
          '[tabindex]',
        ]
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const getActiveEditable = () => {
          const nodes = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
          const active = document.activeElement
          if (active instanceof HTMLElement && visible(active)) {
            return active
          }
          let best = null
          let bestScore = -1
          for (const node of nodes) {
            if (!(node instanceof HTMLElement) || !visible(node)) continue
            const rect = node.getBoundingClientRect()
            let score = 0
            if (rect.bottom > window.innerHeight * 0.55) score += 8
            if (rect.width > window.innerWidth * 0.3) score += 6
            if (node.tagName.toLowerCase() === 'textarea') score += 4
            if (score > bestScore) {
              best = node
              bestScore = score
            }
          }
          return best
        }
        const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
          .filter((el) => visible(el))
          .filter((el) => {
            const element = el
            const ariaDisabled = (element.getAttribute('aria-disabled') || '').toLowerCase() === 'true'
            const disabled = element instanceof HTMLButtonElement && element.disabled
            return !ariaDisabled && !disabled
          })
        if (candidates.length === 0) {
          return { clicked: false, reason: 'send_button_not_found' }
        }
        const activeEditable = getActiveEditable()
        const activeRect = activeEditable instanceof HTMLElement ? activeEditable.getBoundingClientRect() : null
        const activeParent = activeEditable instanceof HTMLElement ? activeEditable.parentElement : null
        const activeGrandParent = activeParent?.parentElement || null
        let best = candidates[0]
        let bestScore = -1
        for (const el of candidates) {
          const rect = el.getBoundingClientRect()
          let score = 0
          if (rect.bottom > window.innerHeight * 0.5) score += 4
          if (rect.right > window.innerWidth * 0.5) score += 4
          if (rect.width <= 64 && rect.height <= 64) score += 3
          const meta = (
            (el.getAttribute('aria-label') || '') + ' ' +
            (el.getAttribute('title') || '') + ' ' +
            (el.getAttribute('data-testid') || '') + ' ' +
            (el.getAttribute('class') || '') + ' ' +
            (el.textContent || '')
          ).toLowerCase()
          if (/send|发送|提交|发布|继续|search|搜索|ask|生成|go/.test(meta)) score += 10
          if (/icon|arrow|submit/.test(meta)) score += 2
          if (activeRect) {
            const dx = Math.abs(rect.left - activeRect.right)
            const dy = Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2))
            if (dx <= 180) score += 8
            if (dy <= 120) score += 6
            if (rect.left >= activeRect.left && rect.top >= activeRect.top - 60) score += 5
            if (rect.bottom >= activeRect.top && rect.top <= activeRect.bottom + 120) score += 4
          }
          if (activeParent && activeParent.contains(el) && el !== activeEditable) score += 7
          if (activeGrandParent && activeGrandParent.contains(el) && el !== activeEditable) score += 3
          if (score > bestScore) {
            best = el
            bestScore = score
          }
        }
        best.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        best.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
        if (typeof best.click === 'function') {
          best.click()
        } else {
          best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          best.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        return { clicked: true, reason: 'send_button_clicked' }
      })()
    `,
  ) as { clicked?: boolean; reason?: string }

  return {
    clicked: Boolean(result?.clicked),
    reason: String(result?.reason || 'unknown'),
  }
}

async function submitClosestFormOrContainer(
  controller: BrowserController,
  tabId: string | null,
): Promise<{ submitted: boolean; reason: string }> {
  const result = await controller.executeJS(
    tabId,
    `
      (() => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          if (rect.width < 8 || rect.height < 8) return false
          const style = getComputedStyle(el)
          if (!style) return false
          if (style.display === 'none' || style.visibility === 'hidden') return false
          if (Number(style.opacity || '1') <= 0) return false
          return true
        }
        const editables = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"],[role="searchbox"]'))
        let active = document.activeElement instanceof HTMLElement && visible(document.activeElement)
          ? document.activeElement
          : null
        if (!active) {
          let best = null
          let bestScore = -1
          for (const node of editables) {
            if (!(node instanceof HTMLElement) || !visible(node)) continue
            const rect = node.getBoundingClientRect()
            let score = 0
            if (rect.bottom > window.innerHeight * 0.55) score += 8
            if (rect.width > window.innerWidth * 0.25) score += 5
            if (node.tagName.toLowerCase() === 'textarea') score += 4
            if (score > bestScore) {
              best = node
              bestScore = score
            }
          }
          active = best
        }
        if (!(active instanceof HTMLElement)) {
          return { submitted: false, reason: 'no_active_editable' }
        }
        const form = active.closest('form')
        if (form instanceof HTMLFormElement) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit()
          } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          }
          return { submitted: true, reason: 'closest_form_submit' }
        }
        const containers = [
          active.parentElement,
          active.parentElement?.parentElement,
          active.closest('[role="group"]'),
          active.closest('[role="dialog"]'),
          active.closest('section'),
        ].filter(Boolean)
        const activeRect = active.getBoundingClientRect()
        for (const container of containers) {
          if (!(container instanceof HTMLElement)) continue
          const buttons = Array.from(container.querySelectorAll('button,[role="button"],input[type="submit"]'))
            .filter((node) => visible(node) && node !== active)
          let best = null
          let bestScore = -1
          for (const button of buttons) {
            if (!(button instanceof HTMLElement)) continue
            const rect = button.getBoundingClientRect()
            let score = 0
            const meta = (
              (button.getAttribute('aria-label') || '') + ' ' +
              (button.getAttribute('title') || '') + ' ' +
              (button.getAttribute('data-testid') || '') + ' ' +
              (button.getAttribute('class') || '') + ' ' +
              (button.textContent || '')
            ).toLowerCase()
            if (/send|发送|提交|发布|继续|search|搜索|ask|生成|go/.test(meta)) score += 10
            if (Math.abs((rect.top + rect.height / 2) - (activeRect.top + activeRect.height / 2)) <= 120) score += 5
            if (rect.left >= activeRect.left - 32) score += 4
            if (rect.right >= activeRect.right - 24) score += 3
            if (score > bestScore) {
              best = button
              bestScore = score
            }
          }
          if (best instanceof HTMLElement) {
            if (typeof best.click === 'function') {
              best.click()
            } else {
              best.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              best.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              best.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return { submitted: true, reason: 'closest_container_button' }
          }
        }
        return { submitted: false, reason: 'no_form_or_container_submit' }
      })()
    `,
  ) as { submitted?: boolean; reason?: string }

  return {
    submitted: Boolean(result?.submitted),
    reason: String(result?.reason || 'unknown'),
  }
}

export async function ensureGeminiSubmitted(
  controller: BrowserController,
  tabId: string | null,
  text: string,
  attempted: string[],
  signal?: AbortSignal,
): Promise<{ submitted: boolean; method: string; probe: GeminiSubmissionProbe }> {
  throwIfAborted(signal)
  let probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'already_submitted', probe }
  }

  attempted.push('submit-precheck-wait')
  await sleepWithAbort(320, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'already_submitted_pending', probe }
  }

  attempted.push('submit-enter')
  await sendKeyStroke(controller, tabId, 'Enter')
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'enter', probe }
  }

  attempted.push('submit-meta-enter')
  await sendKeyStroke(controller, tabId, 'Enter', ['meta'])
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'meta_enter', probe }
  }

  attempted.push('submit-ctrl-enter')
  await sendKeyStroke(controller, tabId, 'Enter', ['ctrl'])
  await sleepWithAbort(160, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'ctrl_enter', probe }
  }

  attempted.push('submit-closest-form')
  const formSubmitted = await submitClosestFormOrContainer(controller, tabId)
  if (formSubmitted.submitted) {
    await sleepWithAbort(180, signal)
    probe = await probeGeminiSubmissionState(controller, tabId, text)
    if (isSubmissionLikelyAccepted(probe)) {
      return { submitted: true, method: formSubmitted.reason, probe }
    }
  }

  attempted.push('submit-send-button')
  const clicked = await clickGeminiSendButton(controller, tabId)
  await sleepWithAbort(220, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (clicked.clicked && isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: clicked.reason, probe }
  }

  attempted.push('submit-bottom-right-click')
  try {
    await dispatchClickAt(controller, tabId, 945, 930)
    await sleepWithAbort(140, signal)
    await sendKeyStroke(controller, tabId, 'Enter')
  } catch {
    // silent-catch: 兜底点击/回车失败不终止提交流程，继续探测提交态。
  }
  await sleepWithAbort(240, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'bottom_right_click_enter', probe }
  }

  attempted.push('submit-send-key-fallback')
  await sendKeyStroke(controller, tabId, 'Enter')
  await sleepWithAbort(180, signal)
  probe = await probeGeminiSubmissionState(controller, tabId, text)
  if (isSubmissionLikelyAccepted(probe)) {
    return { submitted: true, method: 'send_key_fallback_enter', probe }
  }

  return { submitted: false, method: clicked.reason, probe }
}


function formatBrowserV2Error(prefix: string, error: unknown, attempted: string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = normalizeErrorCode(error)
  return `${prefix}\nerror_code=${code}\nerror=${message}\nattempted=${attempted.join(' -> ')}`
}

export async function runGeminiQuery(
  controller: BrowserController,
  text: string,
  tabId: string | null,
  waitResponseMs: number,
  signal?: AbortSignal,
): Promise<string> {
  log(`[browser-v3][phase] browser_query_gemini start wait=${waitResponseMs}`)
  const attempted: string[] = []
  let activeTabId = tabId
  let submitted = false
  let responseDetected = false
  let evidence: Record<string, unknown> = {}

  try {
    throwIfAborted(signal)
    attempted.push('ensure-tab')
    if (!activeTabId) {
      const tabs = controller.getTabList()
      activeTabId = tabs.find((tab) => tab.active)?.id || null
      if (!activeTabId) {
        const created = await controller.createTab('https://gemini.google.com')
        if (!created.success || !created.tabId) {
          return formatBrowserV2Error('[browser-v3][phase] create-tab failed', new Error(created.error || 'create tab failed'), attempted)
        }
        activeTabId = created.tabId
      }
    }

    attempted.push('navigate-gemini')
    const currentUrl = String(await controller.executeJS(activeTabId, 'window.location.href') || '')
    if (!/gemini\.google\.com/i.test(currentUrl)) {
      const navResult = await controller.navigate(activeTabId, 'https://gemini.google.com')
      if (!navResult.success) {
        return formatBrowserV2Error('[browser-v3][phase] navigate failed', new Error(navResult.error || 'navigate failed'), attempted)
      }
    }

    await sleepWithAbort(BROWSER_V2_WAIT_AFTER_NAV_MS, signal)
    await waitForLoadingStop(controller, activeTabId, BROWSER_V2_STOP_LOADING_TIMEOUT_MS, signal)

    attempted.push('compose-dom')
    const domResult = String(
      await controller.executeJS(
        activeTabId,
        buildSmartTypeJs({
          target: 'Gemini message input prompt 输入 提问 搜索',
          text,
          clearFirst: true,
          submit: false,
        }),
      ),
    )
    submitted = /^typed into smart target:/i.test(domResult)
    evidence.domResult = domResult

    if (submitted) {
      attempted.push('verify-submit-after-dom')
      const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
      submitted = submitState.submitted
      evidence.submitMethod = submitState.method
      evidence.submitProbe = submitState.probe
    }

    if (!submitted) {
      attempted.push('probe-editables')
      const candidates = await probeGeminiEditableCandidates(controller, activeTabId)
      evidence.candidateCount = candidates.length
      if (candidates.length > 0) {
        attempted.push('type-at-top-candidate')
        const top = candidates[0]
        const point = await dispatchClickAt(controller, activeTabId, top.x, top.y)
        await clearFocusedInput(controller, activeTabId)
        await controller.typeTextDirectly(activeTabId, text, { useShiftEnterForNewline: false })
        const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
        submitted = submitState.submitted
        evidence.submitMethod = submitState.method
        evidence.submitProbe = submitState.probe
        evidence.coordinate = {
          normalized: { x: point.nx, y: point.ny },
          css: { x: point.cssX, y: point.cssY },
          reason: top.reason,
        }
      }
    }

    if (!submitted) {
      attempted.push('fallback-bottom-center')
      const point = await dispatchClickAt(controller, activeTabId, 500, 920)
      await clearFocusedInput(controller, activeTabId)
      await controller.typeTextDirectly(activeTabId, text, { useShiftEnterForNewline: false })
      const submitState = await ensureGeminiSubmitted(controller, activeTabId, text, attempted, signal)
      submitted = submitState.submitted
      evidence.submitMethod = submitState.method
      evidence.submitProbe = submitState.probe
      evidence.coordinate = {
        normalized: { x: point.nx, y: point.ny },
        css: { x: point.cssX, y: point.cssY },
        reason: 'fallback-bottom-center',
      }
    }

    if (!submitted) {
      return JSON.stringify({
        phase: 'submit_failed',
        submitted: false,
        response_detected: false,
        evidence,
        attempted,
        next_step: 'retry with browser_type_at + browser_send_keys or browser_ask_user_takeover',
      }, null, 2)
    }

    attempted.push('detect-response')
    const startedAt = Date.now()
    const initialWindowMs = Math.max(8_000, waitResponseMs)
    const hardTimeoutMs = Math.min(180_000, initialWindowMs + 90_000)
    const hardDeadline = startedAt + hardTimeoutMs
    let deadline = startedAt + initialWindowMs
    let inExtendedWait = false
    let stableResponseHits = 0
    let lastProbe: GeminiResponseProbe | null = null
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      lastProbe = await probeGeminiResponse(controller, activeTabId, text)
      if (lastProbe.loginRequired || lastProbe.captchaRequired) {
        const phase = 'human_required'
        return JSON.stringify({
          phase,
          submitted,
          response_detected: false,
          evidence: {
            ...evidence,
            reason: lastProbe.loginRequired ? 'login_required' : 'captcha_required',
            editableCount: lastProbe.editableCount,
          },
          next_step: 'use browser_ask_user_takeover',
        }, null, 2)
      }
      if (lastProbe.responseDetected) {
        stableResponseHits += 1
        if (stableResponseHits >= 2) {
          responseDetected = true
          evidence = {
            ...evidence,
            responseSnippet: lastProbe.responseText.slice(0, 300),
            editableCount: lastProbe.editableCount,
            thinking: false,
          }
          break
        }
      } else {
        stableResponseHits = 0
      }

      if (lastProbe.thinking && Date.now() + 8_000 >= deadline && deadline < hardDeadline) {
        inExtendedWait = true
        const nextDeadline = Math.min(hardDeadline, Date.now() + 22_000)
        if (nextDeadline > deadline) {
          deadline = nextDeadline
          attempted.push('extended-wait-thinking')
        }
      } else if (!lastProbe.thinking && !lastProbe.responseDetected && Date.now() + 4_000 >= deadline && deadline < hardDeadline) {
        const nextDeadline = Math.min(hardDeadline, Date.now() + 12_000)
        if (nextDeadline > deadline) {
          deadline = nextDeadline
          attempted.push('extended-wait-probe')
        }
      }
      await sleepWithAbort(900, signal)
    }

    const phase = responseDetected ? 'done' : 'submitted_waiting'
    log(`[browser-v3][phase] browser_query_gemini phase=${phase} submitted=${submitted} response=${responseDetected} submitMethod=${String(evidence.submitMethod || 'unknown')} extended=${inExtendedWait}`)
    if (!responseDetected && lastProbe) {
      evidence = {
        ...evidence,
        editableCount: lastProbe.editableCount,
        thinking: lastProbe.thinking,
        probe: 'response_not_detected_within_timeout',
        elapsedMs: Date.now() - startedAt,
      }
    }
    return JSON.stringify({
      phase,
      submitted,
      response_detected: responseDetected,
      evidence,
      attempted,
    }, null, 2)
  } catch (error) {
    if (isBrowserAbortError(error)) throw error
    log(`[browser-v3][fallback] browser_query_gemini error=${error instanceof Error ? error.message : String(error)}`)
    return formatBrowserV2Error('[browser-v3][fallback] browser_query_gemini failed', error, attempted)
  }
}

export async function isLikelyChatPage(controller: BrowserController, tabId: string | null): Promise<boolean> {
  try {
    const url = String(await controller.executeJS(tabId, 'window.location.href') || '')
    if (/(^https?:\/\/)?([^/]*\.)?(gemini\.google\.com|kimi\.moonshot\.cn|chatgpt\.com|claude\.ai|perplexity\.ai|doubao\.com|yuanbao\.tencent\.com|deepseek\.com)/i.test(url)) {
      return true
    }
    const probe = await controller.executeJS(
      tabId,
      `
        (() => {
          const hasEditable = document.querySelector('textarea,input,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]') !== null
          const hasSendButton = document.querySelector('button[aria-label*="send" i],button[aria-label*="发送" i],button[title*="send" i],button[title*="发送" i],button[data-testid*="send" i]') !== null
          const text = String(document.body?.innerText || '').toLowerCase()
          const hasChatKeyword = /chat|message|assistant|提问|对话|发送|输入/.test(text)
          return hasEditable && (hasSendButton || hasChatKeyword)
        })()
      `,
    )
    return Boolean(probe)
  } catch {
    // silent-catch: 探测脚本失败按非聊天页处理。
    return false
  }
}
