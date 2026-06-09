export type BrowserReadonlyProbeScope =
  | 'document'
  | 'visible'
  | 'forms'
  | 'links'
  | 'media'
  | 'frames'
  | 'shadow-dom'

export interface BrowserReadonlyProbeRequest {
  generation: number
  query?: string
  scope?: BrowserReadonlyProbeScope
  maxNodes?: number
  includeHidden?: boolean
  riskDecision?: 'allowed' | 'fixed_scope_only'
}

export interface BrowserReadonlyProbeNode {
  kind: string
  text: string
  selectorHint?: string
  role?: string
  href?: string
  src?: string
  inputType?: string
  valuePreview?: string
  fileNames?: string[]
  frameReadable?: boolean
  frameReason?: string
  hidden?: boolean
  box?: { x: number; y: number; width: number; height: number }
}

export interface BrowserReadonlyProbeResult {
  ok: true
  generation: number
  query: string
  scope: BrowserReadonlyProbeScope
  riskDecision: 'allowed' | 'fixed_scope_only'
  summary: string
  counts: {
    totalCandidates: number
    returned: number
    hiddenLoaded: number
    forms: number
    fileInputs: number
    links: number
    media: number
    frames: number
    shadowRoots: number
  }
  nodes: BrowserReadonlyProbeNode[]
  failureKind: null
  nextAllowedActions: string[]
}

export function normalizeBrowserReadonlyProbeRequest(input: {
  generation: unknown
  query?: unknown
  scope?: unknown
  maxNodes?: unknown
  includeHidden?: unknown
  riskDecision?: BrowserReadonlyProbeRequest['riskDecision']
}): BrowserReadonlyProbeRequest {
  const scope = (
    input.scope === 'visible' ||
    input.scope === 'forms' ||
    input.scope === 'links' ||
    input.scope === 'media' ||
    input.scope === 'frames' ||
    input.scope === 'shadow-dom'
  ) ? input.scope : 'document'
  const maxNodesRaw = Number(input.maxNodes)
  return {
    generation: Number(input.generation || 0),
    query: String(input.query || '').trim(),
    scope,
    maxNodes: Number.isFinite(maxNodesRaw) ? Math.max(1, Math.min(80, Math.floor(maxNodesRaw))) : 24,
    includeHidden: input.includeHidden === true,
    riskDecision: input.riskDecision || 'allowed',
  }
}

export function buildBrowserReadonlyProbeJs(request: BrowserReadonlyProbeRequest): string {
  const normalized = normalizeBrowserReadonlyProbeRequest(request)
  return `
    (() => {
      const __READY_READONLY_PROBE__ = true
      const generation = ${JSON.stringify(normalized.generation)}
      const query = ${JSON.stringify(normalized.query || '')}
      const scope = ${JSON.stringify(normalized.scope || 'document')}
      const maxNodes = ${JSON.stringify(normalized.maxNodes || 24)}
      const includeHidden = ${JSON.stringify(normalized.includeHidden === true)}
      const riskDecision = ${JSON.stringify(normalized.riskDecision || 'allowed')}
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim()
      const lowerQuery = normalize(query).toLowerCase()
      const safeSelector = (el) => {
        if (!(el instanceof Element)) return ''
        const tag = String(el.tagName || '').toLowerCase()
        const esc = (value) => {
          try { return CSS && CSS.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&') } catch { return String(value) }
        }
        if (el.id) return '#' + esc(el.id)
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
        if (testId) return tag + '[data-testid="' + String(testId).replace(/"/g, '\\\\"') + '"]'
        const name = el.getAttribute('name')
        if (name) return tag + '[name="' + String(name).replace(/"/g, '\\\\"') + '"]'
        return tag
      }
      const boxOf = (el) => {
        if (!(el instanceof Element)) return undefined
        const rect = el.getBoundingClientRect()
        if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return undefined
        return {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      }
      const isVisible = (el) => {
        if (!(el instanceof Element)) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
        if (Number(style.opacity || '1') <= 0) return false
        return true
      }
      const textOf = (el) => normalize([
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('placeholder'),
        el.getAttribute?.('title'),
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : '',
        el.textContent,
      ].filter(Boolean).join(' '))
      const matchesQuery = (node) => {
        if (!lowerQuery) return true
        return [
          node.text,
          node.href,
          node.src,
          node.selectorHint,
          node.inputType,
          node.role,
        ].map((value) => normalize(value).toLowerCase()).some((value) => value.includes(lowerQuery))
      }
      const pushElement = (out, el, kind) => {
        if (!(el instanceof Element)) return
        const visible = isVisible(el)
        if (!visible && !includeHidden) return
        const node = {
          kind,
          text: textOf(el).slice(0, 260),
          selectorHint: safeSelector(el),
          role: el.getAttribute('role') || undefined,
          hidden: visible ? undefined : true,
          box: visible ? boxOf(el) : undefined,
        }
        if (el instanceof HTMLAnchorElement) node.href = el.href || undefined
        if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement || el instanceof HTMLSourceElement) {
          node.src = el.currentSrc || el.src || undefined
        }
        if (el instanceof HTMLInputElement) {
          node.inputType = el.type || 'text'
          node.valuePreview = el.type === 'file' ? '' : String(el.value || '').slice(0, 120)
          if (el.type === 'file') node.fileNames = Array.from(el.files || []).map((file) => file.name).slice(0, 6)
        } else if (el instanceof HTMLTextAreaElement) {
          node.inputType = 'textarea'
          node.valuePreview = String(el.value || '').slice(0, 120)
        } else if (el instanceof HTMLSelectElement) {
          node.inputType = 'select'
          node.valuePreview = String(el.value || '').slice(0, 120)
        }
        if (matchesQuery(node)) out.push(node)
      }
      const roots = [document]
      const allElements = () => roots.flatMap((root) => Array.from(root.querySelectorAll('*')))
      const selectorsByScope = {
        document: 'h1,h2,h3,h4,p,li,a,button,input,textarea,select,label,summary,[role],img,video,audio,iframe',
        visible: 'h1,h2,h3,h4,p,li,a,button,label,summary,[role]',
        forms: 'form,input,textarea,select,button,label,[role="textbox"],[contenteditable="true"],[contenteditable="plaintext-only"]',
        links: 'a[href]',
        media: 'img,video,audio,source,canvas,picture',
        frames: 'iframe,frame',
        'shadow-dom': '*',
      }
      const all = allElements()
      const counts = {
        totalCandidates: 0,
        returned: 0,
        hiddenLoaded: 0,
        forms: document.querySelectorAll('form').length,
        fileInputs: document.querySelectorAll('input[type="file"]').length,
        links: document.querySelectorAll('a[href]').length,
        media: document.querySelectorAll('img,video,audio,source,canvas,picture').length,
        frames: document.querySelectorAll('iframe,frame').length,
        shadowRoots: all.filter((el) => el.shadowRoot).length,
      }
      counts.hiddenLoaded = all.filter((el) => {
        if (!(el instanceof Element)) return false
        if (isVisible(el)) return false
        return normalize(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').length > 0
      }).length
      const nodes = []
      if (scope === 'frames') {
        for (const frame of Array.from(document.querySelectorAll('iframe,frame'))) {
          if (!(frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement)) continue
          const visible = isVisible(frame)
          const node = {
            kind: 'frame',
            text: textOf(frame),
            selectorHint: safeSelector(frame),
            src: frame.src || undefined,
            hidden: visible ? undefined : true,
            box: visible ? boxOf(frame) : undefined,
            frameReadable: false,
            frameReason: 'cross_origin_or_unavailable',
          }
          try {
            const doc = frame.contentDocument
            node.frameReadable = Boolean(doc)
            node.frameReason = doc ? 'same_origin_readable' : 'cross_origin_or_unavailable'
          } catch {
            node.frameReadable = false
            node.frameReason = 'cross_origin_unreadable'
          }
          if ((includeHidden || visible) && matchesQuery(node)) nodes.push(node)
        }
      } else if (scope === 'shadow-dom') {
        for (const host of all) {
          if (!(host instanceof Element) || !host.shadowRoot) continue
          const visible = isVisible(host)
          if (!visible && !includeHidden) continue
          const shadowNodes = Array.from(host.shadowRoot.querySelectorAll('button,a,input,textarea,select,[role],slot')).slice(0, 8)
          const node = {
            kind: 'shadow-root',
            text: normalize([textOf(host), ...shadowNodes.map(textOf)].join(' ')).slice(0, 260),
            selectorHint: safeSelector(host),
            hidden: visible ? undefined : true,
            box: visible ? boxOf(host) : undefined,
          }
          if (matchesQuery(node)) nodes.push(node)
        }
      } else {
        const selector = selectorsByScope[scope] || selectorsByScope.document
        const elements = Array.from(document.querySelectorAll(selector))
        for (const el of elements) {
          const tag = String(el.tagName || '').toLowerCase()
          const kind =
            tag === 'a' ? 'link'
              : tag === 'input' || tag === 'textarea' || tag === 'select' ? 'input'
                : tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'source' || tag === 'canvas' || tag === 'picture' ? 'media'
                  : tag === 'form' ? 'form'
                    : 'text'
          pushElement(nodes, el, kind)
        }
      }
      counts.totalCandidates = nodes.length
      const limited = nodes.slice(0, maxNodes)
      counts.returned = limited.length
      const summary = [
        'scope=' + scope,
        'returned=' + counts.returned,
        counts.fileInputs ? 'fileInputs=' + counts.fileInputs : '',
        counts.frames ? 'frames=' + counts.frames : '',
        counts.shadowRoots ? 'shadowRoots=' + counts.shadowRoots : '',
        counts.hiddenLoaded ? 'hiddenLoaded=' + counts.hiddenLoaded : '',
      ].filter(Boolean).join(' ')
      return {
        ok: true,
        generation,
        query,
        scope,
        riskDecision,
        summary,
        counts,
        nodes: limited,
        failureKind: null,
        nextAllowedActions: ['read map again', 'act on target', 'wait', 'stop with reason'],
      }
    })()
  `
}
