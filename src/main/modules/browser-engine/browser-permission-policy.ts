/**
 * Site-permission policy and exact live-request bookkeeping (electron-free).
 */

import type { BrowserWorkflowWriteTarget } from '../../../shared/browser-workflow-control'
import {
  requiresUserApprovalBrowserPermission,
  shouldAllowBrowserPermission,
  supportsBrowserPermissionRequest,
} from './popup-policy'

export interface BrowserSitePermissionNotice {
  kind: 'site_permission_confirmation_required' | 'file_chooser_intercepted'
  requestId?: string
  permission: string
  origin: string
  at: string
  guidance: string
}

export interface BrowserPermissionRequestBinding extends BrowserWorkflowWriteTarget {
  partition: string
}

export type BrowserPermissionRequestState = 'pending' | 'applied' | 'expired'

export interface BrowserSitePermissionRequestReadback {
  requestId: string
  state: BrowserPermissionRequestState
  applied: boolean
  decision: 'allow' | 'deny' | null
  permission: string | null
  origin: string | null
  requestingUrl: string | null
  createdAt: string | null
  appliedAt: string | null
  target: BrowserPermissionRequestBinding | null
}

interface LiveBrowserSitePermissionRequest extends BrowserSitePermissionRequestReadback {
  key: string
  callbacks: Array<(allowed: boolean) => void>
  noticePending: boolean
}

interface BrowserSitePermissionRequestStoreOptions {
  now?: () => Date
  generateId?: () => string
  maxRecords?: number
}

function sameWorkflowTarget(
  left: BrowserWorkflowWriteTarget,
  right: BrowserWorkflowWriteTarget,
): boolean {
  return left.parentTaskId === right.parentTaskId
    && left.ownerRunId === right.ownerRunId
    && left.browserTaskId === right.browserTaskId
    && left.surface === right.surface
    && left.scopeId === right.scopeId
    && left.profileId === right.profileId
    && left.sessionId === right.sessionId
    && left.tabId === right.tabId
    && left.physicalTargetToken === right.physicalTargetToken
}

export function sameBrowserPermissionRequestBinding(
  left: BrowserPermissionRequestBinding,
  right: BrowserPermissionRequestBinding,
): boolean {
  return left.partition === right.partition && sameWorkflowTarget(left, right)
}

/**
 * A site permission can enter the unattended Agent path only when the exact
 * physical tab has both a live workflow binding and the matching live lease.
 */
export function resolveAgentPermissionRequestBinding(input: {
  partition: string
  tabId: string | null
  physicalTargetToken: string | null
  workflowTarget: BrowserWorkflowWriteTarget | null
  lease: {
    surface: BrowserWorkflowWriteTarget['surface']
    taskId: string
    runId: string
    tabId: string | null
  } | null
  writeAdmitted: boolean
}): BrowserPermissionRequestBinding | null {
  const target = input.workflowTarget
  const lease = input.lease
  if (
    !input.partition
    || !input.tabId
    || !input.physicalTargetToken
    || !target
    || !lease
    || !input.writeAdmitted
  ) return null
  if (
    target.tabId !== input.tabId
    || target.physicalTargetToken !== input.physicalTargetToken
    || lease.surface !== target.surface
    || lease.tabId !== target.tabId
    || lease.taskId !== target.parentTaskId
    || lease.runId !== target.ownerRunId
  ) return null
  return { partition: input.partition, ...target }
}

function permissionRequestKey(input: {
  permission: string
  origin: string
  target: BrowserPermissionRequestBinding
}): string {
  return JSON.stringify([
    input.target.partition,
    input.target.tabId,
    input.permission,
    input.origin,
    input.target.physicalTargetToken,
    input.target.parentTaskId,
    input.target.ownerRunId,
    input.target.browserTaskId,
    input.target.scopeId,
  ])
}

function expiredReadback(requestId: string): BrowserSitePermissionRequestReadback {
  return {
    requestId,
    state: 'expired',
    applied: false,
    decision: null,
    permission: null,
    origin: null,
    requestingUrl: null,
    createdAt: null,
    appliedAt: null,
    target: null,
  }
}

function publicReadback(record: LiveBrowserSitePermissionRequest): BrowserSitePermissionRequestReadback {
  return {
    requestId: record.requestId,
    state: record.state,
    applied: record.applied,
    decision: record.decision,
    permission: record.permission,
    origin: record.origin,
    requestingUrl: record.requestingUrl,
    createdAt: record.createdAt,
    appliedAt: record.appliedAt,
    target: record.target ? { ...record.target } : null,
  }
}

/**
 * Runtime-only request store. Callbacks are deliberately never persisted: a
 * request ID restored in another process reads as expired instead of claiming
 * that a browser decision was applied without a live Electron callback.
 */
export class BrowserSitePermissionRequestStore {
  private readonly records = new Map<string, LiveBrowserSitePermissionRequest>()
  private readonly pendingByKey = new Map<string, string>()
  private readonly now: () => Date
  private readonly generateId: () => string
  private readonly maxRecords: number
  private nextId = 0

  constructor(options: BrowserSitePermissionRequestStoreOptions = {}) {
    this.now = options.now || (() => new Date())
    this.generateId = options.generateId || (() => `browser-permission-${++this.nextId}`)
    this.maxRecords = Math.max(8, options.maxRecords || 64)
  }

  queue(input: {
    permission: string
    origin: string
    requestingUrl: string
    target: BrowserPermissionRequestBinding
    callback: (allowed: boolean) => void
  }): BrowserSitePermissionRequestReadback {
    const permission = String(input.permission || '').toLowerCase()
    const key = permissionRequestKey({ permission, origin: input.origin, target: input.target })
    const existingId = this.pendingByKey.get(key)
    const existing = existingId ? this.records.get(existingId) : null
    if (existing?.state === 'pending') {
      existing.callbacks.push(input.callback)
      return publicReadback(existing)
    }
    const createdAt = this.now().toISOString()
    const record: LiveBrowserSitePermissionRequest = {
      requestId: this.generateId(),
      state: 'pending',
      applied: false,
      decision: null,
      permission,
      origin: input.origin,
      requestingUrl: input.requestingUrl,
      createdAt,
      appliedAt: null,
      target: { ...input.target },
      key,
      callbacks: [input.callback],
      noticePending: true,
    }
    this.records.set(record.requestId, record)
    this.pendingByKey.set(key, record.requestId)
    this.prune()
    return publicReadback(record)
  }

  read(
    requestId: string,
    isCurrent: (target: BrowserPermissionRequestBinding) => boolean,
  ): BrowserSitePermissionRequestReadback {
    const record = this.records.get(requestId)
    if (!record) return expiredReadback(requestId)
    if (
      record.state === 'pending'
      && (!record.target || record.callbacks.length === 0 || !isCurrent(record.target))
    ) this.expireRecord(record)
    return publicReadback(record)
  }

  apply(
    requestId: string,
    decision: 'allow' | 'deny',
    isCurrent: (target: BrowserPermissionRequestBinding) => boolean,
  ): BrowserSitePermissionRequestReadback {
    const record = this.records.get(requestId)
    if (!record) return expiredReadback(requestId)
    if (record.state === 'applied') {
      return record.decision === decision ? publicReadback(record) : expiredReadback(requestId)
    }
    if (
      record.state !== 'pending'
      || !record.target
      || record.callbacks.length === 0
      || !isCurrent(record.target)
    ) {
      this.expireRecord(record)
      return publicReadback(record)
    }
    const callbacks = record.callbacks.splice(0)
    let callbackFailed = false
    for (const callback of callbacks) {
      try { callback(decision === 'allow') } catch { callbackFailed = true }
    }
    if (callbackFailed) {
      this.expireRecord(record, false)
      return publicReadback(record)
    }
    this.pendingByKey.delete(record.key)
    record.state = 'applied'
    record.applied = true
    record.decision = decision
    record.appliedAt = this.now().toISOString()
    record.noticePending = false
    return publicReadback(record)
  }

  consumeNotices(
    target: BrowserWorkflowWriteTarget,
    isCurrent: (binding: BrowserPermissionRequestBinding) => boolean,
  ): BrowserSitePermissionNotice[] {
    const notices: BrowserSitePermissionNotice[] = []
    for (const record of this.records.values()) {
      if (record.state !== 'pending' || !record.target || !sameWorkflowTarget(record.target, target)) continue
      if (!isCurrent(record.target)) {
        this.expireRecord(record)
        continue
      }
      if (!record.noticePending) continue
      record.noticePending = false
      notices.push({
        kind: 'site_permission_confirmation_required',
        requestId: record.requestId,
        permission: record.permission || '',
        origin: record.origin || '',
        at: record.createdAt || this.now().toISOString(),
        guidance: 'A live site permission request is waiting for an exact user decision. Use browser_permission with this site_request_id; do not infer a decision.',
      })
    }
    return notices
  }

  expireForTab(tabId: string): void {
    for (const record of this.records.values()) {
      if (record.state === 'pending' && record.target?.tabId === tabId) this.expireRecord(record)
    }
  }

  private expireRecord(record: LiveBrowserSitePermissionRequest, denyCallbacks = true): void {
    if (record.state !== 'pending') return
    this.pendingByKey.delete(record.key)
    const callbacks = record.callbacks.splice(0)
    if (denyCallbacks) {
      for (const callback of callbacks) {
        try { callback(false) } catch { /* callback failure cannot revive an expired request. */ }
      }
    }
    record.state = 'expired'
    record.applied = false
    record.decision = null
    record.appliedAt = null
    record.noticePending = false
  }

  private prune(): void {
    if (this.records.size <= this.maxRecords) return
    for (const [requestId, record] of this.records) {
      if (this.records.size <= this.maxRecords) return
      if (record.state === 'pending') continue
      this.records.delete(requestId)
    }
    for (const [requestId, record] of this.records) {
      if (this.records.size <= this.maxRecords) return
      this.expireRecord(record)
      this.records.delete(requestId)
    }
  }
}

export type BrowserPermissionPath =
  | 'unsupported_deny'
  | 'auto_allow'
  | 'policy_deny'
  | 'cached_allow'
  | 'cached_deny'
  | 'agent_suspend'
  | 'prompt'

export function resolveBrowserPermissionPath(params: {
  permission: string
  requestingUrl: string
  cachedDecision: boolean | undefined
  agentDriveActive: boolean
}): BrowserPermissionPath {
  if (!supportsBrowserPermissionRequest(params.permission)) return 'unsupported_deny'
  if (shouldAllowBrowserPermission(params.permission, params.requestingUrl)) return 'auto_allow'
  if (!requiresUserApprovalBrowserPermission(params.permission)) return 'policy_deny'
  if (params.cachedDecision === true) return 'cached_allow'
  if (params.cachedDecision === false) return 'cached_deny'
  if (params.agentDriveActive) return 'agent_suspend'
  return 'prompt'
}
