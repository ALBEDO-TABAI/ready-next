import { filterAllowedToolNamesByPrefixes, type DomainAdapter, type DomainAdapterPrepareResult } from './domain-adapter'

const TOOL_PREFIXES = ['rss_', 'skill_rss_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走 RSS 执行路径。优先使用 rss_* 或 skill_rss_* 工具完成任务，不要改走无关工具。'

export class RSSDomainAdapter implements DomainAdapter {
  readonly id = 'rss'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'rss'
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
