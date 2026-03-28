/**
 * Reflection Service - Automatic post-conversation analysis and memory extraction.
 *
 * Analyzes conversations to extract:
 * - Global facts (project context, decisions, learned patterns)
 * - User preferences (communication style, habits, preferences)
 * - Session summaries (what was accomplished)
 */

import type { ConversationScope } from './types'
import type { MemoryRepository } from '../repositories/memory-repository'
import type { UserProfileRepository } from '../repositories/user-profile-repository'

export interface ReflectionResult {
  globalFacts: Array<{ title: string; content: string }>
  userPreferences: Array<{ title: string; content: string }>
  sessionSummary?: string
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
      return { globalFacts: [], userPreferences: [], sessionSummary: undefined }
    }

    try {
      // Use LLM to analyze conversation
      const reflection = await this.analyzeWithLLM(params)

      // Store global facts
      for (const fact of reflection.globalFacts) {
        await this.storeGlobalFact(fact)
      }

      // Store user preferences
      if (params.scope.userId) {
        for (const pref of reflection.userPreferences) {
          await this.storeUserPreference(params.scope.userId, pref)
        }
      }

      // Store session summary
      if (reflection.sessionSummary) {
        await this.storeSessionSummary(params.scope, reflection.sessionSummary)
      }

      return reflection
    } catch (error) {
      console.error('[ReflectionService] Failed to reflect on conversation:', error)
      return { globalFacts: [], userPreferences: [], sessionSummary: undefined }
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
    const conversationText = params.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')

    const prompt = `
Analyze the following conversation and extract important information.

Conversation:
${conversationText}

Tools used: ${params.usedTools.join(', ')}
Success: ${params.success}

Extract the following:

1. **Global Facts** - Project context, technical decisions, learned patterns, important information that should be remembered across all conversations. Examples:
   - "Project uses TypeScript and React 19"
   - "Database is SQLite with better-sqlite3"
   - "User prefers Tailwind CSS for styling"

2. **User Preferences** - Communication style, habits, preferences specific to this user. Examples:
   - "User prefers concise answers"
   - "User likes to see code examples"
   - "User works in Chinese timezone"

3. **Session Summary** - Brief summary of what was accomplished in this conversation (1-2 sentences).

Return ONLY valid JSON in this exact format:
{
  "globalFacts": [{"title": "Short title", "content": "Detailed content"}],
  "userPreferences": [{"title": "Short title", "content": "Detailed content"}],
  "sessionSummary": "Brief summary of what was accomplished"
}

Rules:
- Only extract facts that are clearly stated or strongly implied
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
        globalFacts: Array.isArray(parsed.globalFacts) ? parsed.globalFacts : [],
        userPreferences: Array.isArray(parsed.userPreferences) ? parsed.userPreferences : [],
        sessionSummary: typeof parsed.sessionSummary === 'string' ? parsed.sessionSummary : undefined,
      }
    } catch (error) {
      console.error('[ReflectionService] Failed to parse reflection response:', error)
      return { globalFacts: [], userPreferences: [], sessionSummary: undefined }
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
    const globalFacts: Array<{ title: string; content: string }> = []
    const userPreferences: Array<{ title: string; content: string }> = []

    // Extract tool usage patterns
    if (params.usedTools.length > 0) {
      const toolSummary = params.usedTools.slice(0, 3).join(', ')
      globalFacts.push({
        title: 'Tools Used',
        content: `Used tools: ${toolSummary}`,
      })
    }

    // Extract user preferences from explicit statements
    const userMessages = params.messages.filter((m) => m.role === 'user')
    for (const msg of userMessages) {
      const content = msg.content.toLowerCase()

      // Detect language preference
      if (content.includes('中文') || content.includes('chinese')) {
        userPreferences.push({
          title: 'Language Preference',
          content: 'User prefers Chinese language',
        })
      }

      // Detect style preferences
      if (content.includes('简洁') || content.includes('concise') || content.includes('brief')) {
        userPreferences.push({
          title: 'Communication Style',
          content: 'User prefers concise answers',
        })
      }
    }

    return {
      globalFacts,
      userPreferences,
      sessionSummary: params.success
        ? `Completed task using ${params.usedTools.length} tools`
        : 'Task incomplete',
    }
  }

  /**
   * Store a global fact in the memory system
   */
  private async storeGlobalFact(fact: { title: string; content: string }): Promise<void> {
    try {
      // Generate unique content key
      const contentKey = `fact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      // Store content in knowledge repository
      if (this.deps.knowledgeRepository) {
        await this.deps.knowledgeRepository.set(contentKey, fact.content)
      }

      // Create memory entry
      await this.deps.memoryRepository.createMemory({
        layer: 'l0',
        scopeId: null,
        userId: null,
        category: 'global_fact',
        title: fact.title,
        summary: fact.content.slice(0, 100),
        contentKey,
        priority: 5,
        tags: ['auto-learned'],
      })

      console.log(`[ReflectionService] Stored global fact: ${fact.title}`)
    } catch (error) {
      console.error('[ReflectionService] Failed to store global fact:', error)
    }
  }

  /**
   * Store a user preference in the memory system
   */
  private async storeUserPreference(
    userId: string,
    pref: { title: string; content: string }
  ): Promise<void> {
    try {
      // Generate unique content key
      const contentKey = `pref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      // Store content in knowledge repository
      if (this.deps.knowledgeRepository) {
        await this.deps.knowledgeRepository.set(contentKey, pref.content)
      }

      // Create memory entry
      await this.deps.memoryRepository.createMemory({
        layer: 'l0',
        scopeId: null,
        userId,
        category: 'user_preference',
        title: pref.title,
        summary: pref.content.slice(0, 100),
        contentKey,
        priority: 5,
        tags: ['auto-learned'],
      })

      console.log(`[ReflectionService] Stored user preference for ${userId}: ${pref.title}`)
    } catch (error) {
      console.error('[ReflectionService] Failed to store user preference:', error)
    }
  }

  /**
   * Store a session summary in the memory system
   */
  private async storeSessionSummary(
    scope: ConversationScope,
    summary: string
  ): Promise<void> {
    try {
      // Generate unique content key
      const contentKey = `summary-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      // Store content in knowledge repository
      if (this.deps.knowledgeRepository) {
        await this.deps.knowledgeRepository.set(contentKey, summary)
      }

      // Create memory entry with 30-day expiry
      const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000

      await this.deps.memoryRepository.createMemory({
        layer: 'l1',
        scopeId: scope.id,
        userId: scope.userId || null,
        category: 'summary',
        title: `Session ${new Date().toISOString().split('T')[0]}`,
        summary: summary.slice(0, 100),
        contentKey,
        priority: 0,
        expiresAt,
        tags: ['auto-summary'],
      })

      console.log(`[ReflectionService] Stored session summary for scope ${scope.id}`)
    } catch (error) {
      console.error('[ReflectionService] Failed to store session summary:', error)
    }
  }
}
