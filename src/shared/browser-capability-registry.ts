import type { BrowserPowerEffect } from './browser-power'

export type BrowserOperationMode = 'control' | 'observe' | 'mutate'

export const BROWSER_OPERATION_IDS = [
  'tabs_list', 'tabs_open', 'tabs_switch', 'tabs_close',
  'navigate_open', 'navigate_back', 'navigate_forward', 'navigate_reload',
  'search', 'snapshot', 'find', 'read', 'screenshot', 'screenshot_analyze',
  'wait_ready', 'wait_condition',
  'click_target', 'click_selector', 'click_text', 'click_coordinate',
  'type_target', 'type_selector', 'type_coordinate', 'type_smart',
  'fill_form', 'select', 'hover', 'scroll', 'press_key', 'drag', 'upload',
  'dialog_get', 'dialog_accept', 'dialog_dismiss', 'request_takeover',
  'research_start', 'research_evidence', 'research_complete',
  'collect_images', 'collect_structured', 'collect_scroll', 'collect_visible',
  'download_urls', 'download_advanced', 'download_resolve',
  'archive', 'task_get', 'task_result',
  'status', 'console_list', 'console_clear',
  'network_start', 'network_stop', 'network_list', 'network_details',
  'resources', 'resources_forensics', 'eval', 'cdp',
  'session_status', 'session_clear_origin', 'session_clear_site_data', 'session_switch_profile',
  'permission_status', 'permission_set', 'permission_reset',
] as const

export type BrowserOperationId = (typeof BROWSER_OPERATION_IDS)[number]

export interface BrowserOperationCapability {
  operationId: BrowserOperationId
  handlerGroup: BrowserOperationHandlerGroup
  mode: BrowserOperationMode
  effects: readonly BrowserPowerEffect[]
  requiresWorkflowRoute: boolean
  requiresDocument: boolean
  requiresPageLease: boolean
  requiresOwnerCleanup: boolean
}

export type BrowserOperationHandlerGroup = 'act' | 'observe' | 'collection' | 'power' | 'system'

export interface BrowserCapabilityRegistryEntry {
  operations: readonly BrowserOperationId[]
  resolveOperationId(args: Readonly<Record<string, unknown>>): BrowserOperationId | null
}

function action(args: Readonly<Record<string, unknown>>, fallback: string): string {
  const value = String(args.action || fallback).trim()
  return value || fallback
}

function clickOperation(args: Readonly<Record<string, unknown>>): BrowserOperationId {
  if (typeof args.target_id === 'string' && args.target_id) return 'click_target'
  if (typeof args.selector === 'string' && args.selector) return 'click_selector'
  if (typeof args.text === 'string' && args.text) return 'click_text'
  return 'click_coordinate'
}

function typeOperation(args: Readonly<Record<string, unknown>>): BrowserOperationId {
  if (typeof args.target_id === 'string' && args.target_id) return 'type_target'
  if (typeof args.selector === 'string' && args.selector) return 'type_selector'
  if (Number.isFinite(args.x) && Number.isFinite(args.y)) return 'type_coordinate'
  return 'type_smart'
}

function collectOperation(args: Readonly<Record<string, unknown>>): BrowserOperationId | null {
  const requested = typeof args.mode === 'string' ? args.mode.trim() : ''
  const inferred = requested || (
    args.template || args.fields
      ? 'structured'
      : 'visible'
  )
  return ({
    images: 'collect_images',
    structured: 'collect_structured',
    scroll: 'collect_scroll',
    visible: 'collect_visible',
  } as const)[inferred as 'images' | 'structured' | 'scroll' | 'visible'] || null
}

function downloadOperation(args: Readonly<Record<string, unknown>>): BrowserOperationId | null {
  const mode = String(args.mode || '').trim()
  return ({
    urls: 'download_urls',
    page: 'download_advanced',
    media: 'download_advanced',
    resolve: 'download_resolve',
  } as const)[mode as 'urls' | 'page' | 'media' | 'resolve'] || null
}

/**
 * The exhaustive browser capability registry. Tool exposure, canonical
 * operation identity, ownership mode and base power effects all derive from
 * this table. Unknown tools and unknown operation variants are rejected; no
 * caller may invent a string operation or fall back to a write classification.
 */
export const BROWSER_CAPABILITY_REGISTRY = {
  browser_tabs: { operations: ['tabs_list', 'tabs_open', 'tabs_switch', 'tabs_close'], resolveOperationId: (args) => ({ list: 'tabs_list', open: 'tabs_open', switch: 'tabs_switch', close: 'tabs_close' } as const)[action(args, 'list') as 'list' | 'open' | 'switch' | 'close'] || null },
  browser_navigate: { operations: ['navigate_open', 'navigate_back', 'navigate_forward', 'navigate_reload'], resolveOperationId: (args) => ({ open: 'navigate_open', back: 'navigate_back', forward: 'navigate_forward', reload: 'navigate_reload' } as const)[action(args, 'open') as 'open' | 'back' | 'forward' | 'reload'] || null },
  browser_search: { operations: ['search'], resolveOperationId: () => 'search' },
  browser_snapshot: { operations: ['snapshot'], resolveOperationId: () => 'snapshot' },
  browser_find: { operations: ['find'], resolveOperationId: () => 'find' },
  browser_read: { operations: ['read'], resolveOperationId: () => 'read' },
  browser_screenshot: { operations: ['screenshot', 'screenshot_analyze'], resolveOperationId: (args) => args.analyze === true ? 'screenshot_analyze' : 'screenshot' },
  browser_wait: { operations: ['wait_ready', 'wait_condition'], resolveOperationId: (args) => args.condition || args.duration_ms ? 'wait_condition' : 'wait_ready' },

  browser_click: { operations: ['click_target', 'click_selector', 'click_text', 'click_coordinate'], resolveOperationId: clickOperation },
  browser_type: { operations: ['type_target', 'type_selector', 'type_coordinate', 'type_smart'], resolveOperationId: typeOperation },
  browser_fill_form: { operations: ['fill_form'], resolveOperationId: () => 'fill_form' },
  browser_select: { operations: ['select'], resolveOperationId: () => 'select' },
  browser_hover: { operations: ['hover'], resolveOperationId: () => 'hover' },
  browser_scroll: { operations: ['scroll'], resolveOperationId: () => 'scroll' },
  browser_press_key: { operations: ['press_key'], resolveOperationId: () => 'press_key' },
  browser_drag: { operations: ['drag'], resolveOperationId: () => 'drag' },
  browser_upload: { operations: ['upload'], resolveOperationId: () => 'upload' },
  browser_dialog: { operations: ['dialog_get', 'dialog_accept', 'dialog_dismiss'], resolveOperationId: (args) => ({ get: 'dialog_get', accept: 'dialog_accept', dismiss: 'dialog_dismiss' } as const)[action(args, 'get') as 'get' | 'accept' | 'dismiss'] || null },
  browser_request_takeover: { operations: ['request_takeover'], resolveOperationId: () => 'request_takeover' },

  browser_research: { operations: ['research_start', 'research_evidence', 'research_complete'], resolveOperationId: (args) => ({ start: 'research_start', evidence: 'research_evidence', complete: 'research_complete' } as const)[action(args, 'start') as 'start' | 'evidence' | 'complete'] || null },
  browser_collect: { operations: ['collect_images', 'collect_structured', 'collect_scroll', 'collect_visible'], resolveOperationId: collectOperation },
  browser_download: { operations: ['download_urls', 'download_advanced', 'download_resolve'], resolveOperationId: downloadOperation },
  browser_archive: { operations: ['archive'], resolveOperationId: () => 'archive' },
  browser_task: { operations: ['task_get', 'task_result'], resolveOperationId: (args) => ({ get: 'task_get', result: 'task_result' } as const)[action(args, 'get') as 'get' | 'result'] || null },

  browser_status: { operations: ['status'], resolveOperationId: () => 'status' },
  browser_console: { operations: ['console_list', 'console_clear'], resolveOperationId: (args) => ({ list: 'console_list', clear: 'console_clear' } as const)[action(args, 'list') as 'list' | 'clear'] || null },
  browser_network: { operations: ['network_start', 'network_stop', 'network_list', 'network_details'], resolveOperationId: (args) => ({ start: 'network_start', stop: 'network_stop', list: 'network_list', details: 'network_details' } as const)[action(args, 'list') as 'start' | 'stop' | 'list' | 'details'] || null },
  browser_resources: { operations: ['resources', 'resources_forensics'], resolveOperationId: (args) => args.include_response_bodies === true ? 'resources_forensics' : 'resources' },
  browser_eval: { operations: ['eval'], resolveOperationId: () => 'eval' },
  browser_cdp: { operations: ['cdp'], resolveOperationId: () => 'cdp' },
  browser_session: { operations: ['session_status', 'session_clear_origin', 'session_clear_site_data', 'session_switch_profile'], resolveOperationId: (args) => ({ status: 'session_status', clear_origin: 'session_clear_origin', clear_site_data: 'session_clear_site_data', switch_profile: 'session_switch_profile' } as const)[action(args, 'status') as 'status' | 'clear_origin' | 'clear_site_data' | 'switch_profile'] || null },
  browser_permission: { operations: ['permission_status', 'permission_set', 'permission_reset'], resolveOperationId: (args) => ({ status: 'permission_status', set: 'permission_set', reset: 'permission_reset' } as const)[action(args, 'status') as 'status' | 'set' | 'reset'] || null },
} as const satisfies Record<string, BrowserCapabilityRegistryEntry>

export type BrowserPublicToolName = keyof typeof BROWSER_CAPABILITY_REGISTRY

type BrowserOperationRecord = Omit<BrowserOperationCapability, 'operationId'>
type BrowserBoundaryProfile =
  | 'management'
  | 'workflow_metadata'
  | 'page_observe'
  | 'page_mutate'
  | 'document_control'
  | 'owner_document_control'
  | 'workflow_transport'
  | 'workflow_mutation'

const BROWSER_BOUNDARY_PROFILES: Record<BrowserBoundaryProfile, Pick<BrowserOperationRecord,
  'requiresWorkflowRoute' | 'requiresDocument' | 'requiresPageLease' | 'requiresOwnerCleanup'>> = {
  management: { requiresWorkflowRoute: false, requiresDocument: false, requiresPageLease: false, requiresOwnerCleanup: false },
  workflow_metadata: { requiresWorkflowRoute: true, requiresDocument: false, requiresPageLease: false, requiresOwnerCleanup: false },
  page_observe: { requiresWorkflowRoute: true, requiresDocument: true, requiresPageLease: false, requiresOwnerCleanup: false },
  page_mutate: { requiresWorkflowRoute: true, requiresDocument: true, requiresPageLease: true, requiresOwnerCleanup: false },
  document_control: { requiresWorkflowRoute: true, requiresDocument: true, requiresPageLease: false, requiresOwnerCleanup: false },
  owner_document_control: { requiresWorkflowRoute: true, requiresDocument: true, requiresPageLease: false, requiresOwnerCleanup: true },
  workflow_transport: { requiresWorkflowRoute: true, requiresDocument: false, requiresPageLease: false, requiresOwnerCleanup: false },
  workflow_mutation: { requiresWorkflowRoute: true, requiresDocument: false, requiresPageLease: true, requiresOwnerCleanup: false },
}
const operation = (
  handlerGroup: BrowserOperationHandlerGroup,
  mode: BrowserOperationMode,
  effects: readonly BrowserPowerEffect[],
  boundaries: BrowserBoundaryProfile,
): BrowserOperationRecord => ({ handlerGroup, mode, effects, ...BROWSER_BOUNDARY_PROFILES[boundaries] })

const OPERATION_CAPABILITIES: Readonly<Record<BrowserOperationId, BrowserOperationRecord>> = {
  tabs_list: operation('observe', 'observe', ['observe'], 'management'), tabs_open: operation('act', 'mutate', ['navigate'], 'workflow_transport'), tabs_switch: operation('act', 'mutate', ['navigate'], 'workflow_transport'), tabs_close: operation('act', 'mutate', ['page_mutation'], 'workflow_transport'),
  navigate_open: operation('act', 'mutate', ['navigate'], 'page_mutate'), navigate_back: operation('act', 'mutate', ['navigate'], 'page_mutate'), navigate_forward: operation('act', 'mutate', ['navigate'], 'page_mutate'), navigate_reload: operation('act', 'mutate', ['navigate'], 'page_mutate'),
  search: operation('act', 'mutate', ['page_mutation', 'external_submit'], 'page_mutate'), snapshot: operation('observe', 'observe', ['observe'], 'page_observe'), find: operation('observe', 'observe', ['observe'], 'page_observe'), read: operation('observe', 'observe', ['observe'], 'page_observe'), screenshot: operation('observe', 'observe', ['observe'], 'page_observe'), screenshot_analyze: operation('observe', 'observe', ['observe'], 'page_observe'), wait_ready: operation('observe', 'observe', ['observe'], 'page_observe'), wait_condition: operation('observe', 'observe', ['observe'], 'page_observe'),
  click_target: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), click_selector: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), click_text: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), click_coordinate: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), type_target: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), type_selector: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), type_coordinate: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), type_smart: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), fill_form: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), select: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), hover: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), scroll: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), press_key: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), drag: operation('act', 'mutate', ['page_mutation'], 'page_mutate'), upload: operation('act', 'mutate', ['upload'], 'page_mutate'), dialog_get: operation('system', 'observe', ['observe'], 'page_observe'), dialog_accept: operation('system', 'mutate', ['page_mutation'], 'page_mutate'), dialog_dismiss: operation('system', 'mutate', ['page_mutation'], 'page_mutate'), request_takeover: operation('act', 'control', ['challenge_interaction'], 'document_control'),
  research_start: operation('collection', 'control', ['observe'], 'workflow_metadata'), research_evidence: operation('collection', 'control', ['observe'], 'workflow_metadata'), research_complete: operation('collection', 'observe', ['observe'], 'workflow_metadata'),
  collect_images: operation('collection', 'observe', ['observe'], 'page_observe'), collect_structured: operation('collection', 'observe', ['observe'], 'page_observe'), collect_scroll: operation('collection', 'mutate', ['observe', 'page_mutation'], 'page_mutate'), collect_visible: operation('collection', 'mutate', ['observe', 'page_mutation'], 'page_mutate'),
  download_urls: operation('collection', 'mutate', ['download'], 'workflow_transport'), download_advanced: operation('power', 'mutate', ['download'], 'workflow_transport'), download_resolve: operation('collection', 'observe', ['observe'], 'workflow_metadata'), archive: operation('system', 'mutate', ['download'], 'document_control'), task_get: operation('collection', 'observe', ['observe'], 'workflow_metadata'), task_result: operation('collection', 'observe', ['observe'], 'workflow_metadata'),
  status: operation('observe', 'observe', ['observe'], 'management'), console_list: operation('system', 'observe', ['observe'], 'management'), console_clear: operation('system', 'mutate', ['page_mutation'], 'workflow_transport'), network_start: operation('system', 'control', ['observe'], 'owner_document_control'), network_stop: operation('system', 'control', ['observe'], 'owner_document_control'), network_list: operation('system', 'observe', ['observe'], 'management'), network_details: operation('system', 'observe', ['observe'], 'management'), resources: operation('collection', 'observe', ['observe'], 'page_observe'), resources_forensics: operation('power', 'observe', ['observe'], 'page_observe'), eval: operation('power', 'mutate', ['observe', 'page_mutation'], 'page_mutate'), cdp: operation('power', 'mutate', ['observe', 'page_mutation'], 'page_mutate'), session_status: operation('system', 'observe', ['observe'], 'management'), session_clear_origin: operation('system', 'mutate', ['page_mutation'], 'workflow_transport'), session_clear_site_data: operation('system', 'mutate', ['page_mutation'], 'workflow_transport'), session_switch_profile: operation('system', 'mutate', ['page_mutation'], 'workflow_transport'), permission_status: operation('system', 'observe', ['observe'], 'management'), permission_set: operation('system', 'mutate', ['page_mutation'], 'workflow_transport'), permission_reset: operation('system', 'mutate', ['page_mutation'], 'workflow_transport'),
}

export const BROWSER_PUBLIC_TOOL_NAMES = Object.freeze(
  Object.keys(BROWSER_CAPABILITY_REGISTRY) as BrowserPublicToolName[],
)

export function isBrowserPublicToolName(name: string): name is BrowserPublicToolName {
  return Object.prototype.hasOwnProperty.call(BROWSER_CAPABILITY_REGISTRY, name)
}

export function browserCapabilityEntry(name: string): BrowserCapabilityRegistryEntry | null {
  return isBrowserPublicToolName(name) ? BROWSER_CAPABILITY_REGISTRY[name] : null
}

export function browserOperationCapability(operationId: BrowserOperationId): BrowserOperationCapability {
  const capability = OPERATION_CAPABILITIES[operationId]
  if (!capability) throw new Error(`browser_operation_not_registered:${operationId}`)
  return { operationId, ...capability }
}

export function browserOperationHandlerGroup(operationId: BrowserOperationId): BrowserOperationHandlerGroup {
  return browserOperationCapability(operationId).handlerGroup
}

export function resolveBrowserCapability(
  toolName: string,
  args: Readonly<Record<string, unknown>> = {},
): BrowserOperationCapability | null {
  const entry = browserCapabilityEntry(toolName)
  if (!entry) return null
  const operationId = entry.resolveOperationId(args)
  if (!operationId || !(entry.operations as readonly BrowserOperationId[]).includes(operationId)) return null
  return browserOperationCapability(operationId)
}

export function browserToolBaseEffects(toolName: BrowserPublicToolName): BrowserPowerEffect[] {
  const effects = new Set<BrowserPowerEffect>()
  for (const operationId of BROWSER_CAPABILITY_REGISTRY[toolName].operations) {
    for (const effect of OPERATION_CAPABILITIES[operationId].effects) effects.add(effect)
  }
  return Array.from(effects)
}

/** The first declared operation is the tool's single canonical default. */
export function browserDefaultCapability(toolName: BrowserPublicToolName): BrowserOperationCapability {
  const operationId = BROWSER_CAPABILITY_REGISTRY[toolName].operations[0]
  if (!operationId) throw new Error(`browser_default_operation_missing:${toolName}`)
  return browserOperationCapability(operationId)
}
