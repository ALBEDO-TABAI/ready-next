import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SkillState } from '../../skills-runtime/runtime-manager'
import { hasLocalSendImFileIntent } from '../../../../shared/remote-im-file-intent'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { rememberLastReferenceSkill, getLastReferenceSkill, peekLastReferenceSkill } from './skill-reference-hints'
import { logAgentMetric } from '../metrics'
import { emitSkillReferenceInlined } from './skill-reference-inlined-bridge'
import { isRetryOnlyTurn } from './skill-detection-inputs'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'

/**
 * Filenames we try to read from the skill's managedPath when inlining a
 * reference skill. Matches `custom-skill-registry.ts`'s search order so both
 * the old tool-call path and the new direct-read path surface the same file.
 */
const REFERENCE_SKILL_DOC_CANDIDATES = ['SKILL.md', 'README.md', 'README.zh-CN.md']

/**
 * Cap on inlined reference-skill text. Raised from 6K → 12K in Phase 2 to
 * make room for real-world skill SKILL.md files (e.g. video-copy-analyzer's
 * methodology section runs ~9KB). Larger docs still get truncated — the
 * skill author can split the long rails into README sections readable via
 * `skill_read_artifact` if needed.
 */
const REFERENCE_SKILL_INLINE_CAP_CHARS = 12_000
const REFERENCE_SKILL_PRIMITIVE_TOOL_NAMES = [
  'skill_ask_user',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_inspect_detached',
  'skill_cancel_detached',
  // RE-AUDIT FIX 5.1 followup — keep this list in lock-step with
  // PRIMITIVE_TOOL_DEFS (`tool-defs.ts`). Original Phase 5.1 added the
  // new primitive to PRIMITIVE_TOOL_DEFS + STATIC_SKILL_TOOL_NAMES but
  // forgot this hardcoded duplicate in the orchestrator. Result: the
  // tool was dispatchable but never appeared in `preferredSkillToolNames`,
  // so reference-skill turns didn't surface it as a recommended next step.
  'skill_inspect_run_state',
]
const CONTEXT_COMPACT_SKILL_ID = 'context-compact'
const CONTEXT_COMPACT_PRIMITIVE_TOOL_NAME = 'skill_compact_context'

function errorKind(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  return error instanceof Error ? error.name : typeof error
}

interface SkillToolRef {
  name?: string
  action?: string
  params?: Array<{ required?: boolean }>
  /**
   * skill-resume G2 — populated by `findSkillToolByName` (real production
   * resolver) so the orchestrator can reverse `skill_<id>_<action>` →
   * owning skill. Optional because callers that only do action-name lookup
   * (e.g. `findSkillToolBySkillAction`) don't need to round-trip the id.
   */
  skillId?: string
}

interface SkillSessionLike {
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
}

export class SkillContextOrchestrator {
  constructor(private readonly deps: {
    extractPrimaryUserInstruction: (raw: string) => string
    listSkills: () => SkillState[]
    resolveSkillToolByAction: (skillId: string, actionName: string) => SkillToolRef | null
    /**
     * skill-resume G2 — reverse lookup `skill_<id>_<action>` (or any registered
     * skill tool name) → SkillToolRef so the orchestrator can map an
     * assistant's prior tool_use back to the skill that owns it. Optional so
     * existing test mocks that don't need lookback can omit it.
     */
    resolveSkillToolByName?: (toolName: string) => SkillToolRef | null
  }) {}

  findExplicitlyRequestedSkills(userText: string): SkillState[] {
    const primary = this.deps.extractPrimaryUserInstruction(userText)
    if (!primary) return []
    const normalizedPrimary = this.normalizeLooseToken(primary)
    if (!normalizedPrimary) return []
    const aliasTokens = this.extractAliasTokens(primary)
    const skills = this.deps.listSkills()
    const exactMatches: Array<{
      skill: SkillState
      position: number
      tokenLength: number
      index: number
    }> = []
    const aliasMatches: Array<{ skill: SkillState; position: number; index: number }> = []
    const sendImSkill = skills.find((skill) => skill.id === 'send-im')
    if (sendImSkill && hasLocalSendImFileIntent(primary)) return [sendImSkill]

    skills.forEach((skill, index) => {
      const candidates = [skill.id, skill.name]
        .map((item) => this.normalizeLooseToken(item))
        .filter((item) => item.length >= 6)
      const candidateMatches = candidates
        .map((candidate) => ({
          position: normalizedPrimary.indexOf(candidate),
          tokenLength: candidate.length,
        }))
        .filter((match) => match.position >= 0)
        .sort((left, right) => left.position - right.position || right.tokenLength - left.tokenLength)
      if (candidateMatches.length > 0) {
        exactMatches.push({ skill, ...candidateMatches[0], index })
        return
      }
      const aliasPosition = aliasTokens.findIndex((alias) => this.skillMatchesAlias(skill, alias))
      if (aliasPosition >= 0) {
        aliasMatches.push({ skill, position: aliasPosition, index })
        return
      }
    })

    const strongestMatches = exactMatches.length > 0
      ? exactMatches.filter((match) => {
          return !exactMatches.some((other) => {
            if (other.skill.id === match.skill.id) return false
            const matchEnd = match.position + match.tokenLength
            const otherEnd = other.position + other.tokenLength
            return other.tokenLength > match.tokenLength
              && other.position <= match.position
              && otherEnd >= matchEnd
          })
        })
      : aliasMatches.length > 0
        ? aliasMatches
        : []

    return strongestMatches
      .sort((left, right) => left.position - right.position || left.index - right.index)
      .filter((match, index, all) => all.findIndex((entry) => entry.skill.id === match.skill.id) === index)
      .map((match) => match.skill)
      .slice(0, 2)
  }

  listRegisteredSkillTokens(): string[] {
    const tokens = new Set<string>()
    for (const skill of this.deps.listSkills()) {
      for (const raw of [skill.id, skill.name]) {
        const normalized = this.normalizeLooseToken(raw)
        if (normalized.length >= 6) tokens.add(normalized)
      }
    }
    return Array.from(tokens)
  }

  shouldKeepToolsWithVideo(userText: string, _sessionId?: string): boolean {
    const primary = this.deps.extractPrimaryUserInstruction(userText)
    // Stage Q (Stage 11) — Phase 4 retired skill_executions state
    // machine; the `hasActiveSkillExecution` shim was deleted entirely.
    // Falls back to false when no textual signal matches.
    if (!primary) return false
    const normalized = primary.toLowerCase()
    if (normalized.includes('/skill')) return true
    if (/(skill_|skill\s+get\s+state|skill_submit_|skill_restart_|skill_cancel_|技能|重跑|重做某一步|继续执行|继续这个 skill)/i.test(primary)) {
      return true
    }
    if (/(python|py\b|脚本|运行 python|执行 python|embedded python|内置 python)/i.test(primary)) {
      return true
    }
    if (this.findExplicitlyRequestedSkills(primary).length > 0) {
      return true
    }
    return false
  }

  buildPreferredSkillToolNames(userText: string, sessionId?: string): string[] {
    const toolNames = new Set<string>(REFERENCE_SKILL_PRIMITIVE_TOOL_NAMES)

    // skill-resume G6 — when a reference-skill hint is armed for THIS session,
    // any of that skill's `expose_when_hint_armed`-whitelisted internal actions
    // must also be in the preference list. Otherwise downstream
    // `filterPreferredSkillAnthropicTools` (execution-tool-skill-filters.ts)
    // sees a 4-primitive preference set and strips the typed actions out of
    // allowedToolNames — even though B2's exposure filter would have admitted
    // them. This is what made `skill_video_expert_pipeline` invisible after
    // G3 synthesized a context text on retry intent.
    const armedHint = sessionId ? getLastReferenceSkill(sessionId) : null

    const skillCandidates = this.findExplicitlyRequestedSkills(userText)
    if (armedHint && skillCandidates.length === 0 && isRetryOnlyTurn(userText)) {
      const armedSkill = this.deps.listSkills().find((skill) => skill.id === armedHint.id)
      if (armedSkill && !skillCandidates.some((skill) => skill.id === armedSkill.id)) {
        skillCandidates.push(armedSkill)
      }
    }

    if (
      skillCandidates.some((skill) => skill.id === CONTEXT_COMPACT_SKILL_ID)
      || armedHint?.id === CONTEXT_COMPACT_SKILL_ID
    ) {
      toolNames.add(CONTEXT_COMPACT_PRIMITIVE_TOOL_NAME)
    }

    for (const skill of skillCandidates) {
      const exposeWhenArmed = skill.hostRequirements?.expose_when_hint_armed ?? []
      for (const action of skill.actions) {
        const isPublic = action.visibility !== 'internal'
        const armedForThisSkill = armedHint?.id === skill.id
        const whitelistedInternal = action.visibility === 'internal'
          && armedForThisSkill
          && exposeWhenArmed.includes(action.name)
        if (!isPublic && !whitelistedInternal) continue
        const tool = this.deps.resolveSkillToolByAction(skill.id, action.name)
        if (tool?.name) toolNames.add(tool.name)
      }
    }

    // Phase 4: no active execution concept — the legacy block that added
    // running-execution tool names via listExecutions(sessionId,true) is gone.

    return Array.from(toolNames)
  }

  getCurrentReferenceSkillHint(sessionId?: string): { id: string; name: string } | null {
    const hint = getLastReferenceSkill(sessionId)
    return hint ? { id: hint.id, name: hint.name } : null
  }

  peekCurrentReferenceSkillHint(sessionId?: string): { id: string; name: string } | null {
    const hint = peekLastReferenceSkill(sessionId)
    return hint ? { id: hint.id, name: hint.name } : null
  }

  rememberReferenceSkillFromRunStateResource(
    skillId: string,
    sessionId?: string,
  ): { armed: boolean; skillId?: string; skillName?: string } {
    if (!sessionId || !skillId) return { armed: false }
    const skill = this.deps.listSkills().find((candidate) => candidate.id === skillId)
    if (!skill || !this.isReferenceLikeSkill(skill)) return { armed: false }
    rememberLastReferenceSkill(sessionId, { id: skill.id, name: skill.name })
    return { armed: true, skillId: skill.id, skillName: skill.name }
  }

  rememberExplicitReferenceSkillHint(userText: string, sessionId?: string): boolean {
    if (!sessionId) return false
    const skill = this.findExplicitlyRequestedSkills(userText)
      .find((candidate) => this.isReferenceLikeSkill(candidate))
    if (!skill) return false
    rememberLastReferenceSkill(sessionId, { id: skill.id, name: skill.name })
    return true
  }

  /**
   * skill-resume G2 — re-arm the reference-skill hint by reverse-resolving
   * skill_* tool_use names from prior assistant messages. Used by turn-engine
   * when the user fires a bare retry intent ("继续") and the in-memory hint
   * was lost (process restart, fresh session, expired TTL) but the assistant
   * recently used a reference-like skill in this session.
   *
   * Why this can't be done by `findExplicitlyRequestedSkills`: that path does
   * substring matching against normalized skill ids/names. A canonical tool
   * name like `skill_video_expert_pipeline` normalizes to
   * `skillvideoexpertpipeline` which does NOT contain
   * `videoexpertanalyzer` (the skill id) — so the lookback always failed
   * silently before this method existed.
   *
   * Returns the first armed skill (priority = newest tool_use wins, since
   * callers pass tool names in newest-first order).
   */
  rememberReferenceSkillFromPriorToolUses(
    priorToolNames: string[],
    sessionId?: string,
  ): { armed: boolean; skillId?: string; skillName?: string } {
    if (!sessionId || !priorToolNames.length) return { armed: false }
    const resolveByName = this.deps.resolveSkillToolByName
    if (!resolveByName) return { armed: false }
    const skills = this.deps.listSkills()
    for (const toolName of priorToolNames) {
      const def = resolveByName(toolName)
      if (!def?.skillId) continue
      const skill = skills.find((entry) => entry.id === def.skillId)
      if (!skill) continue
      if (!this.isReferenceLikeSkill(skill)) continue
      rememberLastReferenceSkill(sessionId, { id: skill.id, name: skill.name })
      return { armed: true, skillId: skill.id, skillName: skill.name }
    }
    return { armed: false }
  }

  // Stage Q (Stage 11) — `hasActiveSkillExecution()` shim retired.
  // Was a permanent `return false` after Phase 4 (skill_executions state
  // machine retirement). All callers now consume `restartIntentClass`
  // (turn-engine) or no-op (tests).

  async maybeInjectExplicitSkillContext(params: {
    userText: string
    session: SkillSessionLike
    sessionId?: string
    emitOutput: (chunk: string, type: string) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
    executeTool: (tool: string, args: Record<string, unknown>) => Promise<ToolExecutionOutput>
  }): Promise<void> {
    const explicitSkills = this.findExplicitlyRequestedSkills(params.userText)
    if (explicitSkills.length === 0) return

    for (const skill of explicitSkills) {
      // Phase 4: no active execution concept — the legacy "resume active
      // execution" branch that injected an execution-state probe is gone.

      const actionName = skill.defaultAction || ''
      const actionDef = skill.actions.find((action) => action.name === actionName)
      if (!actionDef) continue

      const tool = this.deps.resolveSkillToolByAction(skill.id, actionName)
      const paramsRequired = (actionDef.params || []).some((param) => param.required)

      if (actionDef.runtime !== 'reference' || paramsRequired) {
        if (!tool) continue
        params.session.messages.push({
          role: 'user',
          content: [
            `系统补充：用户明确要求优先使用 skill "${skill.name}"。`,
            `如果该 skill 对当前任务有帮助，先调用 ${tool.name}，再继续后续任务。`,
            skill.description ? `技能说明：${skill.description}` : '',
          ].filter(Boolean).join('\n'),
        })
        continue
      }

      // B Phase 1 PR2 T1-9 — prefer inline injection over the tool-call path.
      // The tool-call variant produced a visible `skill_*_read_skill` tool_use
      // event that the LLM then learned to replay in subsequent turns; the
      // new path reads SKILL.md directly and injects it as a system message,
      // side-stepping that feedback loop while also removing an entire
      // round-trip on the hot inject path.
      const inlined = this.tryInlineReferenceSkillDoc(skill)
      if (inlined.text) {
        params.session.messages.push({
          role: 'system',
          content: this.composeReferenceSystemInjection(skill, inlined.text),
        })
        logAgentMetric('skill_reference_inlined', {
          skillId: skill.id,
          source: 'direct_read',
          docBasename: inlined.basename,
          bytesInjected: inlined.text.length,
          truncated: inlined.truncated,
        })
        emitSkillReferenceInlined({
          sessionId: params.sessionId ?? null,
          skillId: skill.id,
          skillName: skill.name,
          source: 'direct_read',
          bytesInjected: inlined.text.length,
          truncated: inlined.truncated,
          at: Date.now(),
        })
        rememberLastReferenceSkill(params.sessionId, { id: skill.id, name: skill.name })
        continue
      }

      // Fallback — direct read unavailable (no managedPath, or the file was
      // missing). Keep the legacy tool-call shape so embedded skills that
      // still ship without a readable SKILL.md continue to work.
      if (!tool) continue
      const args: Record<string, unknown> = {}
      params.emitToolAction(tool.name || '', args)
      params.emitOutput(`${tool.name}(${JSON.stringify(args)})`, 'tool_use')
      const result = await params.executeTool(tool.name || '', args)
      const modelVisibleResultText = redactModelVisibleToolText(result.text)
      params.emitOutput(modelVisibleResultText.slice(0, 600), 'tool_result')
      const extractedSkillContent = this.extractSkillReferenceContent(modelVisibleResultText)
      const skillContent = extractedSkillContent.slice(
        0,
        REFERENCE_SKILL_INLINE_CAP_CHARS,
      )
      params.session.messages.push({
        role: 'user',
        content: [
          `系统补充：用户明确要求使用 skill "${skill.name}"。你必须先应用这个 skill 的方法，再继续后续浏览器或文档任务。`,
          skill.description ? `技能目标：${skill.description}` : '',
          '已读取的技能说明：',
          skillContent,
        ].filter(Boolean).join('\n'),
      })
      const fallbackBytesInjected = skillContent.length
      const fallbackTruncated = skillContent.length < extractedSkillContent.length
      logAgentMetric('skill_reference_inlined', {
        skillId: skill.id,
        source: 'tool_fallback',
        toolName: tool.name || '',
        bytesInjected: fallbackBytesInjected,
        truncated: fallbackTruncated,
      })
      emitSkillReferenceInlined({
        sessionId: params.sessionId ?? null,
        skillId: skill.id,
        skillName: skill.name,
        source: 'tool_fallback',
        bytesInjected: fallbackBytesInjected,
        truncated: fallbackTruncated,
        at: Date.now(),
      })
      // P0-T3: remember this reference skill so the primitive tools
      // (skill_ask_user / skill_run_shell / ...) stay session-gated correctly
      // and the next turn knows which skill methodology was loaded.
      rememberLastReferenceSkill(params.sessionId, { id: skill.id, name: skill.name })
    }
  }

  /**
   * Attempt to read the skill's SKILL.md (falling back to README variants)
   * directly from the managedPath. Returns null when the skill was registered
   * without a managedPath, the managedPath doesn't exist, or every candidate
   * file is missing — callers should fall back to the tool-call path.
   */
  private tryInlineReferenceSkillDoc(skill: SkillState): {
    text: string
    basename: string
    truncated: boolean
  } | { text: null; basename: null; truncated: false } {
    const root = skill.managedPath
    if (!root || !existsSync(root)) {
      return { text: null, basename: null, truncated: false }
    }
    const readFailures: Array<{ basename: string; path: string; errorKind: string }> = []
    for (const basename of REFERENCE_SKILL_DOC_CANDIDATES) {
      const absPath = join(root, basename)
      if (!existsSync(absPath)) continue
      try {
        const raw = readFileSync(absPath, 'utf-8')
        const truncated = raw.length > REFERENCE_SKILL_INLINE_CAP_CHARS
        const text = truncated ? raw.slice(0, REFERENCE_SKILL_INLINE_CAP_CHARS) : raw
        return { text, basename, truncated }
      } catch (error) {
        readFailures.push({ basename, path: absPath, errorKind: errorKind(error) })
        // Permission or read failure — try the next candidate, then fall
        // through to the tool-call path. Don't bubble the error; the whole
        // reference-skill inject is best-effort.
        continue
      }
    }
    for (const failure of readFailures) {
      logAgentMetric(TOOL_ERROR_METRICS.skillReferenceInlineFailed, {
        skillId: skill.id,
        basename: failure.basename,
        path: failure.path,
        errorKind: failure.errorKind,
      })
    }
    return { text: null, basename: null, truncated: false }
  }

  private composeReferenceSystemInjection(skill: SkillState, docText: string): string {
    const childLoopActions = new Set(skill.childLoop?.actions || [])
    const childLoopToolNames = skill.actions
      .filter((action) => childLoopActions.has(action.name))
      .map((action) => this.deps.resolveSkillToolByAction(skill.id, action.name)?.name || null)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
    const longTaskGuidance = childLoopToolNames.length > 0
      ? `本技能的长任务已由 Ready child-loop 接管；启动或续跑时优先直接调用 ${childLoopToolNames.join(' / ')}，不要用 skill_start_detached 包一层。`
      : '如需执行脚本或观察产物状态，只使用本轮已开放的技能工具；不要假设存在后台 detached 启动工具。'
    const header = `已加载技能「${skill.name}」。请直接按此方法论输出结果。任务承诺多份文件交付时，先用 declare_completion_criteria.expected_outputs 声明每份最终文件路径。如需向用户追问、确认或选择才能继续，单个问题调用 skill_ask_user；需要同时询问多个问题 / 多个维度时调用 ask_user_questions，让反问以逐题分页卡片出现并一次性提交；不要把“需要补充的信息 / 请选择 / 请确认”写成普通正文，也不要把多个问题塞进 skill_ask_user.options。任务已经完成、文件已经保存或产物已经输出后，不要再调用反问工具询问“完成/调整/生成效果图”等可选后续，只在普通总结里简短问用户是否需要调整。如需执行脚本或读写技能产物，用 skill_run_shell / skill_write_artifact / skill_read_artifact；如果用户要求输出/保存到指定本地路径或文件夹，先用 skill_write_artifact 写入相对路径，再用 skill_export_artifact 导出到目标绝对路径；不要把用户目标文件夹的绝对路径传给 skill_write_artifact。长文档如只缺尾部章节，必须对同一 relativePath 使用 mode="append" 追加补齐，不要用 overwrite 重写已有草稿。${longTaskGuidance}`
    const goal = skill.description ? `技能目标：${skill.description}` : ''
    return [header, goal, '技能说明正文：', docText].filter(Boolean).join('\n')
  }

  private isReferenceLikeSkill(skill: SkillState): boolean {
    if (skill.executionMode === 'advisory') return true
    return skill.actions.some((action) => action.runtime === 'reference')
  }

  private extractSkillReferenceContent(resultText: string): string {
    const text = String(resultText || '').trim()
    const stdoutMarker = 'STDOUT:\n'
    const stdoutIndex = text.indexOf(stdoutMarker)
    if (stdoutIndex >= 0) {
      return text.slice(stdoutIndex + stdoutMarker.length).trim()
    }
    return text
  }

  private normalizeLooseToken(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '')
      .trim()
  }

  private extractAliasTokens(value: string): string[] {
    const tokens = String(value || '').match(/[A-Z][A-Z0-9]{1,9}/g) || []
    return Array.from(new Set(tokens.map((token) => token.toLowerCase())))
  }

  private skillMatchesAlias(skill: SkillState, alias: string): boolean {
    const candidates = this.skillAliasCandidates(skill)
    return candidates.some((candidate) => {
      if (candidate === alias) return true
      return alias.length >= 3 && candidate.length > alias.length && candidate.startsWith(alias)
    })
  }

  private skillAliasCandidates(skill: SkillState): string[] {
    const words = `${skill.name} ${skill.id}`
      .replace(/\([^)]*\)/g, ' ')
      .split(/[^A-Za-z0-9]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 0)
    const aliases = new Set<string>()
    const acronym = words.map((word) => word[0]).join('').toLowerCase()
    if (acronym.length >= 2) aliases.add(acronym)
    for (const word of words) {
      if (/^[A-Z0-9]{2,10}$/.test(word)) aliases.add(word.toLowerCase())
    }
    return Array.from(aliases)
  }

}
