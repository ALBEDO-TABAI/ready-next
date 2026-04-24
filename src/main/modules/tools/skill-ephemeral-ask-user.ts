/**
 * Ephemeral ask-user storage for skill primitives.
 *
 * This module provides an in-memory store for skill_ask_user interactions
 * that don't need persistence. Records are automatically cleaned up via TTL.
 */

import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tool-error-metrics'

export interface EphemeralAskUserRecord {
  sessionId: string
  askId: string
  question: string
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  answer?: string
  createdAt: number
  expiresAt: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const SWEEP_INTERVAL_MS = 60 * 1000 // 60 seconds (confirmed)
const SWEEP_BOOT_DELAY_MS = 30 * 1000 // 30 seconds

export class EphemeralExecutionStore {
  private readonly records = new Map<string, EphemeralAskUserRecord>()
  private readonly sessionIndex = new Map<string, Set<string>>() // sessionId -> Set<askId>
  private sweepTimer?: NodeJS.Timeout
  private sweepBootTimer?: NodeJS.Timeout

  createAskUser(sessionId: string, question: string, ttlMs: number = DEFAULT_TTL_MS): string {
    const askId = this.generateAskId()
    const now = Date.now()
    const record: EphemeralAskUserRecord = {
      sessionId,
      askId,
      question,
      status: 'pending',
      createdAt: now,
      expiresAt: now + ttlMs,
    }

    this.records.set(askId, record)

    const sessionSet = this.sessionIndex.get(sessionId) || new Set()
    sessionSet.add(askId)
    this.sessionIndex.set(sessionId, sessionSet)

    return askId
  }

  getAskUser(askId: string): EphemeralAskUserRecord | null {
    return this.records.get(askId) || null
  }

  updateAskUser(askId: string, updates: Partial<EphemeralAskUserRecord>): boolean {
    const record = this.records.get(askId)
    if (!record) return false

    const updated = { ...record, ...updates }
    this.records.set(askId, updated)
    return true
  }

  deleteAskUser(askId: string): boolean {
    const record = this.records.get(askId)
    if (!record) return false

    this.records.delete(askId)

    const sessionSet = this.sessionIndex.get(record.sessionId)
    if (sessionSet) {
      sessionSet.delete(askId)
      if (sessionSet.size === 0) {
        this.sessionIndex.delete(record.sessionId)
      }
    }

    return true
  }

  getActiveAsksBySession(sessionId: string): EphemeralAskUserRecord[] {
    const sessionSet = this.sessionIndex.get(sessionId)
    if (!sessionSet) return []

    const now = Date.now()
    const results: EphemeralAskUserRecord[] = []

    for (const askId of sessionSet) {
      const record = this.records.get(askId)
      if (record && record.status === 'pending' && record.expiresAt > now) {
        results.push(record)
      }
    }

    return results
  }

  hasActiveAsk(sessionId: string): boolean {
    const sessionSet = this.sessionIndex.get(sessionId)
    if (!sessionSet) return false

    const now = Date.now()
    for (const askId of sessionSet) {
      const record = this.records.get(askId)
      if (record && record.status === 'pending' && record.expiresAt > now) {
        return true
      }
    }

    return false
  }

  sweepExpired(): number {
    const now = Date.now()
    let deleted = 0

    for (const [askId, record] of this.records.entries()) {
      if (record.expiresAt <= now || record.status === 'expired') {
        this.deleteAskUser(askId)
        deleted++
      }
    }

    if (deleted > 0) {
      logAgentMetric(TOOL_ERROR_METRICS.skillEphemeralAskUserTtlSwept, {
        deleted,
        timestamp: now,
      })
    }

    return deleted
  }

  clearAllForSession(sessionId: string): number {
    const sessionSet = this.sessionIndex.get(sessionId)
    if (!sessionSet) return 0

    let deleted = 0
    for (const askId of sessionSet) {
      if (this.deleteAskUser(askId)) {
        deleted++
      }
    }

    return deleted
  }

  startSweep(): void {
    if (this.sweepTimer || this.sweepBootTimer) return

    const sweep = (): void => {
      try {
        this.sweepExpired()
      } catch (error) {
        console.error('[EphemeralExecutionStore] TTL sweep failed:', error)
      }
    }

    this.sweepBootTimer = setTimeout(() => {
      sweep()
      this.sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS)
    }, SWEEP_BOOT_DELAY_MS)
  }

  stopSweep(): void {
    if (this.sweepBootTimer) {
      clearTimeout(this.sweepBootTimer)
      this.sweepBootTimer = undefined
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
  }

  private generateAskId(): string {
    return `ask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }

  getSize(): number {
    return this.records.size
  }

  getSessionCount(): number {
    return this.sessionIndex.size
  }
}
