/**
 * ScopedBrowserFacade — the only way the browser-collector sub-agent touches the
 * browser (plan §3.4, Codex R2 #1 / R3).
 *
 * A driver action never calls `browser_*` directly; instead the native
 * browser-collector action handler runs its per-note sequence through this
 * facade, which binds every call to:
 *   - a fixed target tab (agent tab for agent-view, visible source tab for
 *     user-view — forced as `tab_id`, never null/active),
 *   - the matching write lease,
 *   - the `AgentTabControlGate` (freeze when the user is interrupting),
 *   - a curated collection subset (read/write/targetable),
 * and rejects the url-form of collect/extract tools that would otherwise route
 * through openTarget and steal the foreground (Codex R3).
 *
 * The executeBrowserTool dispatcher is injected so the scoping is unit-testable
 * without Electron.
 */

import { agentBrowserError } from './agent-browser-errors'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import type { AgentTabControlGate } from './agent-tab-control-gate'
import { classifyBrowserToolCall } from './browser-tool-write-classification'
import { resolveBrowserToolSurfaceBinding } from './browser-surface-binding'

export type ExecuteBrowserToolFn = (
  toolName: string,
  args: Record<string, unknown>,
  leaseGateSurface: AgentBrowserSurface,
  leaseId: string,
) => Promise<string>

/** Collection subset the collector may call inside its scoped tab (targetable). */
export const AGENT_COLLECTOR_TOOL_SUBSET: readonly string[] = [
  'browser_navigate',
  'browser_get_tabs',
  'browser_read_page',
  'browser_capture_viewport',
  'browser_scroll_at',
  'browser_click_text',
  'browser_wait',
  'browser_wait_for_condition',
  'browser_collect_images',
  'browser_resolve_video',
  'browser_extract_structured',
  'browser_scroll_collect',
  'browser_visible_collect',
  'browser_download_urls',
  'browser_aggregate_results',
  'browser_go_back',
]

/** Tools whose `url` arg would route through openTarget and steal the foreground. */
const URL_FORM_FORBIDDEN = new Set([
  'browser_visible_collect',
  'browser_extract_structured',
  'browser_scroll_collect',
])

export interface ScopedBrowserFacadeOptions {
  agentTabId: string
  leaseService: BrowserWriteLeaseService
  leaseId: string
  controlGate: AgentTabControlGate
  surface?: AgentBrowserSurface
  allowedTools?: ReadonlySet<string>
  /** Injected dispatcher (executeBrowserTool bound to the agent controller). */
  execute: ExecuteBrowserToolFn
}

export class ScopedBrowserFacade {
  private readonly surface: AgentBrowserSurface
  private readonly allowed: ReadonlySet<string>

  constructor(private readonly opts: ScopedBrowserFacadeOptions) {
    this.surface = opts.surface ?? 'agent-view'
    this.allowed = opts.allowedTools ?? new Set(AGENT_COLLECTOR_TOOL_SUBSET)
  }

  async run(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    // 1. Subset allow-list: the sub-agent can only call collection tools.
    if (!this.allowed.has(toolName)) {
      return JSON.stringify(
        agentBrowserError('script_blocked', `工具 ${toolName} 不在采集子集，子 agent 不可调用。`, { tool: toolName }),
      )
    }
    // 2. Freeze: a pending/confirmed user interruption blocks agent writes.
    const effect = classifyBrowserToolCall(toolName, args)
    if (this.surface === 'agent-view' && effect === 'write' && this.opts.controlGate.isWriteBlocked()) {
      return JSON.stringify(
        agentBrowserError('lease_takeover', 'Agent 写入已冻结，等待用户二级确认。', {
          controlState: this.opts.controlGate.getState(),
        }),
      )
    }
    // 3. Reject url-form that would steal the foreground (Codex R3).
    if (URL_FORM_FORBIDDEN.has(toolName) && typeof args.url === 'string' && args.url.trim().length > 0) {
      return JSON.stringify(
        agentBrowserError('script_blocked', `${toolName} 在 agent 标签页内禁止 url 形态，请先 navigate(agentTabId) 再按 tabId 采集。`, { tool: toolName }),
      )
    }
    // 4. Force the scoped tab as the only target (writes/reads never hit active).
    //    browser_navigate keeps its url (it navigates the scoped tab); the
    //    url-form collect tools were already rejected in step 3.
    const scopedArgs: Record<string, unknown> = {
      ...args,
      tab_id: this.opts.agentTabId,
      collection_surface: this.surface,
    }
    // 5. Require the scoped code-derived surface binding before dispatch.
    const surfaceBinding = resolveBrowserToolSurfaceBinding({
      toolName,
      args: scopedArgs,
      dispatch: 'scoped-facade',
      scopedSurface: this.surface,
      agentTabId: this.opts.agentTabId,
    })
    if (!surfaceBinding.ok) return JSON.stringify(surfaceBinding.error)
    // 6. Dispatch under the matching lease.
    return this.opts.execute(toolName, scopedArgs, this.surface, this.opts.leaseId)
  }
}
