import type { BrowserHostView, BrowserRect } from './host-types'
import type {
  BrowserCDPErrorCode,
  BrowserContentFrameInfo,
  BrowserKeyEventPayload,
  BrowserMouseEventPayload,
  BrowserScreenshotOptions,
  BrowserTabContextData,
  BrowserUploadTarget,
  BrowserViewportMetrics,
} from './automation-types'
import { filterBrowserLocalMediaUploadPaths } from '../../../shared/browser-local-media-upload'
import type { BrowserCdpSessionService } from './cdp-session-service'

interface BrowserAutomationTabRecord {
  id: string
  url: string
  title: string
  view?: BrowserHostView
}

interface BrowserAutomationHost {
  resolveTabView(tabId: string | null): { tabId: string; tab: BrowserAutomationTabRecord; view: BrowserHostView }
  createBrowserError(code: BrowserCDPErrorCode, message: string): Error
  getViewBounds(): BrowserRect
  cdpSession?: BrowserCdpSessionService
}

export class BrowserAutomationService {
  constructor(private readonly host: BrowserAutomationHost) {}

  private resolveViewBounds(view: BrowserHostView): BrowserRect {
    const hostBounds = this.host.getViewBounds()
    if (hostBounds.width > 0 && hostBounds.height > 0) return hostBounds
    try {
      const readBounds = (view as unknown as { getBounds?: () => BrowserRect }).getBounds
      if (typeof readBounds === 'function') {
        const viewBounds = readBounds.call(view)
        if (viewBounds && viewBounds.width > 0 && viewBounds.height > 0) return viewBounds
      }
    } catch {
      // Fall back to host bounds below.
    }
    return hostBounds
  }

  async getTabContext(tabId?: string | null): Promise<BrowserTabContextData> {
    const { tab } = this.host.resolveTabView(tabId || null)
    const context = await this.executeJS(
      tabId || null,
      `(() => {
        const title = document.title || ''
        const url = location.href || ''
        const hostname = (() => {
          try { return new URL(url).hostname.toLowerCase() } catch { return '' }
        })()
        const selection = (window.getSelection && String(window.getSelection() || '')) || ''
        const heading = (document.querySelector('h1')?.textContent || '').trim()
        const bodyText = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim()
        return {
          title,
          url,
          domain: hostname,
          heading,
          selection: selection.trim().slice(0, 4000),
          excerpt: bodyText.slice(0, 8000),
          capturedAt: Date.now(),
        }
      })()`,
    ) as Partial<BrowserTabContextData> | null

    return {
      title: context?.title || tab.title || '',
      url: context?.url || tab.url || '',
      domain: context?.domain || (() => {
        try { return new URL(context?.url || tab.url || '').hostname.toLowerCase() } catch { return '' }
      })(),
      heading: context?.heading || '',
      selection: context?.selection || '',
      excerpt: context?.excerpt || '',
      capturedAt: context?.capturedAt || Date.now(),
    }
  }

  async ensureDebugger(tabId: string | null): Promise<{ tabId: string }> {
    if (this.host.cdpSession) {
      return this.host.cdpSession.ensureAttached(tabId)
    }
    const { tabId: resolvedTabId, view } = this.host.resolveTabView(tabId)
    try {
      if (!view.webContents.debugger.isAttached()) {
        view.webContents.debugger.attach('1.3')
      }
      return { tabId: resolvedTabId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('DEBUGGER_ATTACH_FAILED', `Debugger attach failed: ${message}`)
    }
  }

  private async sendCdpCommand(
    tabId: string | null,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.host.cdpSession) {
      return this.host.cdpSession.sendCommand(tabId, method, params)
    }
    const { view } = this.host.resolveTabView(tabId)
    await this.ensureDebugger(tabId)
    return view.webContents.debugger.sendCommand(method, params)
  }

  async getViewportMetrics(tabId: string | null): Promise<BrowserViewportMetrics> {
    const { view } = this.host.resolveTabView(tabId)
    let fromPage: Partial<BrowserViewportMetrics> | null = null

    try {
      const result = await view.webContents.executeJavaScript(
        `
          (() => {
            const vv = window.visualViewport
            if (!vv) return null
            return {
              width: Number(vv.width || window.innerWidth || 0),
              height: Number(vv.height || window.innerHeight || 0),
              pageX: Number(vv.pageLeft || window.scrollX || 0),
              pageY: Number(vv.pageTop || window.scrollY || 0),
              scale: Number(vv.scale || 1),
            }
          })()
        `,
        true,
      ) as Partial<BrowserViewportMetrics> | null
      if (
        result &&
        Number.isFinite(result.width) &&
        Number.isFinite(result.height) &&
        (result.width || 0) > 0 &&
        (result.height || 0) > 0
      ) {
        fromPage = result
      }
    } catch {
      fromPage = null
    }

    if (fromPage) {
      return {
        width: Number(fromPage.width),
        height: Number(fromPage.height),
        pageX: Number(fromPage.pageX || 0),
        pageY: Number(fromPage.pageY || 0),
        scale: Number(fromPage.scale || 1),
      }
    }

    await this.ensureDebugger(tabId)
    try {
      const layout = await this.sendCdpCommand(tabId, 'Page.getLayoutMetrics') as {
        layoutViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number }
        visualViewport?: { clientWidth?: number; clientHeight?: number; pageX?: number; pageY?: number; scale?: number }
      }

      const bounds = this.resolveViewBounds(view)
      return {
        width: Number(layout.visualViewport?.clientWidth || layout.layoutViewport?.clientWidth || bounds.width),
        height: Number(layout.visualViewport?.clientHeight || layout.layoutViewport?.clientHeight || bounds.height),
        pageX: Number(layout.visualViewport?.pageX || layout.layoutViewport?.pageX || 0),
        pageY: Number(layout.visualViewport?.pageY || layout.layoutViewport?.pageY || 0),
        scale: Number(layout.visualViewport?.scale || 1),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', `Page.getLayoutMetrics failed: ${message}`)
    }
  }

  async normalizedToCss(tabId: string | null, x: number, y: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const metrics = await this.getViewportMetrics(tabId)
    const clamp = (value: number) => Math.max(0, Math.min(999, Number.isFinite(value) ? value : 0))
    const nx = clamp(x)
    const ny = clamp(y)
    const width = Math.max(1, Math.floor(metrics.width))
    const height = Math.max(1, Math.floor(metrics.height))
    return {
      x: Math.round((nx / 999) * (width - 1)),
      y: Math.round((ny / 999) * (height - 1)),
      width,
      height,
    }
  }

  async dispatchMouse(tabId: string | null, payload: BrowserMouseEventPayload): Promise<void> {
    try {
      await this.sendCdpCommand(tabId, 'Input.dispatchMouseEvent', {
        type: payload.type,
        x: payload.x,
        y: payload.y,
        button: payload.button || 'left',
        buttons: payload.buttons || 0,
        clickCount: payload.clickCount || 1,
        deltaX: payload.deltaX || 0,
        deltaY: payload.deltaY || 0,
        modifiers: payload.modifiers || 0,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', `Input.dispatchMouseEvent failed: ${message}`)
    }
  }

  async dispatchKey(tabId: string | null, payload: BrowserKeyEventPayload): Promise<void> {
    try {
      await this.sendCdpCommand(tabId, 'Input.dispatchKeyEvent', {
        type: payload.type,
        key: payload.key || '',
        code: payload.code || '',
        text: payload.text || '',
        modifiers: payload.modifiers || 0,
        windowsVirtualKeyCode: payload.windowsVirtualKeyCode,
        nativeVirtualKeyCode: payload.nativeVirtualKeyCode,
        isKeypad: payload.isKeypad,
        autoRepeat: payload.autoRepeat,
        unmodifiedText: payload.unmodifiedText,
        location: payload.location,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', `Input.dispatchKeyEvent failed: ${message}`)
    }
  }

  async typeTextDirectly(tabId: string | null, text: string, options?: { useShiftEnterForNewline?: boolean }): Promise<void> {
    const useShiftEnterForNewline = options?.useShiftEnterForNewline === true

    try {
      if (!useShiftEnterForNewline || !text.includes('\n')) {
        await this.sendCdpCommand(tabId, 'Input.insertText', { text })
        return
      }

      const segments = text.split('\n')
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i]
        if (segment.length > 0) {
          await this.sendCdpCommand(tabId, 'Input.insertText', { text: segment })
        }
        if (i < segments.length - 1) {
          await this.dispatchKey(tabId, { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 })
          await this.dispatchKey(tabId, { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8 })
          await this.dispatchKey(tabId, { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8 })
          await this.dispatchKey(tabId, { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', `Input.insertText failed: ${message}`)
    }
  }

  async screenshotAdvanced(tabId: string | null, options?: BrowserScreenshotOptions): Promise<string> {
    const { view } = this.host.resolveTabView(tabId)
    const mode = options?.mode || 'viewport'

    if (mode === 'viewport') {
      const image = await view.webContents.capturePage()
      return image.toPNG().toString('base64')
    }

    await this.ensureDebugger(tabId)
    try {
      if (mode === 'clip' && options?.clip) {
        const result = await this.sendCdpCommand(tabId, 'Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true,
          clip: {
            x: options.clip.x,
            y: options.clip.y,
            width: Math.max(1, options.clip.width),
            height: Math.max(1, options.clip.height),
            scale: 1,
          },
        }) as { data?: string }
        return String(result.data || '')
      }

      const layout = await this.sendCdpCommand(tabId, 'Page.getLayoutMetrics') as {
        contentSize?: { width?: number; height?: number; x?: number; y?: number }
      }
      const bounds = this.resolveViewBounds(view)
      const clipWidth = Math.max(1, Math.ceil(Number(layout.contentSize?.width || bounds.width)))
      const clipHeight = Math.max(1, Math.ceil(Number(layout.contentSize?.height || bounds.height)))
      const result = await this.sendCdpCommand(tabId, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: Number(layout.contentSize?.x || 0),
          y: Number(layout.contentSize?.y || 0),
          width: clipWidth,
          height: clipHeight,
          scale: 1,
        },
      }) as { data?: string }
      return String(result.data || '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', `Page.captureScreenshot failed: ${message}`)
    }
  }

  async executeJS(tabId: string | null, code: string): Promise<unknown> {
    const { view } = this.host.resolveTabView(tabId)
    return view.webContents.executeJavaScript(code, true)
  }

  /**
   * D10 frame 穿透（2026-07-04）：executeJavaScript 只达主帧，创作类页面
   * （如 XHS creator）把交互 UI 渲染在 iframe/OOPIF 里，定位器永远看不见。
   * frameKey='0' 指主帧；子帧用 `${processId}-${routingId}`（随帧实例存亡，
   * 帧导航/移除后 key 失效，天然让引用它的 page-map targetId 过期）。
   */
  listContentFrames(tabId: string | null): BrowserContentFrameInfo[] {
    const { view } = this.host.resolveTabView(tabId)
    const mainFrame = view.webContents.mainFrame
    const frames: BrowserContentFrameInfo[] = []
    for (const frame of mainFrame.framesInSubtree) {
      try {
        const main = frame === mainFrame
        frames.push({
          frameKey: main ? '0' : `${frame.processId}-${frame.routingId}`,
          url: String(frame.url || ''),
          main,
        })
      } catch {
        // silent-catch: 帧可能在枚举间隙被销毁，跳过该帧继续。
        continue
      }
    }
    return frames
  }

  async executeJSInFrame(tabId: string | null, frameKey: string, code: string): Promise<unknown> {
    if (!frameKey || frameKey === '0') return this.executeJS(tabId, code)
    const { view } = this.host.resolveTabView(tabId)
    const mainFrame = view.webContents.mainFrame
    const frame = mainFrame.framesInSubtree.find((candidate) => {
      try {
        return candidate !== mainFrame && `${candidate.processId}-${candidate.routingId}` === frameKey
      } catch {
        // silent-catch: 被销毁帧读属性会抛，按不匹配处理。
        return false
      }
    })
    if (!frame) {
      throw this.host.createBrowserError('FRAME_NOT_FOUND', `Frame ${frameKey} is no longer present on this page`)
    }
    return frame.executeJavaScript(code, true)
  }

  async getPageContent(tabId: string | null): Promise<string> {
    const text = await this.executeJS(tabId, 'document.body.innerText') as string
    return typeof text === 'string' ? text.slice(0, 30_000) : String(text ?? '')
  }

  async getPageHTML(tabId: string | null): Promise<string> {
    const html = await this.executeJS(tabId, 'document.documentElement.outerHTML') as string
    return typeof html === 'string' ? html.slice(0, 50_000) : String(html ?? '')
  }

  async screenshot(tabId: string | null): Promise<string> {
    return this.screenshotAdvanced(tabId, { mode: 'viewport' })
  }

  async findUploadTargets(tabId: string | null): Promise<BrowserUploadTarget[]> {
    const raw = await this.executeJS(tabId, `(() => {
      const out = []
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width >= 6 &&
          rect.height >= 6 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || '1') > 0
      }
      const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
      const keywordRe = /(upload|attach|image|photo|file|media|add|plus|drag|drop|上传|附件|图片|照片|文件|媒体|添加|导入|拖拽|选择)/i
      const iconishRe = /(upload|attach|image|photo|plus|paperclip|media|add|文件|上传|附件|图片|添加|回形针)/i
      const selectorFor = (el, fallbackTag = 'div') => {
        if (!(el instanceof Element)) return fallbackTag
        if (el.id) return '#' + CSS.escape(el.id)
        const name = el.getAttribute('name')
        if (el instanceof HTMLInputElement && el.type === 'file' && name) {
          return 'input[type="file"][name="' + CSS.escape(name) + '"]'
        }
        const tag = (el.tagName || fallbackTag).toLowerCase()
        let sameTagSiblings = 0
        let index = 0
        const parent = el.parentElement
        if (parent) {
          for (const child of Array.from(parent.children)) {
            if ((child.tagName || '').toLowerCase() === tag) {
              sameTagSiblings += 1
              if (child === el) index = sameTagSiblings
            }
          }
        }
        return sameTagSiblings > 1 ? tag + ':nth-of-type(' + Math.max(1, index) + ')' : tag
      }
      const findLinkedInput = (node) => {
        if (!node) return null
        if (node instanceof HTMLInputElement && node.type === 'file') return node
        if (node instanceof HTMLLabelElement && node.htmlFor) {
          const linked = document.getElementById(node.htmlFor)
          if (linked instanceof HTMLInputElement && linked.type === 'file') return linked
        }
        if (node instanceof HTMLElement) {
          const nested = node.querySelector('input[type="file"]')
          if (nested instanceof HTMLInputElement) return nested
          const root = node.closest('label,[role="button"],button,div,section,form')
          const deeper = root?.querySelector?.('input[type="file"]')
          if (deeper instanceof HTMLInputElement) return deeper
        }
        return null
      }
      const pushTarget = (target) => {
        if (!target || typeof target !== 'object') return
        const key = [target.kind, target.selectorHint, target.label, target.x, target.y].join('::')
        if (out.some((item) => [item.kind, item.selectorHint, item.label, item.x, item.y].join('::') === key)) return
        out.push(target)
      }
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      inputs.slice(0, 24).forEach((input, index) => {
        const el = input
        const rect = el.getBoundingClientRect()
        const label =
          normalize(el.getAttribute('aria-label')) ||
          normalize(el.getAttribute('title')) ||
          normalize(el.getAttribute('name')) ||
          normalize(el.getAttribute('id')) ||
          normalize(el.closest('label')?.textContent) ||
          normalize(el.parentElement?.textContent) ||
          ('上传入口 ' + (index + 1))
        pushTarget({
          id: 'upload-' + (index + 1),
          kind: 'input',
          selectorHint: selectorFor(el, 'input[type="file"]'),
          label,
          accepts: normalize(el.getAttribute('accept')),
          multiple: el.hasAttribute('multiple'),
          hidden: !visible(el),
          confidence: visible(el) ? 0.96 : 0.72,
          evidence: ['input[type=file]'],
          x: rect.width > 0 ? Math.round(rect.left + rect.width / 2) : undefined,
          y: rect.height > 0 ? Math.round(rect.top + rect.height / 2) : undefined,
        })
      })
      const candidates = Array.from(document.querySelectorAll('button,label,[role="button"],div,section,a,span'))
      let launcherIndex = 0
      let dropzoneIndex = 0
      for (const node of candidates) {
        if (!(node instanceof HTMLElement) || !visible(node)) continue
        const rect = node.getBoundingClientRect()
        if (rect.width < 20 || rect.height < 20) continue
        const linkedInput = findLinkedInput(node)
        const meta = normalize([
          node.getAttribute('aria-label'),
          node.getAttribute('title'),
          node.getAttribute('data-testid'),
          node.getAttribute('class'),
          node.textContent,
        ].filter(Boolean).join(' '))
        const hasKeyword = keywordRe.test(meta)
        const iconish = iconishRe.test(meta)
        const dropzone = /(drag|drop|拖拽|拖入|放到这里|dropzone|upload-zone)/i.test(meta)
        if (!hasKeyword && !iconish && !linkedInput) continue
        const kind = dropzone ? 'dropzone' : 'launcher'
        const label = normalize(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || meta) ||
          (kind === 'dropzone' ? '拖拽上传区域' : '上传启动入口')
        const associatedInputSelector = linkedInput ? selectorFor(linkedInput, 'input[type="file"]') : undefined
        const confidenceBase = linkedInput ? 0.9 : hasKeyword ? 0.75 : 0.58
        const evidence = [
          hasKeyword ? 'keyword_match' : '',
          iconish ? 'iconish_meta' : '',
          linkedInput ? 'linked_file_input' : '',
          dropzone ? 'dropzone_pattern' : '',
        ].filter(Boolean)
        if (kind === 'launcher') launcherIndex += 1
        if (kind === 'dropzone') dropzoneIndex += 1
        pushTarget({
          id: kind === 'launcher' ? 'launcher-' + launcherIndex : 'dropzone-' + dropzoneIndex,
          kind,
          selectorHint: selectorFor(node),
          label,
          accepts: linkedInput ? normalize(linkedInput.getAttribute('accept')) : '',
          multiple: linkedInput ? linkedInput.hasAttribute('multiple') : false,
          hidden: false,
          confidence: confidenceBase,
          evidence,
          associatedInputSelector,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        })
      }
      return out.sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0)).slice(0, 32)
    })()`)
    return Array.isArray(raw) ? raw as BrowserUploadTarget[] : []
  }

  async setFileInputFiles(
    tabId: string | null,
    payload: { files: string[]; selector?: string; target?: string; x?: number; y?: number },
  ): Promise<{ ok: boolean; targetDescription: string; inputFound: boolean; filesAssigned?: boolean; assignedFileNames?: string[] }> {
    const { view } = this.host.resolveTabView(tabId)
    await this.ensureDebugger(tabId)
    const files = (payload.files || []).filter((item) => typeof item === 'string' && item.trim().length > 0)
    if (files.length === 0) {
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', 'No files provided for upload')
    }

    const marker = `ready-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const selector = typeof payload.selector === 'string' ? payload.selector.trim() : ''
    const target = typeof payload.target === 'string' ? payload.target.trim() : ''
    const x = Number.isFinite(Number(payload.x)) ? Number(payload.x) : null
    const y = Number.isFinite(Number(payload.y)) ? Number(payload.y) : null

    const markResult = await this.executeJS(tabId, `
      (() => {
        const marker = ${JSON.stringify(marker)}
        const clearMarker = () => {
          document.querySelectorAll('[data-ready-upload-target]').forEach((node) => {
            if (node instanceof HTMLElement) node.removeAttribute('data-ready-upload-target')
          })
        }
        const normalize = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          return rect.width >= 6 &&
            rect.height >= 6 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || '1') > 0
        }
        const toInput = (node) => {
          if (!node) return null
          if (node instanceof HTMLInputElement && node.type === 'file') return node
          if (node instanceof HTMLLabelElement) {
            if (node.htmlFor) {
              const linked = document.getElementById(node.htmlFor)
              if (linked instanceof HTMLInputElement && linked.type === 'file') return linked
            }
            const nested = node.querySelector('input[type="file"]')
            if (nested instanceof HTMLInputElement) return nested
          }
          if (node instanceof HTMLElement) {
            const nested = node.querySelector('input[type="file"]')
            if (nested instanceof HTMLInputElement) return nested
            const root = node.closest('label,[role="button"],button,div,section,form')
            const deeper = root?.querySelector?.('input[type="file"]')
            if (deeper instanceof HTMLInputElement) return deeper
          }
          return null
        }
        const chooseByTarget = (text) => {
          const wanted = normalize(text).toLowerCase()
          if (!wanted) return null
          const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
          let best = null
          let bestScore = -1
          for (const input of inputs) {
            const label = [
              input.getAttribute('aria-label'),
              input.getAttribute('title'),
              input.getAttribute('name'),
              input.getAttribute('id'),
              input.closest('label')?.textContent,
              input.parentElement?.textContent,
            ].map(normalize).join(' ').toLowerCase()
            let score = 0
            if (label.includes(wanted)) score += 10
            if (visible(input)) score += 3
            if (score > bestScore) {
              best = input
              bestScore = score
            }
          }
          return best
        }
        clearMarker()
        let input = null
        const selector = ${JSON.stringify(selector)}
        const target = ${JSON.stringify(target)}
        const pointX = ${x === null ? 'null' : JSON.stringify(x)}
        const pointY = ${y === null ? 'null' : JSON.stringify(y)}
        if (selector) input = toInput(document.querySelector(selector))
        if (!input && target) input = chooseByTarget(target)
        if (!input && Number.isFinite(pointX) && Number.isFinite(pointY)) {
          const node = document.elementFromPoint(pointX, pointY)
          input = toInput(node)
        }
        if (!input) input = document.querySelector('input[type="file"]')
        if (!(input instanceof HTMLInputElement)) {
          return { ok: false, targetDescription: target || selector || 'input[type=file]', inputFound: false }
        }
        input.setAttribute('data-ready-upload-target', marker)
        return {
          ok: true,
          targetDescription:
            normalize(input.getAttribute('aria-label')) ||
            normalize(input.getAttribute('title')) ||
            normalize(input.getAttribute('name')) ||
            normalize(input.getAttribute('id')) ||
            normalize(input.closest('label')?.textContent) ||
            target || selector || 'input[type=file]',
          inputFound: true,
        }
      })()
    `) as { ok?: boolean; targetDescription?: string; inputFound?: boolean } | null

    if (!markResult?.inputFound) {
      return {
        ok: false,
        targetDescription: markResult?.targetDescription || target || selector || 'input[type=file]',
        inputFound: false,
        filesAssigned: false,
        assignedFileNames: [],
      }
    }

    try {
      const documentNode = await this.sendCdpCommand(tabId, 'DOM.getDocument', { depth: 2, pierce: true }) as { root?: { nodeId?: number } }
      const rootNodeId = Number(documentNode.root?.nodeId || 0)
      const query = await this.sendCdpCommand(tabId, 'DOM.querySelector', {
        nodeId: rootNodeId,
        selector: `[data-ready-upload-target="${marker}"]`,
      }) as { nodeId?: number }
      const nodeId = Number(query.nodeId || 0)
      if (!nodeId) {
        return {
          ok: false,
          targetDescription: markResult?.targetDescription || target || selector || 'input[type=file]',
          inputFound: false,
          filesAssigned: false,
          assignedFileNames: [],
        }
      }
      await this.sendCdpCommand(tabId, 'DOM.setFileInputFiles', { nodeId, files })
      const assignmentResult = await this.executeJS(tabId, `
        (() => {
          const input = document.querySelector('[data-ready-upload-target="${marker}"]')
          if (!(input instanceof HTMLInputElement)) return { assigned: false, names: [] }
          const names = Array.from(input.files || []).map((file) => String(file.name || ''))
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          input.removeAttribute('data-ready-upload-target')
          return { assigned: names.length > 0, names }
        })()
      `) as { assigned?: boolean; names?: string[] } | null
      return {
        ok: true,
        targetDescription: markResult?.targetDescription || target || selector || 'input[type=file]',
        inputFound: true,
        filesAssigned: Boolean(assignmentResult?.assigned),
        assignedFileNames: Array.isArray(assignmentResult?.names) ? assignmentResult.names.map((item) => String(item || '')) : [],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('CDP_COMMAND_FAILED', `DOM.setFileInputFiles failed: ${message}`)
    }
  }

  async uploadLocalMediaFiles(
    tabId: string | null,
    payload: { files: string[]; x?: number; y?: number },
  ): Promise<{
    success: boolean
    method?: 'file-input' | 'drop'
    targetDescription?: string
    assignedFileNames?: string[]
    error?: string
  }> {
    const files = filterBrowserLocalMediaUploadPaths((payload.files || []).map((filePath) => ({ path: filePath })))
    if (files.length === 0) {
      return { success: false, error: '没有可上传的图片或视频文件。' }
    }

    const targets = await this.findUploadTargets(tabId)
    const bestTarget = this.pickLocalMediaUploadTarget(targets, files.length)
    const selector = bestTarget?.associatedInputSelector || (bestTarget?.kind === 'input' ? bestTarget.selectorHint : undefined)
    const x = Number.isFinite(Number(payload.x)) ? Number(payload.x) : bestTarget?.x
    const y = Number.isFinite(Number(payload.y)) ? Number(payload.y) : bestTarget?.y

    let inputResult: Awaited<ReturnType<BrowserAutomationService['setFileInputFiles']>> | null = null
    try {
      inputResult = await this.setFileInputFiles(tabId, {
        files,
        selector,
        target: bestTarget?.label,
        x,
        y,
      })
    } catch {
      inputResult = null
    }
    if (inputResult?.ok && inputResult.filesAssigned) {
      return {
        success: true,
        method: 'file-input',
        targetDescription: inputResult.targetDescription,
        assignedFileNames: inputResult.assignedFileNames,
      }
    }

    const dropped = await this.dispatchLocalFileDrop(tabId, files, { x, y })
    if (dropped) {
      return {
        success: true,
        method: 'drop',
        targetDescription: bestTarget?.label || '当前网页',
        assignedFileNames: files.map((filePath) => filePath.split(/[\\/]/).pop() || filePath),
      }
    }

    return {
      success: false,
      targetDescription: inputResult?.targetDescription || bestTarget?.label,
      error: '当前页面没有找到可用的上传入口。',
    }
  }

  private pickLocalMediaUploadTarget(targets: BrowserUploadTarget[], fileCount: number): BrowserUploadTarget | null {
    const scored = targets
      .map((target) => {
        let score = Number(target.confidence || 0)
        if (target.kind === 'input') score += 1
        if (target.associatedInputSelector) score += 0.8
        if (fileCount > 1 && target.multiple) score += 0.5
        if (target.hidden && target.kind !== 'input') score -= 0.4
        if (/(image|photo|media|video|图片|照片|媒体|视频)/i.test(`${target.label} ${target.accepts}`)) score += 0.4
        return { target, score }
      })
      .sort((a, b) => b.score - a.score)
    return scored[0]?.target || null
  }

  private async dispatchLocalFileDrop(
    tabId: string | null,
    files: string[],
    point: { x?: number; y?: number },
  ): Promise<boolean> {
    const metrics = await this.getViewportMetrics(tabId)
    const x = Number.isFinite(Number(point.x)) ? Number(point.x) : Math.round(metrics.width / 2)
    const y = Number.isFinite(Number(point.y)) ? Number(point.y) : Math.round(metrics.height / 2)
    const data = {
      items: [],
      files,
      dragOperationsMask: 1,
    }
    try {
      await this.sendCdpCommand(tabId, 'Input.dispatchDragEvent', { type: 'dragEnter', x, y, data })
      await this.sendCdpCommand(tabId, 'Input.dispatchDragEvent', { type: 'dragOver', x, y, data })
      await this.sendCdpCommand(tabId, 'Input.dispatchDragEvent', { type: 'drop', x, y, data })
      return true
    } catch {
      return false
    }
  }
}
