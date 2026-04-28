/**
 * skill-resume G4 — recover a reference-skill hint by scanning preserved
 * capsule text (session_recall_metadata.summary / latest_task_summary /
 * preview_text) for canonical `skill_<id>_<action>` tool name patterns.
 *
 * This is the LAST RECOURSE when:
 *   - in-memory hint is gone (process restarted),
 *   - chat_conversations.meta_json.lastReferenceSkill is missing
 *     (conversation predates A1 persistence), and
 *   - session.messages is empty (fresh session, lookback A2 has nothing to scan).
 *
 * Pure functions only — no IO, no globals. Callers wire in the resolvers via
 * the `deps` argument so the helper stays testable without the runtime
 * manager / electron singletons.
 *
 * The match is intentionally conservative: it only considers tool names with
 * the canonical `skill_` prefix (e.g. `skill_video_expert_pipeline`) so we
 * don't false-arm on, say, the literal word "skill" in a recall summary.
 */

interface SkillToolLookupResult {
  skillId?: string | null
}

interface SkillLikeForRecovery {
  id: string
  name: string
  executionMode?: string
  actions: Array<{ runtime?: string }>
}

export interface SkillHintRecoveryDeps {
  resolveToolByName: (toolName: string) => SkillToolLookupResult | null
  listSkills: () => SkillLikeForRecovery[]
}

const SKILL_TOOL_NAME_PATTERN = /\bskill_[a-z][a-z0-9_]*\b/g

function isReferenceLikeSkill(skill: SkillLikeForRecovery): boolean {
  if (skill.executionMode === 'advisory') return true
  return Array.isArray(skill.actions)
    && skill.actions.some((action) => action?.runtime === 'reference')
}

function normalizeLooseToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '')
    .trim()
}

/**
 * Scan one or more capsule text fields for a canonical `skill_*` tool name
 * that resolves to a reference-like skill. Returns the first match (newest
 * caller wins by passing texts in newest-first order) or null when nothing
 * was found.
 */
export function findSkillHintInCapsuleTexts(
  texts: ReadonlyArray<string | null | undefined>,
  deps: SkillHintRecoveryDeps,
): { skillId: string; skillName: string } | null {
  if (!texts.length) return null
  const skills = deps.listSkills()
  if (!skills.length) return null
  const seen = new Set<string>()
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue
    for (const match of text.matchAll(SKILL_TOOL_NAME_PATTERN)) {
      const toolName = match[0]
      if (seen.has(toolName)) continue
      seen.add(toolName)
      const def = deps.resolveToolByName(toolName)
      if (!def?.skillId) continue
      const skill = skills.find((entry) => entry.id === def.skillId)
      if (!skill) continue
      if (!isReferenceLikeSkill(skill)) continue
      return { skillId: skill.id, skillName: skill.name }
    }
  }
  const referenceSkills = skills.filter(isReferenceLikeSkill)
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue
    const normalizedText = normalizeLooseToken(text)
    if (!normalizedText) continue
    for (const skill of referenceSkills) {
      const candidates = [skill.id, skill.name]
        .map(normalizeLooseToken)
        .filter((candidate) => candidate.length >= 6)
      if (candidates.some((candidate) => normalizedText.includes(candidate))) {
        return { skillId: skill.id, skillName: skill.name }
      }
    }
  }
  return null
}
