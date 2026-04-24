import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { SkillState } from '../skills-runtime/runtime-manager'
import type { ToolExecutionOutput } from './tool-result-types'
import { rememberLastReferenceSkill } from './skill-reference-hints'
import { logAgentMetric } from './metrics'

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

interface SkillToolRef {
  name?: string
  action?: string
  params?: Array<{ required?: boolean }>
}

interface SkillSessionLike {
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
}

export class SkillContextOrchestrator {
  constructor(private readonly deps: {
    extractPrimaryUserInstruction: (raw: string) => string
    listSkills: () => SkillState[]
    resolveSkillToolByAction: (skillId: string, actionName: string) => SkillToolRef | null
    // B Phase 4 PR2: `listExecutions` dep retired — the skill_executions
    // state machine is being decommissioned; `activeExecution`-branched
    // code paths in this class are replaced with single inline-injection
    // flow. Tests carrying the old dep shape are updated alongside.
  }) {}

  findExplicitlyRequestedSkills(userText: string): SkillState[] {
    const primary = this.deps.extractPrimaryUserInstruction(userText)
    if (!primary) return []
    const normalizedPrimary = this.normalizeLooseToken(primary)
    if (!normalizedPrimary) return []
    const skills = this.deps.listSkills()
    return skills.filter((skill, index) => {
      const candidates = [skill.id, skill.name]
        .map((item) => this.normalizeLooseToken(item))
        .filter((item) => item.length >= 6)
      const matched = candidates.some((candidate) => normalizedPrimary.includes(candidate))
      if (!matched) return false
      return skills.findIndex((entry) => entry.id === skill.id) === index
    }).slice(0, 2)
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

  shouldKeepToolsWithVideo(userText: string, sessionId?: string): boolean {
    void sessionId
    const primary = this.deps.extractPrimaryUserInstruction(userText)
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
    // B Phase 4 PR2: the 6 execution-control tools were deleted from the
    // LLM surface; seed the preferred-tool set only with the surviving
    // system-level Python runner plus per-skill action tools below. The
    // signature retains sessionId for caller compat only.
    void sessionId
    const toolNames = new Set<string>([
      'system_run_embedded_python',
    ])

    const explicitSkills = this.findExplicitlyRequestedSkills(userText)
    for (const skill of explicitSkills) {
      for (const action of skill.actions.filter((item) => item.visibility !== 'internal')) {
        const tool = this.deps.resolveSkillToolByAction(skill.id, action.name)
        if (tool?.name) toolNames.add(tool.name)
      }
    }

    return Array.from(toolNames)
  }

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

    // B Phase 4 PR2: the `activeExecution` fan-out (invoking
    // `skill_get_state` when the session had an in-flight workflow) is
    // retired — no skill creates executions any more, so this branch was
    // unreachable. Every explicit skill mention now goes through the
    // single inline-injection path below. PR3 drops the runtime state
    // machine; this change decouples orchestrator cleanup from that work.
    for (const skill of explicitSkills) {
      const tool = this.deps.resolveSkillToolByAction(skill.id, skill.defaultAction || '')
      const actionDef = skill.actions.find((action) => action.name === (tool?.action || skill.defaultAction || ''))
      if (!tool || !actionDef) continue

      if (actionDef.runtime !== 'reference' || (tool.params || []).some((param) => param.required)) {
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
        rememberLastReferenceSkill(params.sessionId, { id: skill.id, name: skill.name })
        continue
      }

      // Fallback — direct read unavailable (no managedPath, or the file was
      // missing). Keep the legacy tool-call shape so embedded skills that
      // still ship without a readable SKILL.md continue to work.
      const args: Record<string, unknown> = {}
      params.emitToolAction(tool.name || '', args)
      params.emitOutput(`${tool.name}(${JSON.stringify(args)})`, 'tool_use')
      const result = await params.executeTool(tool.name || '', args)
      params.emitOutput(result.text.slice(0, 600), 'tool_result')
      const skillContent = this.extractSkillReferenceContent(result.text).slice(
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
      logAgentMetric('skill_reference_inlined', {
        skillId: skill.id,
        source: 'tool_fallback',
        toolName: tool.name || '',
        bytesInjected: skillContent.length,
        truncated: skillContent.length < this.extractSkillReferenceContent(result.text).length,
      })
      // P0-T3: remember this reference skill so that if the LLM still tries to
      // fabricate a skill_submit_* call, the error message can tell it the
      // loaded skill has no workflow state rather than the generic
      // "call skill_get_state" guidance.
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
    for (const basename of REFERENCE_SKILL_DOC_CANDIDATES) {
      const absPath = join(root, basename)
      if (!existsSync(absPath)) continue
      try {
        const raw = readFileSync(absPath, 'utf-8')
        const truncated = raw.length > REFERENCE_SKILL_INLINE_CAP_CHARS
        const text = truncated ? raw.slice(0, REFERENCE_SKILL_INLINE_CAP_CHARS) : raw
        return { text, basename, truncated }
      } catch {
        // Permission or read failure — try the next candidate, then fall
        // through to the tool-call path. Don't bubble the error; the whole
        // reference-skill inject is best-effort.
        continue
      }
    }
    return { text: null, basename: null, truncated: false }
  }

  private composeReferenceSystemInjection(skill: SkillState, docText: string): string {
    const header = `已加载技能「${skill.name}」。请直接按此方法论输出结果，不要调 skill_*_read_skill 或 skill_submit_* / skill_restart_* / skill_cancel_execution 工具。如需向用户追问细节，用 skill_ask_user；如需执行脚本或读写文件，用 skill_run_shell / skill_write_artifact / skill_read_artifact。`
    const goal = skill.description ? `技能目标：${skill.description}` : ''
    return [header, goal, '技能说明正文：', docText].filter(Boolean).join('\n')
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
}
