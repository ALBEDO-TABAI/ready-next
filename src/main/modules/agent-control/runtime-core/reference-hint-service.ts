// B8-D R2 — ReferenceHintService: the reference-skill hint read for the
// renderer badge, the persist/restore bridge between the in-memory hint map
// and `chat_conversations.meta_json.lastReferenceSkill`, the capsule-text
// last-recourse recovery (skill-resume G4), and the cluster-exclusive
// `parseScopeMeta` helper (Phase 1.4 corruption metrics), extracted from
// AgentControlRuntime (runtime.ts) as a delegated sub-service. Method bodies
// are mechanical moves; the only substitutions are `this.db` →
// `this.deps.db` and `this.mapConversationRow` → `this.deps.mapConversationRow`.
// Field audit (surgery map §1.1 marked "待核"): the in-memory hint state is
// NOT a runtime field — it lives in the module-level map inside
// `skills/skill-reference-hints.ts` (`lastReferenceSkillBySession`), so no
// state migrates here; the module accessors stay plain imports exactly as
// they were in runtime.ts.
import {
  snapshotLastReferenceSkill,
  restoreLastReferenceSkill,
  rememberLastReferenceSkill,
  peekLastReferenceSkill,
  REFERENCE_SKILL_HINT_TTL_MS,
  type PersistedReferenceSkillHint,
} from '../skills/skill-reference-hints'
import { findSkillHintInCapsuleTexts } from '../skills/skill-hint-recovery'
import { shouldDisplayReferenceSkillHintForLatestUserText } from '../reference-skill-hint-display'
import { findSkillToolByName } from '../../tools/skills-tools'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import { logAgentMetric } from '../metrics'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import type { ChatConversationRecord } from '../../database/records'
import type { DatabaseManager } from '../../database'
import type { ConversationScope } from '../contracts/types'

export interface ReferenceHintServiceDeps {
  db: DatabaseManager
  mapConversationRow: (
    row: ChatConversationRecord & { last_message_at?: string | null },
  ) => ConversationScope
}

export class ReferenceHintService {
  constructor(private readonly deps: ReferenceHintServiceDeps) {}

  getReferenceSkillHint(scopeId: string): { id: string; name: string; at: number; expiresAt: number } | null {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId) return null
    const live = peekLastReferenceSkill(normalizedScopeId)
    // This IPC is a renderer read for the small "skill context enabled"
    // badge. It must not re-arm persisted hints by itself; otherwise merely
    // opening Ready can light up a stale VEA context before the next user
    // turn proves it is relevant. Turn execution restores persisted hints in
    // `AgentControlRuntime.sendScoped(...)`, where intent gating can
    // immediately clear unrelated turns.
    if (!live) return null
    const latestUserText = (() => {
      try {
        const messages = this.deps.db.chat.getChatMessages(normalizedScopeId)
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message.role === 'user') return message.content || ''
        }
      } catch {
        return ''
      }
      return ''
    })()
    if (!shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText,
      skillId: live.id,
      skillName: live.name,
    })) {
      return null
    }
    return {
      id: live.id,
      name: live.name,
      at: live.at,
      expiresAt: live.at + REFERENCE_SKILL_HINT_TTL_MS,
    }
  }

  restoreReferenceHintFromScope(scope: ConversationScope, scopeId: string): void {
    try {
      // Replay is for a hint the process lost (restart, fresh session). A live
      // hint is always at least as new as the persisted one — persistence only
      // ever snapshots the in-memory map — so replaying over it can only move
      // the scope backwards, e.g. after a turn armed a new skill but ended
      // without the assistant append that persists it.
      if (peekLastReferenceSkill(scopeId)) return
      const meta = this.parseScopeMeta(scope)
      const hint = meta['lastReferenceSkill']
      if (!hint || typeof hint !== 'object') return
      const persisted = hint as PersistedReferenceSkillHint
      if (typeof persisted.id !== 'string' || typeof persisted.name !== 'string' || typeof persisted.at !== 'number') return
      restoreLastReferenceSkill(scopeId, persisted)
    } catch (error) {
      console.warn('[AgentControlRuntime] restoreReferenceHintFromScope failed', error)
    }
  }

  maybeArmReferenceHintFromCapsules(
    scopeId: string,
    messageVisibilityEpoch: number,
    capsules: Array<{
      summary?: string | null
      latestTaskTitle?: string | null
      latestTaskSummary?: string | null
      title?: string | null
      resumeTitle?: string | null
    }>,
  ): void {
    try {
      const texts: string[] = []
      for (const capsule of capsules) {
        if (typeof capsule.summary === 'string') texts.push(capsule.summary)
        if (typeof capsule.latestTaskSummary === 'string') texts.push(capsule.latestTaskSummary)
        if (typeof capsule.latestTaskTitle === 'string') texts.push(capsule.latestTaskTitle)
        if (typeof capsule.title === 'string') texts.push(capsule.title)
        if (typeof capsule.resumeTitle === 'string') texts.push(capsule.resumeTitle)
      }
      const recovered = findSkillHintInCapsuleTexts(texts, {
        resolveToolByName: (name) => findSkillToolByName(name),
        listSkills: () => getSkillsRuntimeManager().listSkills(),
      })
      if (!recovered) return
      rememberLastReferenceSkill(scopeId, {
        id: recovered.skillId,
        name: recovered.skillName,
        messageVisibilityEpoch,
      })
      logAgentMetric('skill_reference_hint_recovered_from_capsule', {
        scopeId,
        skillId: recovered.skillId,
        skillName: recovered.skillName,
      })
    } catch (error) {
      console.warn('[AgentControlRuntime] maybeArmReferenceHintFromCapsules failed', error)
    }
  }

  persistReferenceHintToScope(
    scopeId: string,
    expectedMessageVisibilityEpoch: number,
  ): void {
    try {
      const hint = snapshotLastReferenceSkill(scopeId)
      const scopeRow = this.deps.db.chat.getConversationScope(scopeId)
      if (!scopeRow) return
      if ((scopeRow.message_visibility_epoch ?? 0) !== expectedMessageVisibilityEpoch) return
      const scope = this.deps.mapConversationRow(scopeRow)
      const meta = this.parseScopeMeta(scope)
      if (!hint) {
        if ('lastReferenceSkill' in meta) {
          delete meta['lastReferenceSkill']
          this.deps.db.chat.updateConversationScopeMeta(
            scopeId,
            meta,
            expectedMessageVisibilityEpoch,
          )
        }
        return
      }
      const existing = meta['lastReferenceSkill'] as PersistedReferenceSkillHint | undefined
      // Avoid noisy DB writes: skip if persisted hint is identical (same id+name+at).
      if (
        existing
        && existing.id === hint.id
        && existing.name === hint.name
        && existing.at === hint.at
        && JSON.stringify(existing.applicableToolNames || []) === JSON.stringify(hint.applicableToolNames || [])
      ) {
        return
      }
      meta['lastReferenceSkill'] = hint
      this.deps.db.chat.updateConversationScopeMeta(
        scopeId,
        meta,
        expectedMessageVisibilityEpoch,
      )
    } catch (error) {
      console.warn('[AgentControlRuntime] persistReferenceHintToScope failed', error)
    }
  }

  private parseScopeMeta(scope: ConversationScope | null | undefined): Record<string, unknown> {
    const raw = (scope?.meta as unknown as string | Record<string, unknown> | null | undefined)
    if (!raw) return {}
    if (typeof raw === 'object') return { ...raw } as Record<string, unknown>
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object') return { ...(parsed as Record<string, unknown>) }
        // Phase 1.4 — JSON parsed but produced something that's not a record
        // (string/array/number/null). Surface this so silent meta loss has a
        // signal in the metrics log.
        logAgentMetric(TOOL_ERROR_METRICS.metaParseCorrupted, {
          scopeId: scope?.id || null,
          reason: 'not_object',
          sample: raw.slice(0, 80),
        })
      } catch (error) {
        // Phase 1.4 — JSON.parse threw. Previously the catch swallowed the
        // error and returned {}, so corruption silently nuked any
        // `lastReferenceSkill` field at the next read. Emit a metric instead.
        logAgentMetric(TOOL_ERROR_METRICS.metaParseCorrupted, {
          scopeId: scope?.id || null,
          reason: 'parse_error',
          message: error instanceof Error ? error.message : String(error),
          sample: raw.slice(0, 80),
        })
      }
    }
    return {}
  }
}
