/**
 * Handler for the `use_skill` agent tool (capability group `skill_activation`, P2-2).
 *
 * Model-side explicit skill activation from the L1 catalog:
 *   1. Validate `skill_id` against the live skill list → structured `unknown_skill`
 *      error (never bubbles) if absent; `input_validation` if blank.
 *   2. Read the skill's SKILL.md methodology (capped at 12K via the shared reader) so
 *      the model gets the rails THIS turn.
 *   3. Arm the reference-skill hint (`rememberReferenceSkill`). The SDK host consumes
 *      that exact hint immediately after this tool returns, refreshes the current run's
 *      immutable authorization, and exposes only that skill's tools on the next model
 *      iteration. The hint also preserves the existing next-turn continuation path.
 *
 * Electron-free + injectable so it runs under `tsx --test`: the skill list, doc reader,
 * and hint memory are passed via deps (the executor wires the real singletons).
 */

import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../../agent-control/tools-runtime/tool-result-types'
import { ToolDomainError } from '../tool-errors'

export interface UseSkillSkillLike {
  id: string
  name: string
  managedPath?: string
  description?: string
  requiredBins?: readonly string[]
}

export interface UseSkillDeps {
  sessionId?: string
  listSkills: () => ReadonlyArray<UseSkillSkillLike>
  readSkillDoc: (managedPath: string | undefined) => { text: string; truncated: boolean } | null
  rememberReferenceSkill: (sessionId: string | undefined, info: { id: string; name: string }) => void
}

export interface UseSkillArgs {
  skill_id?: unknown
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function executeUseSkill(
  args: UseSkillArgs,
  deps: UseSkillDeps,
): Promise<ToolExecutionOutput> {
  const skillId = asTrimmedString(args.skill_id)
  if (!skillId) {
    throw new ToolDomainError(
      'input_validation',
      'use_skill 需要 skill_id（要激活的技能 id，取自「可用技能」目录）。',
    )
  }

  const skill = deps.listSkills().find((candidate) => candidate && candidate.id === skillId)
  if (!skill) {
    throw new ToolDomainError(
      'unknown_skill',
      `未找到技能「${skillId}」。请从「可用技能」目录里选择一个真实存在的技能 id 再调用 use_skill。`,
    )
  }

  const doc = deps.readSkillDoc(skill.managedPath)

  // Arm the reference-skill hint. The SDK tool executor consumes it immediately for
  // same-run activation; it remains available to the existing continuation resolver.
  deps.rememberReferenceSkill(deps.sessionId, { id: skill.id, name: skill.name })

  const declaredBins = (skill.requiredBins || []).filter((bin) =>
    typeof bin === 'string' && bin.trim())
  const executableNote = declaredBins.length > 0
    ? `本技能声明的本机程序已直接可用：${declaredBins.join('、')}。调用时请让命令直接以这些程序名开头，不要先套 bash/sh、管道或重定向。`
    : ''
  const note = [
    '技能方法论已注入。宿主会在本次运行的下一次模型迭代开放该技能获准的工具；请立即继续当前任务，不要只给计划，也不要等待用户再次发言。',
    executableNote,
  ].filter(Boolean).join('\n')
  const header = doc
    ? `已激活技能「${skill.name}」（${skill.id}）。方法论如下${doc.truncated ? '（已截断到 12000 字，更多细节见技能的 references/）' : ''}：`
    : `已激活技能「${skill.name}」（${skill.id}）。该技能未内联方法论文档；请按技能工具的返回逐步执行。`
  const text = doc ? `${header}\n\n${doc.text}\n\n${note}` : `${header}\n\n${note}`

  return createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      skill_id: skill.id,
      activation: 'pending_same_run_refresh',
      docTruncated: doc?.truncated ?? false,
      declaredBins,
      note,
    },
  })
}
