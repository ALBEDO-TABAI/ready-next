/**
 * Reflection Service - Automatic post-conversation analysis and memory extraction.
 *
 * Analyzes conversations to extract:
 * - Global facts (project context, decisions, learned patterns)
 * - User preferences (communication style, habits, preferences)
 * - Session summaries (what was accomplished)
 */

import type { ConversationScope, ScopeRunMemoryCapture } from './types'
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
  }): Promise<ReflectionResult> {
    // Skip reflection for very short conversations
    if (params.messages.length < 2) {
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
      const captureItems: NonNullable<ScopeRunMemoryCapture['items']> = []

      // Store user preferences
      if (params.scope.userId) {
        for (const pref of reflection.userPreferences) {
          const stored = await this.storeUserPreference(params.scope.userId, pref)
          if (stored) captureItems.push(stored)
        }
      }

      // Store session summary
      if (reflection.sessionSummary) {
        const stored = await this.storeSessionSummary(params.scope, reflection.sessionSummary)
        if (stored) captureItems.push(stored)
      }

      return {
        ...reflection,
        globalFacts: [],
        memoryCapture:
          captureItems.length > 0
            ? {
                status: 'ready',
                createdAt: new Date().toISOString(),
                note: '已保守记录本次稳定偏好和当前上下文摘要，可直接撤销或补充。',
                items: captureItems
              }
            : null
      }
    } catch (error) {
      console.error('[ReflectionService] Failed to reflect on conversation:', error)
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

    try {
      // Use LLM provider if available
      if (this.deps.llmProvider) {
        const response = await this.deps.llmProvider(prompt)
        return this.parseReflectionResponse(response)
      }

      // Fallback: simple heuristic-based extraction
      return this.heuristicExtraction(params)
    } catch (error) {
      console.error('[ReflectionService] LLM analysis failed:', error)
      return this.heuristicExtraction(params)
    }
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

    return {
      globalFacts: [],
      userPreferences,
      sessionSummary: params.success
        ? `Completed task using ${params.usedTools.length} tools`
        : 'Task incomplete',
      memoryCapture: null
    }
  }

  private normalizeValue(value: string): string {
    return String(value || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
  }

  private async isDuplicateMemory(params: {
    category: 'user_preference' | 'summary'
    scopeId?: string | null
    userId?: string | null
    title: string
    content: string
  }): Promise<boolean> {
    const existing = await this.deps.memoryRepository.queryMemories({
      category: params.category,
      scopeId: params.scopeId === undefined ? undefined : params.scopeId,
      userId: params.userId || undefined,
      includeArchived: false,
      limit: 20
    })
    const normalizedTitle = this.normalizeValue(params.title)
    const normalizedContent = this.normalizeValue(params.content)
    for (const item of existing) {
      const sameTitle = this.normalizeValue(item.title) === normalizedTitle
      const sameSummary = this.normalizeValue(item.summary || '') === normalizedContent
      let sameContent = false
      if (this.deps.knowledgeRepository?.get && item.contentKey) {
        try {
          const stored = await this.deps.knowledgeRepository.get(item.contentKey)
          sameContent = this.normalizeValue(stored || '') === normalizedContent
        } catch {
          sameContent = false
        }
      }
      if (sameTitle && (sameSummary || sameContent)) {
        return true
      }
    }
    return false
  }

  /**
   * Store a user preference in the memory system
   */
  private async storeUserPreference(
    userId: string,
    pref: { title: string; content: string }
  ): Promise<ScopeRunMemoryCapture['items'][number] | null> {
    try {
      if (
        await this.isDuplicateMemory({
          category: 'user_preference',
          scopeId: null,
          userId,
          title: pref.title,
          content: pref.content
        })
      ) {
        return null
      }

      // Generate unique content key
      const contentKey = `pref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      // Store content in knowledge repository
      if (this.deps.knowledgeRepository) {
        await this.deps.knowledgeRepository.set(contentKey, pref.content)
      }

      // Create memory entry
      const created = await this.deps.memoryRepository.createMemory({
        layer: 'l0',
        scopeId: null,
        userId,
        sourceType: 'resident_user',
        category: 'user_preference',
        title: pref.title,
        summary: pref.content.slice(0, 100),
        contentKey,
        priority: 5,
        tags: ['auto-learned']
      })

      console.log(`[ReflectionService] Stored user preference for ${userId}: ${pref.title}`)
      return {
        memoryId: created.id,
        category: 'user_preference',
        sourceType: 'resident_user',
        title: pref.title,
        summary: pref.content.slice(0, 100)
      }
    } catch (error) {
      console.error('[ReflectionService] Failed to store user preference:', error)
      return null
    }
  }

  /**
   * Store a session summary in the memory system
   */
  private async storeSessionSummary(
    scope: ConversationScope,
    summary: string
  ): Promise<ScopeRunMemoryCapture['items'][number] | null> {
    try {
      if (
        await this.isDuplicateMemory({
          category: 'summary',
          scopeId: scope.id,
          userId: scope.userId || null,
          title: `Session ${new Date().toISOString().split('T')[0]}`,
          content: summary
        })
      ) {
        return null
      }

      // Generate unique content key
      const contentKey = `summary-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      // Store content in knowledge repository
      if (this.deps.knowledgeRepository) {
        await this.deps.knowledgeRepository.set(contentKey, summary)
      }

      // Create memory entry with 30-day expiry
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000

      const created = await this.deps.memoryRepository.createMemory({
        layer: 'l1',
        scopeId: scope.id,
        userId: scope.userId || null,
        sourceType: 'scope_memory',
        category: 'summary',
        title: `Session ${new Date().toISOString().split('T')[0]}`,
        summary: summary.slice(0, 100),
        contentKey,
        priority: 0,
        expiresAt,
        tags: ['auto-summary']
      })

      console.log(`[ReflectionService] Stored session summary for scope ${scope.id}`)
      return {
        memoryId: created.id,
        category: 'summary',
        sourceType: 'scope_memory',
        title: `Session ${new Date().toISOString().split('T')[0]}`,
        summary: summary.slice(0, 100)
      }
    } catch (error) {
      console.error('[ReflectionService] Failed to store session summary:', error)
      return null
    }
  }
}
