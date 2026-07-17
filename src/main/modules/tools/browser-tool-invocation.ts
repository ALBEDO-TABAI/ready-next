import { isBrowserPublicToolName, type BrowserPublicToolName } from '../../../shared/browser-tool-surface'

export type BrowserToolOperationGroup = 'act' | 'observe' | 'collection' | 'power' | 'system'

export type BrowserToolInvocation = {
  ok: true
  group: BrowserToolOperationGroup
  operation: string
  args: Record<string, unknown>
} | {
  ok: false
  errorCode: 'tool_not_registered'
  message: string
}

function cleanModelClaims(args: Record<string, unknown>): Record<string, unknown> {
  const {
    expected_effects: _expectedEffects,
    confirmed_via: _confirmedVia,
    ...trustedArgs
  } = args
  return trustedArgs
}

function invocation(
  group: BrowserToolOperationGroup,
  operation: string,
  args: Record<string, unknown>,
): BrowserToolInvocation {
  return { ok: true, group, operation, args: cleanModelClaims(args) }
}

function clickOperation(args: Record<string, unknown>): string {
  if (typeof args.target_id === 'string' && args.target_id) return 'click_target'
  if (typeof args.selector === 'string' && args.selector) return 'click_selector'
  if (typeof args.text === 'string' && args.text) return 'click_text'
  return 'click_coordinate'
}

function typeOperation(args: Record<string, unknown>): string {
  if (typeof args.target_id === 'string' && args.target_id) return 'type_target'
  if (typeof args.selector === 'string' && args.selector) return 'type_selector'
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) return 'type_coordinate'
  return 'type_smart'
}

function collectOperation(args: Record<string, unknown>): string {
  const requested = String(args.mode || '').trim()
  if (requested) return `collect_${requested}`
  if (typeof args.source_task_id === 'string') return 'collect_notes'
  if (args.template || args.schema) return 'collect_structured'
  if (Array.isArray(args.urls)) return 'collect_notes'
  return 'collect_visible'
}

function downloadOperation(args: Record<string, unknown>): string {
  const requested = String(args.mode || '').trim()
  if (requested) return `download_${requested}`
  if (typeof args.source_task_id === 'string') return 'download_collected'
  if (Array.isArray(args.urls)) return 'download_urls'
  return 'download_page'
}

export function resolveBrowserToolInvocation(
  toolName: string,
  rawArgs: Record<string, unknown> = {},
): BrowserToolInvocation {
  if (!isBrowserPublicToolName(toolName)) {
    return {
      ok: false,
      errorCode: 'tool_not_registered',
      message: `Unknown browser tool: ${toolName}`,
    }
  }

  const args = cleanModelClaims(rawArgs)
  switch (toolName as BrowserPublicToolName) {
    case 'browser_tabs': {
      const action = String(args.action || 'list')
      return invocation(action === 'list' ? 'observe' : 'act', `tabs_${action}`, args)
    }
    case 'browser_navigate':
      return invocation('act', `navigate_${String(args.action || 'open')}`, args)
    case 'browser_search': return invocation('act', 'search', args)
    case 'browser_snapshot': return invocation('observe', 'snapshot', args)
    case 'browser_find': {
      const purpose = String(args.purpose || 'any')
      if (purpose === 'input') return invocation('observe', 'find_input', args)
      if (purpose === 'upload') return invocation('act', 'find_upload', args)
      if (purpose === 'action' || purpose === 'send') {
        return invocation('observe', 'find_action', { ...args, action: purpose === 'send' ? 'send' : (args.action || 'send') })
      }
      return invocation('observe', 'find', args)
    }
    case 'browser_read': return invocation('observe', 'read', args)
    case 'browser_screenshot': return invocation('observe', args.analyze ? 'screenshot_analyze' : 'screenshot', args)
    case 'browser_wait':
      return invocation('observe', args.condition || args.duration_ms ? 'wait_condition' : 'wait_ready', args)

    case 'browser_click':
      return invocation('act', clickOperation(args), {
        ...args,
        ...(typeof args.target_id === 'string' ? { action: 'click' } : {}),
      })
    case 'browser_type': return invocation('act', typeOperation(args), args)
    case 'browser_fill_form': return invocation('act', 'fill_form', args)
    case 'browser_select': return invocation('act', 'select', args)
    case 'browser_hover': return invocation('act', 'hover', args)
    case 'browser_scroll': return invocation('act', 'scroll', args)
    case 'browser_press_key': return invocation('act', 'press_key', args)
    case 'browser_drag': return invocation('act', 'drag', args)
    case 'browser_upload': return invocation('act', 'upload', args)
    case 'browser_dialog': {
      const action = String(args.action || 'get')
      return invocation(action === 'get' ? 'system' : 'system', `dialog_${action}`, args)
    }
    case 'browser_request_takeover': return invocation('act', 'request_takeover', args)

    case 'browser_collect': return invocation('collection', collectOperation(args), args)
    case 'browser_download': {
      const operation = downloadOperation(args)
      return invocation(
        operation === 'download_page' || operation === 'download_media' ? 'power' : 'collection',
        operation === 'download_page' || operation === 'download_media' ? 'download_advanced' : operation,
        operation === 'download_page' || operation === 'download_media'
          ? { ...args, page_url: args.url }
          : args,
      )
    }
    case 'browser_archive': return invocation('system', 'archive', args)
    case 'browser_task': return invocation('collection', `task_${String(args.action || 'get')}`, args)

    case 'browser_status': return invocation('observe', 'status', args)
    case 'browser_console': return invocation('system', `console_${String(args.action || 'list')}`, args)
    case 'browser_network': return invocation('system', `network_${String(args.action || 'list')}`, args)
    case 'browser_resources': return invocation(
      args.include_response_bodies ? 'power' : 'collection',
      args.include_response_bodies ? 'resources_forensics' : 'resources',
      args,
    )
    case 'browser_eval': return invocation('power', 'eval', args)
    case 'browser_cdp': return invocation('power', 'cdp', args)
    case 'browser_session': return invocation('system', `session_${String(args.action || 'status')}`, args)
    case 'browser_permission': return invocation('system', `permission_${String(args.action || 'status')}`, args)
  }
}
