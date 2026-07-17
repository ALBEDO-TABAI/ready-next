import { isBrowserPublicToolName, type BrowserPublicToolName } from '../../../shared/browser-tool-surface'
import {
  parseBrowserCollectPublicRequest,
  parseBrowserDownloadPublicRequest,
  parseBrowserResearchPublicRequest,
  parseBrowserTaskPublicRequest,
} from './browser-action-contracts'
import { BROWSER_TOOL_SCHEMAS } from './schemas/browser-tool-schemas'

export type BrowserToolOperationGroup = 'act' | 'observe' | 'collection' | 'power' | 'system'
export type BrowserToolInputSource = 'model' | 'trusted_internal'

export type BrowserToolInvocation = {
  ok: true
  group: BrowserToolOperationGroup
  operation: string
  args: Record<string, unknown>
} | {
  ok: false
  errorCode: 'tool_not_registered' | 'invalid_arguments'
  message: string
}

function cleanModelClaims(args: Record<string, unknown>): Record<string, unknown> {
  const {
    expected_effects: _expectedEffects,
    confirmed_via: _confirmedVia,
    kind: _kind,
    payload: _payload,
    executionBinding: _executionBinding,
    allow_partial: _allowPartial,
    unrelated_to_collection: _unrelatedToCollection,
    custom_script: _customScript,
    strategy: _strategy,
    ...trustedArgs
  } = args
  return trustedArgs
}

function invocation(
  group: BrowserToolOperationGroup,
  operation: string,
  args: Record<string, unknown>,
): BrowserToolInvocation {
  return { ok: true, group, operation, args }
}

function invalidInvocation(message: string): BrowserToolInvocation {
  return { ok: false, errorCode: 'invalid_arguments', message }
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

function validateCompoundAction(toolName: BrowserPublicToolName, args: Record<string, unknown>): string | null {
  if (toolName === 'browser_navigate' && String(args.action || 'open') === 'open' && !String(args.url || '').trim()) {
    return 'url is required when browser_navigate action is open'
  }
  if (toolName === 'browser_tabs' && ['switch', 'close'].includes(String(args.action || 'list')) && !String(args.tab_id || '').trim()) {
    return `tab_id is required when browser_tabs action is ${String(args.action)}`
  }
  if (toolName === 'browser_wait') {
    const condition = String(args.condition || '')
    const requiredField = condition === 'selector' ? 'selector' : condition === 'text' ? 'text' : condition === 'url' ? 'url' : null
    if (requiredField && !String(args[requiredField] || '').trim()) {
      return `${requiredField} is required when browser_wait condition is ${condition}`
    }
  }
  return null
}

export function resolveBrowserToolInvocation(
  toolName: string,
  rawArgs: Record<string, unknown> = {},
  inputSource: BrowserToolInputSource = 'trusted_internal',
): BrowserToolInvocation {
  if (!isBrowserPublicToolName(toolName)) {
    return {
      ok: false,
      errorCode: 'tool_not_registered',
      message: `Unknown browser tool: ${toolName}`,
    }
  }

  let args = rawArgs
  if (inputSource === 'model') {
    const cleaned = cleanModelClaims(rawArgs)
    const schema = BROWSER_TOOL_SCHEMAS[toolName as BrowserPublicToolName]
    const shape = schema.shape as Record<string, unknown>
    const unknownKeys = Object.keys(cleaned).filter((key) => !(key in shape))
    if (unknownKeys.length > 0) return invalidInvocation(`unknown arguments: ${unknownKeys.join(', ')}`)
    const parsed = schema.safeParse(cleaned)
    if (!parsed.success) {
      const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ')
      return invalidInvocation(message)
    }
    args = parsed.data as Record<string, unknown>
  }
  const compoundError = validateCompoundAction(toolName as BrowserPublicToolName, args)
  if (compoundError) return invalidInvocation(compoundError)
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

    case 'browser_research': {
      const parsed = parseBrowserResearchPublicRequest(args)
      return parsed.ok ? invocation('collection', 'research_site', args) : invalidInvocation(parsed.message)
    }
    case 'browser_collect': {
      if (inputSource === 'trusted_internal' && args.mode === 'start') {
        const payload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
          ? args.payload as Record<string, unknown>
          : {}
        const kind = String(args.kind || 'visible_collect')
        return kind === 'visible_collect'
          ? invocation('collection', 'collect_visible', payload)
          : invocation('collection', 'task_start_internal', { ...args, kind, payload })
      }
      if (inputSource === 'trusted_internal' && args.mode === 'research') {
        return invocation('collection', 'task_research_internal', args)
      }
      const parsed = parseBrowserCollectPublicRequest(args)
      return parsed.ok
        ? invocation('collection', parsed.value.operation, parsed.value.args)
        : invalidInvocation(parsed.message)
    }
    case 'browser_download': {
      const parsed = parseBrowserDownloadPublicRequest(args)
      if (!parsed.ok) return invalidInvocation(parsed.message)
      const operation = parsed.value.operation
      return invocation(
        operation === 'download_page' || operation === 'download_media' ? 'power' : 'collection',
        operation === 'download_page' || operation === 'download_media' ? 'download_advanced' : operation,
        operation === 'download_page' || operation === 'download_media'
          ? { ...parsed.value.args, page_url: parsed.value.args.url ?? parsed.value.args.page_url }
          : parsed.value.args,
      )
    }
    case 'browser_archive': return invocation('system', 'archive', args)
    case 'browser_task': {
      const parsed = parseBrowserTaskPublicRequest(args)
      return parsed.ok
        ? invocation('collection', parsed.value.operation, parsed.value.args)
        : invalidInvocation(parsed.message)
    }

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
