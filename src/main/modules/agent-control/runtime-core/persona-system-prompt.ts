import type { AgentPersonalityRepository } from '../../repositories/agent-personality-repository'
import type { UserProfileRepository } from '../../repositories/user-profile-repository'
import type { ConversationScope } from '../contracts/types'
import { formatAgentTonePrompt, formatUserProfilePrompt } from '../user-profile-prompt'

type PersonalityReader = Pick<AgentPersonalityRepository, 'getPersonality'>
type UserProfileReader = Pick<UserProfileRepository, 'getProfile'>

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolvePersonaProfileUserId(
  scope: Pick<ConversationScope, 'sourceKind' | 'userId'> | null | undefined,
): string | null {
  const boundUserId = normalizeText(scope?.userId)
  if (boundUserId) return boundUserId
  return scope?.sourceKind === 'local' ? 'default-user' : null
}

export async function composePersonaSystemPrompt(
  agentName: string,
  personalityRepo: PersonalityReader,
  userProfileRepo: UserProfileReader,
  fallback: () => string,
  userId: string | null,
): Promise<string> {
  const personality = await personalityRepo.getPersonality(agentName)
  const personaLines: string[] = [fallback()]
  const personalityText = normalizeText(personality?.personalityText)
  if (personalityText) {
    personaLines.push(['当前 Agent 人格：', personalityText].join('\n'))
  }

  const tonePrompt = formatAgentTonePrompt(personality?.tone)
  if (tonePrompt) personaLines.push(tonePrompt)

  const profileUserId = normalizeText(userId)
  const profile = profileUserId
    ? await userProfileRepo.getProfile(profileUserId)
    : null
  const sections = [personaLines.join('\n')]
  if (profile) sections.push(formatUserProfilePrompt(profile))

  return sections.join('\n\n')
}
