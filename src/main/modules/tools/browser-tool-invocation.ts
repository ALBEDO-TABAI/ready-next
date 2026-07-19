import {
  browserOperationHandlerGroup,
  isBrowserPublicToolName,
  resolveBrowserCapability,
  type BrowserOperationHandlerGroup,
  type BrowserOperationId,
  type BrowserPublicToolName,
} from '../../../shared/browser-capability-registry'
import {
  parseBrowserCollectPublicRequest,
  parseBrowserDownloadPublicRequest,
  parseBrowserResearchPublicRequest,
  parseBrowserTaskPublicRequest,
} from './browser-action-contracts'
import { BROWSER_TOOL_SCHEMAS } from './schemas/browser-tool-schemas'

export type BrowserToolOperationGroup = BrowserOperationHandlerGroup
export type BrowserToolInputSource = 'model' | 'trusted_internal'

export type BrowserToolInvocation = {
  ok: true
  group: BrowserToolOperationGroup
  operation: BrowserOperationId
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

function invalidInvocation(message: string): BrowserToolInvocation {
  return { ok: false, errorCode: 'invalid_arguments', message }
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
  const publicToolName = toolName as BrowserPublicToolName
  const compoundError = validateCompoundAction(publicToolName, args)
  if (compoundError) return invalidInvocation(compoundError)
  let dispatchArgs = args
  switch (publicToolName) {
    case 'browser_research': {
      const parsed = parseBrowserResearchPublicRequest(args)
      if (!parsed.ok) return invalidInvocation(parsed.message)
      break
    }
    case 'browser_collect': {
      const parsed = parseBrowserCollectPublicRequest(args)
      if (!parsed.ok) return invalidInvocation(parsed.message)
      dispatchArgs = parsed.value.args
      break
    }
    case 'browser_download': {
      const parsed = parseBrowserDownloadPublicRequest(args)
      if (!parsed.ok) return invalidInvocation(parsed.message)
      dispatchArgs = parsed.value.mode === 'page' || parsed.value.mode === 'media'
        ? { ...parsed.value.args, page_url: parsed.value.args.url ?? parsed.value.args.page_url }
        : parsed.value.args
      break
    }
    case 'browser_task': {
      const parsed = parseBrowserTaskPublicRequest(args)
      if (!parsed.ok) return invalidInvocation(parsed.message)
      dispatchArgs = parsed.value.args
      break
    }
    default:
      if (publicToolName === 'browser_click' && typeof args.target_id === 'string') {
        dispatchArgs = { ...args, action: 'click' }
      }
  }

  const capability = resolveBrowserCapability(publicToolName, dispatchArgs)
  if (!capability) {
    return {
      ok: false,
      errorCode: 'tool_not_registered',
      message: `Browser operation is not registered: ${publicToolName}`,
    }
  }
  return {
    ok: true,
    group: browserOperationHandlerGroup(capability.operationId),
    operation: capability.operationId,
    args: dispatchArgs,
  }
}
