import type { AgentPersonalityRepository } from '../../repositories/agent-personality-repository'
import type { UserProfileRepository } from '../../repositories/user-profile-repository'

type PersonalityReader = Pick<AgentPersonalityRepository, 'getPersonality'>
type UserProfileReader = Pick<UserProfileRepository, 'getProfile'>

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function formatPreference(value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => normalizeText(item))
      .filter((item): item is string => Boolean(item))
    return items.length > 0 ? items.join('；') : null
  }
  return normalizeText(value)
}

export async function composePersonaSystemPrompt(
  agentName: string,
  personalityRepo: PersonalityReader,
  userProfileRepo: UserProfileReader,
  fallback: () => string,
): Promise<string> {
  const personality = await personalityRepo.getPersonality(agentName)
  const personaLines: string[] = []
  const personalityText = normalizeText(personality?.personalityText)
  personaLines.push(personalityText || fallback())

  const tone = normalizeText(personality?.tone)
  if (tone) {
    personaLines.push(`语气：${tone}`)
  }

  const profile = await userProfileRepo.getProfile('default-user')
  const profileLines: string[] = []
  if (profile) {
    const name = normalizeText(profile.name)
    const language = normalizeText(profile.preferredLanguage)
    const style = normalizeText(profile.communicationStyle)
    const longTermPreferences = formatPreference(profile.preferencesJson?.longTermPreferences)

    if (name) profileLines.push(`昵称：${name}`)
    if (language) profileLines.push(`语言：${language}`)
    if (style) profileLines.push(`回复风格：${style}`)
    if (longTermPreferences) profileLines.push(`长期偏好：${longTermPreferences}`)
  }

  const sections = [personaLines.join('\n')]
  if (profileLines.length > 0) {
    sections.push(['用户档案（关于当前用户）', ...profileLines].join('\n'))
  }

  return sections.join('\n\n')
}
