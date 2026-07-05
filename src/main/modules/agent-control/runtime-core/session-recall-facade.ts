// B8-D R2 — SessionRecallFacade: session-recall search/list/capsule reads,
// attach/detach of recall contexts (with scope_updated conversation events),
// resume-candidate probing, and the retry-turn auto-attach hook, extracted
// from AgentControlRuntime (runtime.ts) as a delegated sub-service. Method
// bodies are mechanical moves; the only substitutions are the shared
// `sessionRecallService` reference and the runtime-owned helpers
// (`mapConversationRow` / `emitConversationEvent` / `extractTextFromMessage`)
// becoming injected dependencies, plus the cross-cluster
// `maybeArmReferenceHintFromCapsules` call becoming the injected
// `armReferenceHintFromCapsules` callback (bound to ReferenceHintService).
// The facade owns no state: the underlying SessionRecallService field stays
// on the runtime because prompt-assembly capsule closures share it.
import { logAgentMetric } from '../metrics'
import { isRetryOnlyTurn } from '../skills/skill-detection-inputs'
import { getLastReferenceSkill } from '../skills/skill-reference-hints'
import type { SessionRecallService } from '../session/session-recall-service'
import type { MultimodalBlock } from '../contracts/run-contracts'
import type { ChatConversationRecord, ConversationSourceKind } from '../../database'
import type { ConversationEventPayload, ConversationScope } from '../contracts/types'
import type { SessionRecallCapsule, SessionRecallHit } from '../../../../shared/session-recall'

export interface SessionRecallFacadeDeps {
  sessionRecallService: SessionRecallService
  mapConversationRow: (
    row: ChatConversationRecord & { last_message_at?: string | null },
  ) => ConversationScope
  emitConversationEvent: (payload: ConversationEventPayload) => void
  extractTextFromMessage: (message: string | MultimodalBlock[]) => string
  /** Bound to `ReferenceHintService.maybeArmReferenceHintFromCapsules` —
   *  the skill-resume G4 last-recourse hint recovery for old conversations. */
  armReferenceHintFromCapsules: (scopeId: string, capsules: SessionRecallCapsule[]) => void
}

export class SessionRecallFacade {
  constructor(private readonly deps: SessionRecallFacadeDeps) {}

  searchSessionRecall(payload?: {
    query?: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.deps.sessionRecallService.searchSessionRecall(payload || {})
  }

  listRecentSessions(payload?: {
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    agent?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }): SessionRecallHit[] {
    return this.deps.sessionRecallService.listRecentSessions(payload || {})
  }

  getSessionRecallCapsule(conversationId: string): SessionRecallCapsule | null {
    return this.deps.sessionRecallService.getSessionRecallCapsule({ conversationId })
  }

  listAttachedSessionRecallContexts(scopeId: string): SessionRecallCapsule[] {
    return this.deps.sessionRecallService.listAttachedSessionRecallContexts(scopeId)
  }

  attachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope; capsule: SessionRecallCapsule } {
    const result = this.deps.sessionRecallService.attachSessionRecallContext({
      currentScopeId,
      conversationId
    })
    const scope = this.deps.mapConversationRow(result.scope)
    this.deps.emitConversationEvent({
      type: 'scope_updated',
      scope
    })
    return { scope, capsule: result.capsule }
  }

  detachSessionRecallContext(
    currentScopeId: string,
    conversationId: string
  ): { scope: ConversationScope } {
    const result = this.deps.sessionRecallService.detachSessionRecallContext({
      currentScopeId,
      conversationId
    })
    const scope = this.deps.mapConversationRow(result.scope)
    this.deps.emitConversationEvent({
      type: 'scope_updated',
      scope
    })
    return { scope }
  }

  resumeSessionCandidate(payload: {
    conversationId?: string
    resumeTitle?: string
  }): SessionRecallHit | null {
    return this.deps.sessionRecallService.resumeSessionCandidate(payload)
  }

  maybeAutoAttachSessionRecallOnResume(
    scopeId: string,
    message: string | MultimodalBlock[],
  ): void {
    try {
      const text = this.deps.extractTextFromMessage(message)
      if (!text || !isRetryOnlyTurn(text)) return
      const result = this.deps.sessionRecallService.autoAttachOnResume({
        currentScopeId: scopeId,
        intent: 'continue',
        limit: 3,
      })
      if (result.attached.length > 0) {
        logAgentMetric('session_recall_auto_attached', {
          scopeId,
          attachedCount: result.attached.length,
          attachedConversationIds: result.attached.map((c) => c.conversationId),
        })
        // skill-resume G4 — last-recourse hint recovery for OLD conversations.
        // If neither the meta_json restore nor the in-process lookback armed a
        // hint, scan the just-attached capsule texts for canonical skill_*
        // tool names. This is the only signal we have about prior skill usage
        // when the conversation predates A1 persistence.
        if (!getLastReferenceSkill(scopeId)) {
          this.deps.armReferenceHintFromCapsules(scopeId, result.attached)
        }
      }
    } catch (error) {
      console.warn('[AgentControlRuntime] maybeAutoAttachSessionRecallOnResume failed', error)
    }
  }
}
