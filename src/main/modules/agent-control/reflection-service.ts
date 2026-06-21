/**
 * Reflection Service - Automatic post-conversation analysis and memory extraction.
 *
 * Analyzes conversations to extract:
 * - Global facts (project context, decisions, learned patterns)
 * - User preferences (communication style, habits, preferences)
 * - Session summaries (what was accomplished)
 */

import type { ConversationScope, ScopeRunMemoryCapture } from './contracts/types'
import { logAgentMetric } from './metrics'
import type { CasMergeReport, PictureObservation } from './maintenance/cas-merge'
import type { MemoryRepository } from '../repositories/memory-repository'
import type { UserProfileRepository } from '../repositories/user-profile-repository'

export interface ReflectionResult {
  globalFacts: Array<{ title: string; content: string }>
  userPreferences: Array<{ title: string; content: string }>
  sessionSummary?: string
  memoryCapture?: ScopeRunMemoryCapture | null
}

export interface ReflectionDeps {
  memoryRepository: MemoryRepository
  userProfileRepository?: UserProfileRepository
  knowledgeRepository?: any
  llmProvider?: (prompt: string) => Promise<string>
  pictureCasMerge?: (params: {
    userId: string
    observations: PictureObservation[]
    scope: ConversationScope
  }) => CasMergeReport
}

function shouldKeepSessionSummary(params: {
  success: boolean
  usedTools: string[]
  pureConversationDone?: boolean
  sessionSummary?: string
}): string | undefined {
  const summary = String(params.sessionSummary || '').trim()
  if (!summary) return undefined
  if (!params.success) return summary
  if (params.usedTools.length > 0 || params.pureConversationDone === true) return summary
  return undefined
}

export class ReflectionService {
  constructor(private deps: ReflectionDeps) {}

  /**
   * Analyze conversation and extract important information
   */
  async reflectOnConversation(params: {
    scope: ConversationScope
    messages: Array<{ role: string; content: string }>
    usedTools: string[]
    success: boolean
    pureConversationDone?: boolean
  }): Promise<ReflectionResult> {
    // Skip reflection for very short conversations
    if (params.messages.length < 2) {
      this.logOutcome(params.scope, {
        decision: 'skip',
        reason: 'too_short',
        preferences: 0,
        summaryKept: false,
      })
      return {
        globalFacts: [],
        userPreferences: [],
        sessionSummary: undefined,
        memoryCapture: null
      }
    }

    try {
      // Use LLM to analyze conversation
      const reflection = await this.analyzeWithLLM(params)
      const sessionSummary = shouldKeepSessionSummary({
        success: params.success,
        usedTools: params.usedTools,
        pureConversationDone: params.pureConversationDone,
        sessionSummary: reflection.sessionSummary,
      })
      const observations = this.toPictureObservations(reflection.userPreferences)
      const outcome = this.applyPictureCas({
        scope: params.scope,
        observations,
        summaryKept: Boolean(sessionSummary),
      })
      this.logOutcome(params.scope, outcome)

      return {
        ...reflection,
        globalFacts: [],
        sessionSummary,
        memoryCapture: null
      }
    } catch (error) {
      console.error('[ReflectionService] Failed to reflect on conversation:', error)
      this.logOutcome(params.scope, {
        decision: 'error',
        reason: error instanceof Error ? error.message : String(error),
        preferences: 0,
        summaryKept: false,
      })
      return {
        globalFacts: [],
        userPreferences: [],
        sessionSummary: undefined,
        memoryCapture: null
      }
    }
  }

  /**
   * Use LLM to analyze conversation and extract facts
   */
  private async analyzeWithLLM(params: {
    messages: Array<{ role: string; content: string }>
    usedTools: string[]
    success: boolean
    pureConversationDone?: boolean
  }): Promise<ReflectionResult> {
    // Build reflection prompt
    const conversationText = params.messages.map((m) => `${m.role}: ${m.content}`).join('\n')

    const prompt = `
Analyze the following conversation and extract important information.

Conversation:
${conversationText}

Tools used: ${params.usedTools.join(', ')}
Success: ${params.success}

Extract the following conservatively:

1. **User Preferences** - Communication style, habits, preferences specific to this user. Examples:
   - "User prefers concise answers"
   - "User wants direct delivery-oriented updates"
   - "User prefers Chinese language"

2. **Session Summary** - Brief summary of what was accomplished in this conversation (1-2 sentences).

Return ONLY valid JSON in this exact format:
{
  "globalFacts": [],
  "userPreferences": [{"title": "Short title", "content": "Detailed content"}],
  "sessionSummary": "Brief summary of what was accomplished"
}

Rules:
- Only extract stable preferences that should persist across future tasks
- Ignore temporary paths, one-off requests, and project facts
- Avoid duplicating information that's likely already known
- Keep titles short (under 50 chars) and content concise (under 200 chars)
- If nothing significant to extract, return empty arrays
- Return ONLY the JSON, no other text
`.trim()

    // Use LLM provider if available
    if (this.deps.llmProvider) {
      const response = await this.deps.llmProvider(prompt)
      return this.parseReflectionResponse(response)
    }

    // Fallback: simple heuristic-based extraction
    return this.heuristicExtraction(params)
  }

  private toPictureObservations(
    preferences: Array<{ title: string; content: string }>
  ): PictureObservation[] {
    const observations: PictureObservation[] = []
    for (const pref of preferences) {
      const text = String(pref.content || '').trim()
      if (!text) continue
      const title = String(pref.title || '').toLowerCase()
      const lowerText = text.toLowerCase()
      const kind: PictureObservation['kind'] =
        title.includes('communication') ||
        title.includes('style') ||
        lowerText.includes('concise') ||
        lowerText.includes('direct')
          ? 'communication_style'
          : 'preference'
      observations.push({ kind, text })
    }
    return observations
  }

  private applyPictureCas(params: {
    scope: ConversationScope
    observations: PictureObservation[]
    summaryKept: boolean
  }): {
    decision: 'cas_merged' | 'skip' | 'error'
    reason: string
    preferences: number
    accepted?: number
    rejected?: number
    addedCount?: number
    droppedCount?: number
    summaryKept: boolean
  } {
    if (params.observations.length === 0) {
      return {
        decision: 'skip',
        reason: params.summaryKept ? 'summary_not_persisted' : 'no_candidates',
        preferences: 0,
        summaryKept: params.summaryKept,
      }
    }
    if (!params.scope.userId) {
      return {
        decision: 'skip',
        reason: 'missing_user',
        preferences: params.observations.length,
        summaryKept: params.summaryKept,
      }
    }
    if (!this.deps.pictureCasMerge) {
      return {
        decision: 'skip',
        reason: 'cas_unavailable',
        preferences: params.observations.length,
        summaryKept: params.summaryKept,
      }
    }
    const report = this.deps.pictureCasMerge({
      userId: params.scope.userId,
      observations: params.observations,
      scope: params.scope,
    })
    if (report.decision === 'merged') {
      return {
        decision: 'cas_merged',
        reason: report.reason,
        preferences: params.observations.length,
        accepted: report.accepted,
        rejected: report.rejected,
        addedCount: report.addedCount,
        droppedCount: report.droppedCount,
        summaryKept: params.summaryKept,
      }
    }
    if (report.decision === 'error') {
      return {
        decision: 'error',
        reason: report.reason,
        preferences: params.observations.length,
        accepted: report.accepted,
        rejected: report.rejected,
        addedCount: report.addedCount,
        droppedCount: report.droppedCount,
        summaryKept: params.summaryKept,
      }
    }
    return {
      decision: 'skip',
      reason: report.reason || report.decision,
      preferences: params.observations.length,
      accepted: report.accepted,
      rejected: report.rejected,
      addedCount: report.addedCount,
      droppedCount: report.droppedCount,
      summaryKept: params.summaryKept,
    }
  }

  private logOutcome(
    scope: ConversationScope,
    outcome: {
      decision: 'cas_merged' | 'skip' | 'error'
      reason: string
      preferences: number
      accepted?: number
      rejected?: number
      addedCount?: number
      droppedCount?: number
      summaryKept: boolean
    }
  ): void {
    logAgentMetric('reflection_outcome', {
      scopeId: scope.id,
      agent: scope.agent,
      decision: outcome.decision,
      reason: outcome.reason,
      preferences: outcome.preferences,
      accepted: outcome.accepted ?? null,
      rejected: outcome.rejected ?? null,
      addedCount: outcome.addedCount ?? null,
      droppedCount: outcome.droppedCount ?? null,
      summaryKept: outcome.summaryKept,
    })
  }

  /**
   * Parse LLM response into ReflectionResult
   */
  private parseReflectionResponse(response: string): ReflectionResult {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = response.trim()
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/^```json\s*/, '').replace(/\s*```$/, '')
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```\s*/, '').replace(/\s*```$/, '')
      }

      const parsed = JSON.parse(jsonText)

      return {
        globalFacts: [],
        userPreferences: Array.isArray(parsed.userPreferences) ? parsed.userPreferences : [],
        sessionSummary:
          typeof parsed.sessionSummary === 'string' ? parsed.sessionSummary : undefined,
        memoryCapture: null
      }
    } catch (error) {
      console.error('[ReflectionService] Failed to parse reflection response:', error)
      return {
        globalFacts: [],
        userPreferences: [],
        sessionSummary: undefined,
        memoryCapture: null
      }
    }
  }

  /**
   * Fallback heuristic-based extraction when LLM is not available
   */
  private heuristicExtraction(params: {
    messages: Array<{ role: string; content: string }>
    usedTools: string[]
    success: boolean
    pureConversationDone?: boolean
  }): ReflectionResult {
    const userPreferences: Array<{ title: string; content: string }> = []

    // Extract user preferences from explicit statements
    const userMessages = params.messages.filter((m) => m.role === 'user')
    for (const msg of userMessages) {
      const content = msg.content.toLowerCase()

      // Detect language preference
      if (content.includes('中文') || content.includes('chinese')) {
        userPreferences.push({
          title: 'Language Preference',
          content: 'User prefers Chinese language'
        })
      }

      // Detect style preferences
      if (content.includes('简洁') || content.includes('concise') || content.includes('brief')) {
        userPreferences.push({
          title: 'Communication Style',
          content: 'User prefers concise answers'
        })
      }
    }

    const shouldWriteSuccessSummary =
      params.success && (params.usedTools.length > 0 || params.pureConversationDone === true)

    return {
      globalFacts: [],
      userPreferences,
      sessionSummary: shouldWriteSuccessSummary
        ? `Completed task using ${params.usedTools.length} tools`
        : params.success ? undefined : 'Task incomplete',
      memoryCapture: null
    }
  }

}
