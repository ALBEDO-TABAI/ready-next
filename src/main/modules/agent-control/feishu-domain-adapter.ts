import { filterAllowedToolNamesByPrefixes, type DomainAdapter, type DomainAdapterPrepareResult } from './domain-adapter'

const TOOL_PREFIXES = ['feishu_', 'memory_', 'session_']
const INSTRUCTION = '系统执行器：本轮走飞书执行路径。优先使用 feishu_* 工具完成任务，不要改走无关工具。'

export class FeishuDomainAdapter implements DomainAdapter {
  readonly id = 'feishu'

  shouldHandle(params: Parameters<DomainAdapter['shouldHandle']>[0]): boolean {
    return params.route.executor === 'feishu'
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
