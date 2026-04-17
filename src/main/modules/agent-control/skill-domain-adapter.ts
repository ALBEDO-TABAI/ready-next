import { filterAllowedToolNamesByPrefixes, type DomainAdapter, type DomainAdapterPrepareResult } from './domain-adapter'

const TOOL_PREFIXES = ['skill_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走 skill 执行路径。优先使用 skill_* 工具推进，不要退回无关的通用工具。'

export class SkillDomainAdapter implements DomainAdapter {
  readonly id = 'skill'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'skill'
  }

  prepare(params: Parameters<DomainAdapter['prepare']>[0]): DomainAdapterPrepareResult {
    return {
      allowedToolNames: filterAllowedToolNamesByPrefixes(params.allowedToolNames, TOOL_PREFIXES),
      sessionMessages: params.hasTools ? [{ role: 'user', content: INSTRUCTION }] : [],
      domainState: null,
    }
  }

  dispatch(): ReturnType<DomainAdapter['dispatch']> {
    return { domainState: null }
  }

  applyResult(): ReturnType<DomainAdapter['applyResult']> {
    return { domainState: null }
  }

  buildProjectionPatch(): Record<string, unknown> | null {
    return null
  }
}
