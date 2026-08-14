/**
 * Browser act facade. Production callers import this file only.
 */
import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import {
  bindTrustedPointerExpected,
  TrustedPointerBlockedError,
} from './browser-input-actions'
import type { BrowserActToolContext } from './browser-act-shared'
import { trustedPointerExpected } from './browser-act-shared'
import { executeBrowserActNavigation } from './browser-act-navigation'
import { executeBrowserActForm, runBrowserFillFormSequence } from './browser-act-form'
import { executeBrowserActTarget } from './browser-act-target'
import { executeBrowserActPointer } from './browser-act-pointer'
import { executeBrowserActUpload } from './browser-act-upload'

export type { BrowserActToolContext } from './browser-act-shared'
export { runBrowserFillFormSequence }

export async function executeBrowserActTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const releaseExpected = bindTrustedPointerExpected(trustedPointerExpected(
    ctx,
    typeof args.tab_id === 'string' ? args.tab_id : null,
  ))
  const next: BrowserActToolContext = {
    ...ctx,
    invokeNested: (operation, input) => executeBrowserActTool(operation, input, next),
  }
  try {
    switch (toolName) {
      case 'tabs_open':
      case 'tabs_switch':
      case 'tabs_close':
      case 'navigate_open':
      case 'navigate_back':
      case 'navigate_forward':
      case 'navigate_reload':
        return await executeBrowserActNavigation(toolName, args, next)
      case 'search':
      case 'fill_form':
      case 'select':
      case 'type_selector':
      case 'type_smart':
      case 'type_compose':
      case 'type_coordinate':
      case 'press_key':
        return await executeBrowserActForm(toolName, args, next)
      case 'click_target':
      case 'type_target':
        return await executeBrowserActTarget(toolName, args, next)
      case 'hover':
      case 'drag':
      case 'click_selector':
      case 'click_text':
      case 'click_coordinate':
      case 'scroll':
        return await executeBrowserActPointer(toolName, args, next)
      case 'upload':
        return await executeBrowserActUpload(toolName, args, next)
      default:
        return `Unknown browser tool: ${toolName}`
    }
  } catch (error) {
    if (error instanceof TrustedPointerBlockedError) return error.output
    const blocked = error && typeof error === 'object'
      ? (error as { blockedOutput?: unknown }).blockedOutput
      : null
    if (blocked && typeof blocked === 'object') {
      return blocked as ToolExecutionOutput
    }
    throw error
  } finally {
    releaseExpected()
  }
}
