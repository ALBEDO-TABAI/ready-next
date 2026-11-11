import { listLiveCodexThreadToolDefinitions } from '../../src/main/modules/agent-control/runtime-core/agent-sdk-tool-executor'
import { buildReadyToolSurface, selectCodexRootToolDefinitions } from '../../src/main/modules/agent-control/codex-runtime/codex-tool-surface'

const surface = buildReadyToolSurface({ surfaceId: 'browser-eval-measure',
  toolDefinitions: selectCodexRootToolDefinitions(listLiveCodexThreadToolDefinitions()) })
const before = surface.responsesTools.map(({ defer_loading: _deferred, ...tool }) => tool)
const eager = surface.responsesTools.filter(tool => !tool.defer_loading)
const measure = (tools: unknown[]) => ({ tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)),
  estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(tools)) / 4) })
console.log(JSON.stringify({ method: 'UTF-8 JSON bytes / 4, rounded up; eagerly expanded schemas only, not billing or tool search overhead',
  before: measure(before), after: measure(eager), registered: measure(surface.responsesTools),
  deferred: surface.dynamicTools.filter(tool => tool.deferLoading).map(tool => tool.name),
}, null, 2))
