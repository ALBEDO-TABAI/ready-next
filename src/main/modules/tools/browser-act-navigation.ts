import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput as browserStructuredOutput, stringifyBrowserJsonOrFailure } from './browser-failure-output'
import type { BrowserActToolContext } from './browser-act-shared'
import {
  confirmLivePasswordFill,
  didBrowserActionChange,
  frameViewportOffset,
  invokeTargetFormSubmit,
  logBrowserAct,
  normalizedTargetPoint,
  readBrowserActionDeltaBestEffort,
  readTransientPageNotices,
  retainCompositeTrustedInputSequence,
  sameTargetFingerprint,
  snapshotBrowserTabs,
  submitResolvedTargetForm,
  trustedPointerExpected,
  waitForActionFollowedTab,
} from './browser-act-shared'
import { existsSync } from 'fs'
import { createHash } from 'node:crypto'
import { captureBrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { AgentRepository } from '../repositories/agent-repository'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService, parseBrowserSnapshotRef } from '../browser-engine/browser-snapshot-service'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import {
  buildBrowserBlockingChallengeProbeJs,
  buildFocusedEditableProbeJs,
  buildBrowserTargetProbeJs,
  throwIfLiveTargetGuardBlocked,
  normalizeBrowserBlockingChallengeProbe,
  probeCoordinateTargetOrThrow,
  callBrowserBackendTarget,
} from './browser-probe'
import { browserInputEnvironmentReadiness } from '../browser-engine/browser-input-readiness'
import {
  buildSmartTypeProbeJs,
  resolveCssPoint,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  runGuardedTargetType,
  runGuardedSelectorClick,
  runGuardedSelectorType,
  sendKeyStroke,
  settleAfterAction,
  sleepWithAbort,
  throwIfAborted,
  dispatchTrustedPointer,
  dispatchTrustedText,
  pointerPhaseFailure,
  pointerPhaseOutput,
  trustedInputPageDenied,
  TrustedPointerBlockedError,
  waitForReady,
} from './browser-input-actions'
import { buildBrowserEnvironmentSummary } from '../browser-engine/browser-action-receipt'
import {
  describeComposedPointTarget,
  scanClosedShadowHostForClickPoint,
} from './browser-shadow-hit-test'
import {
  captureAgentPageMap,
  currentBrowserPageMapAmbiguity,
  DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
} from './browser-observe-tools'
import {
  activeBrowserToolUrl,
  activePageLikelyMatchesTarget,
  browserStructuredErrorOutput,
  listSubframesSafe,
  locateActionTargets,
  resolveToolContextMeta,
  uniqueStrings,
} from './browser-tool-shared'

export async function executeBrowserActNavigation(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, mutationBoundary, attachBrowserToolOutput } = ctx
  switch (toolName) {
      case 'tabs_open': {
        const url = String(args.url || 'about:blank')
        const created = ctx.agentOwnedWorkTab
          ? await controller.createAgentWorkTab(ctx.agentOwnedWorkTab.browserTaskId, url, String(args.opener_tab_id || args.tab_id || ''))
          : await controller.createTab(url, {
              background: args.background === true,
              openerTabId: typeof args.opener_tab_id === 'string' ? args.opener_tab_id : null,
            })
        if (ctx.agentOwnedWorkTab && created.success && created.tabId) {
          await controller.waitForCondition(created.tabId, { condition: 'page_readable', timeoutMs: 15_000 }, abortSignal)
        }
        return JSON.stringify(created, null, 2)
      }

      case 'tabs_switch': {
        const tabId = String(args.tab_id || '')
        if (!tabId) return 'Error: tab_id is required'
        if (ctx.agentOwnedWorkTab) {
          return JSON.stringify(controller.selectTaskWorkTab(ctx.agentOwnedWorkTab.browserTaskId, tabId), null, 2)
        }
        return JSON.stringify(controller.switchTab(tabId), null, 2)
      }

      case 'tabs_close': {
        const tabId = String(args.tab_id || '')
        if (!tabId) return 'Error: tab_id is required'
        if (ctx.agentOwnedWorkTab && !controller.getTaskWorkTabIds(ctx.agentOwnedWorkTab.browserTaskId).includes(tabId)) {
          return browserStructuredOutput({ ok: false, errorKind: 'browser_task_tab_not_owned' })
        }
        return JSON.stringify(controller.closeTab(tabId), null, 2)
      }

      case 'navigate_open': {
        const url = args.url as string
        if (!url) return 'Error: url is required'
        // Tool-layer tab targeting (plan §7.8): navigate the given tab when set
        // (the scoped agent facade forces agentTabId), else the active tab.
        const navTabId = (args.tab_id as string) || null
        const allowRepeat = args.allow_repeat === true
        const duplicate = !allowRepeat
          ? findRecentBrowserAction(
            sessionId,
            'navigate',
            url,
            45_000,
            { messageVisibilityEpoch: ctx.messageVisibilityEpoch },
          )
          : null
        const activeBefore = navTabId
          ? controller.getTabList().find((t) => t.id === navTabId)
          : controller.getActiveTab()
        if (duplicate && activePageLikelyMatchesTarget(activeBefore?.url, url)) {
          const secondsAgo = Math.max(1, Math.round((Date.now() - duplicate.updatedAt) / 1000))
          return browserStructuredOutput({ ok: false, errorKind: 'duplicate_navigation', skipped: true, delivery: 'not_delivered', message: `Skipped duplicate navigation to ${url}. The same navigation already succeeded ${secondsAgo}s ago and the current page still matches it. Read or verify the current page before navigating again.` })
        }
        const result = await controller.navigate(navTabId, url)
        if (!result.success) return `Error: ${result.error}`
        rememberBrowserAction(sessionId, 'navigate', url, {
          messageVisibilityEpoch: ctx.messageVisibilityEpoch,
        })
        // Wait a moment for page to start loading
        await sleepWithAbort(1500, abortSignal)
        const tabs = controller.getTabList()
        const target = navTabId ? tabs.find((t) => t.id === navTabId) : tabs.find((t) => t.active)
        const confirmation = null
        return attachBrowserToolOutput(
          `Navigated to ${url}\nCurrent page: ${target?.title || 'Loading...'} (${target?.url || url})`,
          {
            toolName,
            args,
            controller,
            sessionId,
            tabId: target?.id || navTabId,
            confirmation,
            nextSuggestedAction: confirmation ? 'finish with transaction proof' : 'read map again',
          },
        )
      }

      case 'navigate_back': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goBack(tabId)
        if (!result.success) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_operation_failed',
            message: result.error || 'cannot go back',
          })
        }
        return 'Navigated back.'
      }

      case 'navigate_forward': {
        const tabId = (args.tab_id as string) || null
        const result = controller.goForward(tabId)
        if (!result.success) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_operation_failed',
            message: result.error || 'cannot go forward',
          })
        }
        return 'Navigated forward.'
      }

      case 'navigate_reload': {
        const tabId = (args.tab_id as string) || null
        const result = controller.reload(tabId)
        if (!result.success) {
          return browserStructuredOutput({
            ok: false,
            errorKind: 'browser_operation_failed',
            message: result.error || 'cannot reload page',
          })
        }
        return 'Reloaded page.'
      }

    default:
      return `Unknown browser tool: ${toolName}`
  }
}
