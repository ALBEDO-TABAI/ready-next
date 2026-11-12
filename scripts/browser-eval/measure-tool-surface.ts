import { listLiveCodexThreadToolDefinitions } from '../../src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import { buildReadyToolSurface, selectCodexRootToolDefinitions } from '../../src/main/modules/agent-control/codex-runtime/codex-tool-surface'

const surface = buildReadyToolSurface({ surfaceId: 'browser-eval-measure',
  toolDefinitions: selectCodexRootToolDefinitions(listLiveCodexThreadToolDefinitions()) })
const measure = (tools: unknown[]) => ({ tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)),
  estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(tools)) / 4) })
console.log(JSON.stringify({ method: 'UTF-8 JSON bytes / 4, rounded up; eagerly expanded schemas only, not billing or tool search overhead',
  status: '当前未启用延迟加载；before 与 after 均为当前完整工具面，不代表历史版本对比',
  before: measure(surface.responsesTools), after: measure(surface.responsesTools), registered: measure(surface.responsesTools),
  deferred: [],
}, null, 2))
