import { randomUUID } from 'crypto'

import { BrowserRepository } from '../repositories/browser-repository'

export type BrowserCollectionConsentKind = 'partial_collection'
export type BrowserCollectionConsentVia = 'ui_action'

export interface BrowserCollectionConsentRecord {
  scopeId: string
  sourceTaskId: string
  consentKind: BrowserCollectionConsentKind
  confirmedVia: BrowserCollectionConsentVia
  confirmedAt: string
  targetHost?: string
  warningText?: string
}

export interface PendingBrowserCollectionConsentRequest {
  requestId: string
  scopeId: string
  sourceTaskId: string
  consentKind: BrowserCollectionConsentKind
  createdAt: string
  expiresAt?: string
  targetHost?: string
  warningText?: string
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

function consentKey(kind: BrowserCollectionConsentKind, scopeId: string, sourceTaskId: string, host = ''): string {
  return ['browser_collection_consent', kind, scopeId || 'global', sourceTaskId, normalizeHost(host)].join(':')
}

function pendingKey(requestId: string): string {
  return ['browser_collection_pending', requestId].join(':')
}

function pendingIndexKey(kind: BrowserCollectionConsentKind, scopeId: string, sourceTaskId: string, host = ''): string {
  return ['browser_collection_pending_index', kind, scopeId || 'global', sourceTaskId, normalizeHost(host)].join(':')
}

function parseJSON<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export class BrowserCollectionConsentStore {
  constructor(private readonly repository = new BrowserRepository()) {}

  hasConsent(kind: BrowserCollectionConsentKind, scopeId: string, sourceTaskId: string, host = ''): boolean {
    const record = this.readConsent(kind, scopeId, sourceTaskId, host)
    return Boolean(record?.confirmedAt && record.consentKind === kind)
  }

  readConsent(kind: BrowserCollectionConsentKind, scopeId: string, sourceTaskId: string, host = ''): BrowserCollectionConsentRecord | null {
    return parseJSON<BrowserCollectionConsentRecord | null>(
      this.repository.getSetting(consentKey(kind, scopeId, sourceTaskId, host)),
      null,
    )
  }

  createPendingRequest(input: {
    scopeId: string
    sourceTaskId: string
    consentKind: BrowserCollectionConsentKind
    targetHost?: string
    warningText?: string
    ttlMs?: number
  }): PendingBrowserCollectionConsentRequest {
    const scopeId = input.scopeId.trim()
    const sourceTaskId = input.sourceTaskId.trim()
    const targetHost = normalizeHost(input.targetHost || '')
    const existingRequestId = this.repository.getSetting(pendingIndexKey(input.consentKind, scopeId, sourceTaskId, targetHost))
    const existing = existingRequestId ? this.readPendingRequest(existingRequestId) : null
    if (existing) return existing

    const now = new Date()
    const request: PendingBrowserCollectionConsentRequest = {
      requestId: `browser-consent-${randomUUID()}`,
      scopeId,
      sourceTaskId,
      consentKind: input.consentKind,
      createdAt: now.toISOString(),
      ...(input.ttlMs && input.ttlMs > 0 ? { expiresAt: new Date(now.getTime() + input.ttlMs).toISOString() } : {}),
      ...(targetHost ? { targetHost } : {}),
      ...(input.warningText ? { warningText: input.warningText } : {}),
    }
    this.repository.setSetting(pendingKey(request.requestId), JSON.stringify(request))
    this.repository.setSetting(pendingIndexKey(input.consentKind, scopeId, sourceTaskId, targetHost), request.requestId)
    return request
  }

  readPendingRequest(requestId: string): PendingBrowserCollectionConsentRequest | null {
    const request = parseJSON<PendingBrowserCollectionConsentRequest | null>(
      this.repository.getSetting(pendingKey(requestId.trim())),
      null,
    )
    if (!request) return null
    if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now()) return null
    return request
  }

  confirmPendingRequest(requestId: string): BrowserCollectionConsentRecord | null {
    const request = this.readPendingRequest(requestId)
    if (!request) return null
    const record: BrowserCollectionConsentRecord = {
      scopeId: request.scopeId,
      sourceTaskId: request.sourceTaskId,
      consentKind: request.consentKind,
      confirmedVia: 'ui_action',
      confirmedAt: new Date().toISOString(),
      ...(request.targetHost ? { targetHost: request.targetHost } : {}),
      ...(request.warningText ? { warningText: request.warningText } : {}),
    }
    this.repository.setSetting(consentKey(record.consentKind, record.scopeId, record.sourceTaskId, record.targetHost || ''), JSON.stringify(record))
    this.repository.deleteSetting(pendingKey(request.requestId))
    this.repository.deleteSetting(pendingIndexKey(request.consentKind, request.scopeId, request.sourceTaskId, request.targetHost || ''))
    return record
  }

  deleteByScope(scopeId: string): number {
    const normalizedScopeId = scopeId.trim()
    if (!normalizedScopeId) return 0
    let removed = 0
    const settings = this.repository.getAllSettings()
    for (const [key, value] of Object.entries(settings)) {
      if (key.startsWith('browser_collection_consent:')) {
        const parts = key.split(':')
        if (parts[2] === normalizedScopeId) {
          this.repository.deleteSetting(key)
          removed += 1
        }
        continue
      }
      if (key.startsWith('browser_collection_pending_index:')) {
        const parts = key.split(':')
        if (parts[2] === normalizedScopeId) {
          this.repository.deleteSetting(key)
          removed += 1
        }
        continue
      }
      if (key.startsWith('browser_collection_pending:')) {
        const request = parseJSON<PendingBrowserCollectionConsentRequest | null>(value, null)
        if (request?.scopeId === normalizedScopeId) {
          this.repository.deleteSetting(key)
          removed += 1
        }
      }
    }
    return removed
  }
}
