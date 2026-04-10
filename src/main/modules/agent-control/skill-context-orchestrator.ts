import type { SkillState } from '../skills-runtime/runtime-manager'

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
    listExecutions: (limit: number, sessionId?: string, activeOnly?: boolean) => Array<{ id: string; skillId: string; entryAction: string }>
    resolveSkillToolByAction: (skillId: string, actionName: string) => SkillToolRef | null
  }) {}

  findExplicitlyRequestedSkills(userText: string): SkillState[] {
    const primary = this.deps.extractPrimaryUserInstruction(userText)
    if (!primary || !/(skill|技能|使用|用|调用|参考|套用|运用)/i.test(primary)) return []
    const normalizedPrimary = this.normalizeLooseToken(primary)
    const skills = this.deps.listSkills()
    return skills.filter((skill, index) => {
      const candidates = [skill.id, skill.name]
        .map((item) => this.normalizeLooseToken(item))
        .filter((item) => item.length >= 3)
      const matched = candidates.some((candidate) => normalizedPrimary.includes(candidate))
      if (!matched) return false
      return skills.findIndex((entry) => entry.id === skill.id) === index
    }).slice(0, 2)
  }

  shouldKeepToolsWithVideo(userText: string, sessionId?: string): boolean {
    const primary = this.deps.extractPrimaryUserInstruction(userText)
    if (!primary) return this.hasActiveSkillExecution(sessionId)
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
    return this.hasActiveSkillExecution(sessionId)
  }

  buildPreferredSkillToolNames(userText: string, sessionId?: string): string[] {
    const toolNames = new Set<string>([
      'skill_get_state',
      'skill_submit_input',
      'skill_submit_confirmation',
      'skill_submit_agent_result',
      'skill_restart_from_step',
      'skill_cancel_execution',
      'system_run_embedded_python',
    ])

    const explicitSkills = this.findExplicitlyRequestedSkills(userText)
    for (const skill of explicitSkills) {
      for (const action of skill.actions.filter((item) => item.visibility !== 'internal')) {
        const tool = this.deps.resolveSkillToolByAction(skill.id, action.name)
        if (tool?.name) toolNames.add(tool.name)
      }
    }

    if (sessionId) {
      const activeExecutions = this.deps.listExecutions(10, sessionId, true)
      for (const execution of activeExecutions) {
        const tool = this.deps.resolveSkillToolByAction(execution.skillId, execution.entryAction)
        if (tool?.name) toolNames.add(tool.name)
      }
    }

    return Array.from(toolNames)
  }

  hasActiveSkillExecution(sessionId?: string): boolean {
    if (!sessionId) return false
    try {
      return this.deps.listExecutions(5, sessionId, true).length > 0
    } catch {
      return false
    }
  }

  async maybeInjectExplicitSkillContext(params: {
    userText: string
    session: SkillSessionLike
    sessionId?: string
    emitOutput: (chunk: string, type: string) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
    executeTool: (tool: string, args: Record<string, unknown>) => Promise<string>
  }): Promise<void> {
    const explicitSkills = this.findExplicitlyRequestedSkills(params.userText)
    if (explicitSkills.length === 0) return

    for (const skill of explicitSkills) {
      const activeExecution = params.sessionId
        ? this.deps.listExecutions(10, params.sessionId, true).find((item) => item.skillId === skill.id)
        : null
      if (activeExecution) {
        const args: Record<string, unknown> = { executionId: activeExecution.id }
        params.emitToolAction('skill_get_state', args)
        params.emitOutput(`skill_get_state(${JSON.stringify(args)})`, 'tool_use')
        const result = await params.executeTool('skill_get_state', args)
        params.emitOutput(result.slice(0, 600), 'tool_result')
        params.session.messages.push({
          role: 'user',
          content: [
            `系统补充：技能 "${skill.name}" 在当前会话已有活跃 execution。`,
            '必须先基于以下 execution 状态继续推进，而不是重新启动一个新的 workflow：',
            result,
          ].join('\n'),
        })
        continue
      }

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

      const args: Record<string, unknown> = {}
      params.emitToolAction(tool.name || '', args)
      params.emitOutput(`${tool.name}(${JSON.stringify(args)})`, 'tool_use')
      const result = await params.executeTool(tool.name || '', args)
      params.emitOutput(result.slice(0, 600), 'tool_result')
      const skillContent = this.extractSkillReferenceContent(result).slice(0, 6_000)
      params.session.messages.push({
        role: 'user',
        content: [
          `系统补充：用户明确要求使用 skill "${skill.name}"。你必须先应用这个 skill 的方法，再继续后续浏览器或文档任务。`,
          skill.description ? `技能目标：${skill.description}` : '',
          '已读取的技能说明：',
          skillContent,
        ].filter(Boolean).join('\n'),
      })
    }
  }

  private extractSkillReferenceContent(result: string): string {
    const text = String(result || '').trim()
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
