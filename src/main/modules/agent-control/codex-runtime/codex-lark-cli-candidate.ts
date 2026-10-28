import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'

export const LARK_CLI_SKILL_ID = 'lark-cli'

export const LARK_CLI_CANDIDATE_PRIMITIVES = [
  'skill_run_shell',
  'skill_read_artifact',
  'skill_ask_user',
] as const

export type LarkCliCandidatePrimitives = {
  skillId: typeof LARK_CLI_SKILL_ID
  primitives: readonly string[]
}

export function resolveLarkCliCandidatePrimitives(): LarkCliCandidatePrimitives | null {
  try {
    const skill = getSkillsRuntimeManager().listSkills().find((candidate) => (
      candidate.id === LARK_CLI_SKILL_ID
      && candidate.installed
      && candidate.manifestValid !== false
    ))
    if (!skill) return null
    return {
      skillId: LARK_CLI_SKILL_ID,
      primitives: LARK_CLI_CANDIDATE_PRIMITIVES,
    }
  } catch {
    // silent-catch: if skills cannot be listed, the lark-cli candidate primitives are not offered (fails closed)
    return null
  }
}

export function isLarkCliCandidatePrimitive(
  toolName: string,
  candidate: LarkCliCandidatePrimitives | null | undefined,
): boolean {
  return Boolean(candidate && candidate.primitives.includes(toolName))
}
