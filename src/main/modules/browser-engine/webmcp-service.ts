import { z } from 'zod'
import type { BrowserCdpEvent, BrowserCdpSessionService } from './cdp-session-service'
import { httpOrigin } from './browser-origin-write-scope'

const toolSchema = z.object({
  name: z.string().min(1), description: z.string(), frameId: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  // CDP names in the pinned Chromium binary omit the page API's Hint suffix.
  annotations: z.object({ readOnly: z.boolean().optional(), consequential: z.boolean().optional(), untrustedContent: z.boolean().optional() }).optional(),
})
export type WebMcpTool = Omit<z.infer<typeof toolSchema>, 'annotations'> & {
  registration: number
  cdpAnnotations?: z.infer<typeof toolSchema>['annotations']
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean }
}
export type WebMcpFrameIdentity = { origin: string; frameDocumentToken: string }
export type PreparedWebMcpTool = WebMcpFrameIdentity & { tool: WebMcpTool }
export function webMcpToolWrites(tool: WebMcpTool): boolean {
  return tool.annotations?.consequentialHint === true || tool.annotations?.readOnlyHint !== true
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
type TabState = {
  tools: Map<string, WebMcpTool>
  frames: Map<string, string | null>
  unsubscribe: () => void
  release: (() => Promise<void>) | null
  pending: Set<(error: Error) => void>
  ready: Promise<void>
}
const key = (frameId: string, name: string) => JSON.stringify([frameId, name])

/** One owner per tab. CDP events are data, never executable instructions. */
export class WebMcpService {
  private readonly tabs = new Map<string, TabState>()
  private sequence = 0
  constructor(private readonly cdp: Pick<BrowserCdpSessionService, 'subscribe' | 'retainDomain' | 'sendCommand'>,
    readonly enabled: boolean, private readonly timeoutMs = 30_000) {}

  async enableTab(tabId: string): Promise<void> {
    if (!this.enabled) return
    const existing = this.tabs.get(tabId)
    if (existing) return existing.ready
    const state: TabState = { tools: new Map(), frames: new Map(), unsubscribe: () => undefined, release: null, pending: new Set(), ready: Promise.resolve() }
    this.tabs.set(tabId, state)
    state.unsubscribe = this.cdp.subscribe(tabId, event => this.receive(state, event))
    state.ready = (async () => {
      try {
        const release = await this.cdp.retainDomain(tabId, 'Page')
        if (this.tabs.get(tabId) !== state) { await release(); return }
        state.release = release
        const tree = record(await this.cdp.sendCommand(tabId, 'Page.getFrameTree'))
        const remember = (value: unknown) => {
          const node = record(value), frame = record(node.frame)
          if (typeof frame.id === 'string') state.frames.set(frame.id, typeof frame.parentId === 'string' ? frame.parentId : null)
          for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) remember(child)
        }
        remember(tree.frameTree)
        if (this.tabs.get(tabId) !== state) return
        await this.cdp.sendCommand(tabId, 'WebMCP.enable')
      } catch (error) {
        this.disposeTab(tabId)
        throw error
      }
    })()
    return state.ready
  }

  private receive(state: TabState, event: BrowserCdpEvent): void {
    const { method, params } = event
    if (method === 'Page.frameAttached' && typeof params.frameId === 'string') {
      state.frames.set(params.frameId, typeof params.parentFrameId === 'string' ? params.parentFrameId : null)
    }
    if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') {
      const frame = record(params.frame)
      const frameId = String(frame.id || params.frameId || '')
      const mainNavigation = method === 'Page.frameNavigated' && !frame.parentId
      const removed = new Set([frameId])
      for (let size = -1; size !== removed.size;) {
        size = removed.size
        for (const [child, parent] of state.frames) if (parent && removed.has(parent)) removed.add(child)
      }
      for (const [id, tool] of state.tools) if (mainNavigation || removed.has(tool.frameId)) state.tools.delete(id)
      for (const id of state.frames.keys()) if (mainNavigation || removed.has(id)) state.frames.delete(id)
      if (method === 'Page.frameNavigated') state.frames.set(frameId, typeof frame.parentId === 'string' ? frame.parentId : null)
      for (const cancel of state.pending) cancel(new Error('webmcp_page_changed'))
    }
    if (method === 'WebMCP.toolsAdded') {
      for (const candidate of Array.isArray(params.tools) ? params.tools : []) {
        const parsed = toolSchema.safeParse(candidate)
        if (!parsed.success) continue // Invalid external registrations are not callable.
        const raw = parsed.data.annotations
        const tool: WebMcpTool = { ...parsed.data, registration: ++this.sequence, cdpAnnotations: raw,
          annotations: raw ? { readOnlyHint: raw.readOnly, consequentialHint: raw.consequential, untrustedContentHint: raw.untrustedContent } : undefined }
        state.tools.set(key(tool.frameId, tool.name), tool)
      }
    }
    if (method === 'WebMCP.toolsRemoved') {
      for (const raw of Array.isArray(params.tools) ? params.tools : []) {
        const tool = record(raw)
        state.tools.delete(key(String(tool.frameId), String(tool.name)))
      }
    }
  }

  hasTools(tabId: string): boolean { return this.enabled && (this.tabs.get(tabId)?.tools.size || 0) > 0 }
  tools(tabId: string): WebMcpTool[] { return structuredClone([...this.tabs.get(tabId)?.tools.values() || []]) }
  requireTool(tabId: string, frameId: string, name: string, registration?: number): WebMcpTool {
    const tool = this.enabled ? this.tabs.get(tabId)?.tools.get(key(frameId, name)) : null
    if (!tool || (registration !== undefined && tool.registration !== registration)) throw new Error('webmcp_tool_unavailable')
    return structuredClone(tool)
  }
  validateInput(tool: WebMcpTool, input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('webmcp_input_requires_object')
    // Fail closed on unsupported schemas; do not silently invoke with unvalidated arguments.
    const schema = z.fromJSONSchema(tool.inputSchema)
    if (!schema.safeParse(input).success) throw new Error('webmcp_input_schema_invalid')
  }
  async origin(tabId: string, tool: WebMcpTool): Promise<string> {
    return (await this.frameIdentity(tabId, tool)).origin
  }
  async frameIdentity(tabId: string, tool: WebMcpTool): Promise<WebMcpFrameIdentity> {
    this.requireTool(tabId, tool.frameId, tool.name, tool.registration)
    const world = record(await this.cdp.sendCommand(tabId, 'Page.createIsolatedWorld', { frameId: tool.frameId, worldName: 'ready-webmcp-origin' }))
    if (typeof world.executionContextId !== 'number') throw new Error('webmcp_origin_unavailable')
    const result = record(await this.cdp.sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'location.origin', contextId: world.executionContextId, returnByValue: true,
    }))
    const origin = record(result.result).value
    this.requireTool(tabId, tool.frameId, tool.name, tool.registration)
    if (typeof origin !== 'string' || httpOrigin(origin) !== origin) throw new Error('webmcp_origin_unavailable')
    return { origin, frameDocumentToken: `webmcp-context:${world.executionContextId}` }
  }

  async invoke(tabId: string, tool: WebMcpTool, input: unknown, signal?: AbortSignal, beforeSend?: () => void): Promise<unknown> {
    this.validateInput(tool, input)
    const state = this.tabs.get(tabId)
    this.requireTool(tabId, tool.frameId, tool.name, tool.registration)
    if (!state) throw new Error('webmcp_tool_unavailable')
    if (signal?.aborted) throw new Error('webmcp_cancelled')
    let completed = false
    let finished = false
    let invocationId: string | null = null
    const early = new Map<string, Record<string, unknown>>()
    let settle: (params: Record<string, unknown>) => void = () => undefined
    let cancel: (error: Error) => void = () => undefined
    const response = new Promise<unknown>((resolve, reject) => {
      cancel = reject
      settle = params => {
        completed = true
        if (params.status === 'Completed') resolve(params.output)
        else reject(new Error(`webmcp_invocation_${String(params.status)}`))
      }
    })
    const cancelInvocation = (id: string) => {
      void this.cdp.sendCommand(tabId, 'WebMCP.cancelInvocation', { invocationId: id }, { timeoutMs: 2000 })
        .catch(error => console.warn('[webmcp] cancellation unconfirmed; outcome unknown', error))
    }
    const unsubscribe = this.cdp.subscribe(tabId, event => {
      if (event.method !== 'WebMCP.toolResponded' || typeof event.params.invocationId !== 'string') return
      if (event.params.invocationId === invocationId) settle(event.params)
      else if (invocationId === null && early.size < 64) early.set(event.params.invocationId, event.params)
    })
    const abort = () => cancel(new Error('webmcp_cancelled_outcome_unknown'))
    state.pending.add(cancel)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => cancel(new Error('webmcp_timeout_outcome_unknown')), this.timeoutMs)
    try {
      const submitted = this.cdp.sendCommand(tabId, 'WebMCP.invokeTool', { frameId: tool.frameId, toolName: tool.name, input }, {
        signal, timeoutMs: this.timeoutMs,
        beforeSend: () => {
          if (finished) throw new Error('webmcp_cancelled')
          if (signal?.aborted) throw new Error('webmcp_cancelled')
          this.requireTool(tabId, tool.frameId, tool.name, tool.registration)
          beforeSend?.()
        },
      }).then(value => {
        const id = record(value).invocationId
        if (typeof id !== 'string') throw new Error('webmcp_invocation_id_missing')
        invocationId = id
        if (finished) { cancelInvocation(id); return response }
        const result = early.get(id)
        early.clear()
        if (result) settle(result)
        return response
      })
      return await Promise.race([submitted, response])
    } finally {
      finished = true
      if (!completed && invocationId) cancelInvocation(invocationId)
      clearTimeout(timer)
      unsubscribe()
      state.pending.delete(cancel)
      signal?.removeEventListener('abort', abort)
    }
  }

  disposeTab(tabId: string): void {
    const state = this.tabs.get(tabId)
    if (!state) return
    this.tabs.delete(tabId)
    state.tools.clear()
    for (const cancel of state.pending) cancel(new Error('webmcp_tab_closed_outcome_unknown'))
    state.unsubscribe()
    void state.release?.().catch(error => console.warn('[webmcp] cleanup failed', error))
  }
}

export function webMcpAvailableForEnvelope(controller: {
  getPhysicalTargetToken(tabId: string): string | null
  webMcp: WebMcpService
} | null, envelope: unknown): boolean {
  if (!controller?.webMcp.enabled) return false
  const hints = record(record(envelope).environmentHints)
  const refs = [hints.browserPageRef, ...(Array.isArray(hints.browserReadRefs) ? hints.browserReadRefs : [])]
  return refs.some(value => {
    const ref = record(value)
    return typeof ref.tabId === 'string' && typeof ref.physicalTargetToken === 'string'
      && typeof ref.mainFrameDocumentToken === 'string'
      && controller.getPhysicalTargetToken(ref.tabId) === ref.physicalTargetToken
      && controller.webMcp.hasTools(ref.tabId)
  })
}
