import { requestModuleAgentAction } from '../../utils/moduleAgentBridge'
import { createAgentArtifact, mergeArtifacts } from './scopeRunState'
import { mapToolActionToDocAction, performDocAction } from './documentActions'
import type { AgentArtifact, AgentModuleKind, ScopeRunState, ToolTraceEvent } from './types'

function toExecutionKind(tool: string): ScopeRunState['executionKind'] {
  if (tool === 'video.renderExport') return 'job'
  if (tool === 'rss.analyzeItem') return 'pipeline'
  if (tool.startsWith('design.') || tool.startsWith('browser.')) return 'interactive'
  return 'deterministic'
}

async function dispatchModuleAction(
  module: 'design' | 'video' | 'rss' | 'calendar',
  action: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await requestModuleAgentAction({ module, action, args }, { timeoutMs: 4000, pollIntervalMs: 40 }) as Record<string, unknown>
}

function normalizeArtifacts(
  payload: Record<string, unknown>,
  module: AgentModuleKind,
  runId: string | null,
): AgentArtifact[] {
  return Array.isArray(payload.artifactRefs)
    ? payload.artifactRefs
      .map((item) => item && typeof item === 'object'
        ? createAgentArtifact(item as Record<string, unknown>, module, runId)
        : null)
      .filter(Boolean) as AgentArtifact[]
    : []
}

interface HandleModuleToolActionParams {
  scopeId: string
  agentName: string
  tool: string
  args: Record<string, unknown>
  runId: string | null
  activateWorkbenchMode: (mode: 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar') => void
  upsertScopeRunState: (scopeId: string, updater: (previous: ScopeRunState | null) => ScopeRunState) => void
}

export async function handleModuleToolAction(params: HandleModuleToolActionParams): Promise<boolean> {
  const { scopeId, agentName, tool, args, runId, activateWorkbenchMode, upsertScopeRunState } = params
  if (!tool) return false

  const pushTrace = (
    kind: ToolTraceEvent['kind'],
    text: string,
    phase: ScopeRunState['phase'] = 'tool_running',
    patch?: Partial<ScopeRunState>,
  ) => {
    upsertScopeRunState(scopeId, (previous) => ({
      scopeId,
      agent: previous?.agent || agentName,
      requestId: previous?.requestId || runId,
      phase,
      toolTrace: [
        ...(previous?.toolTrace || []),
        {
          id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind,
          text,
          timestamp: new Date(),
        },
      ],
      startedAt: previous?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      latestText: patch?.latestText ?? previous?.latestText ?? null,
      module: patch?.module ?? previous?.module ?? null,
      intent: patch?.intent ?? previous?.intent ?? null,
      executionKind: patch?.executionKind ?? previous?.executionKind ?? null,
      jobId: patch?.jobId ?? previous?.jobId ?? null,
      artifactRefs: mergeArtifacts(previous?.artifactRefs, patch?.artifactRefs),
      memoryRefs: patch?.memoryRefs ?? previous?.memoryRefs ?? [],
      triggerHits: patch?.triggerHits ?? previous?.triggerHits ?? [],
      contextBudget: patch?.contextBudget ?? previous?.contextBudget ?? null,
      ownerResourceId: patch?.ownerResourceId ?? previous?.ownerResourceId ?? null,
      lastEvidenceAt: patch?.lastEvidenceAt ?? previous?.lastEvidenceAt ?? null,
      blockedReason: patch?.blockedReason ?? previous?.blockedReason ?? null,
      controllerId: patch?.controllerId ?? previous?.controllerId ?? null,
      ownerTabId: patch?.ownerTabId ?? previous?.ownerTabId ?? null,
      checkpointExpiresAt: patch?.checkpointExpiresAt ?? previous?.checkpointExpiresAt ?? null,
      responseMessageId: patch?.responseMessageId ?? previous?.responseMessageId ?? null,
      responseBuffer: patch?.responseBuffer ?? previous?.responseBuffer ?? '',
      stepMetrics: patch?.stepMetrics ?? previous?.stepMetrics ?? {
        toolCalls: 0,
        toolResults: 0,
        lastToolAt: null,
      },
      error: previous?.error || null,
      ...patch,
    }))
  }

  if (tool === 'app.switchMode') {
    const mode = args.mode
    if (typeof mode === 'string' && ['browser', 'document', 'design', 'video', 'rss', 'calendar'].includes(mode)) {
      activateWorkbenchMode(mode as 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar')
    }
    pushTrace('result', `已切换到 ${String(mode || '指定')} 模式。`)
    return true
  }

  if (tool === 'app.notify') {
    const text = typeof args.message === 'string' ? args.message : ''
    if (text) pushTrace('result', `通知：${text}`)
    return true
  }

  if (tool === 'document.writeFile') {
    const path = typeof args.path === 'string' ? args.path : ''
    const content = typeof args.content === 'string' ? args.content : ''
    if (!path) {
      pushTrace('result', '文档工具执行失败：document.writeFile 缺少 path。', 'error')
      return true
    }
    pushTrace('call', `写入文档：${path}`)
    const summaries = [
      await performDocAction({ type: 'open_tab', path }),
      await performDocAction({ type: 'set_content', content }),
      await performDocAction({ type: 'save_tab' }),
    ]
    const artifact = createAgentArtifact({ kind: 'document-save', label: path, path, mimeType: 'text/plain' }, 'document', runId)
    pushTrace('result', summaries.join('；'), 'tool_running', {
      module: 'document',
      intent: 'write_document_file',
      executionKind: 'deterministic',
      ownerResourceId: path,
      artifactRefs: artifact ? [artifact] : [],
      lastEvidenceAt: new Date().toISOString(),
    })
    return true
  }

  const docAction = mapToolActionToDocAction(tool, args)
  if (docAction) {
    pushTrace('call', `执行 ${tool}`, 'tool_running', { module: 'document', executionKind: 'deterministic' })
    const summary = await performDocAction(docAction)
    pushTrace('result', summary, 'tool_running', {
      module: 'document',
      intent: tool,
      executionKind: 'deterministic',
      lastEvidenceAt: new Date().toISOString(),
    })
    return true
  }

  if (tool.startsWith('design.') || tool.startsWith('video.') || tool.startsWith('rss.') || tool.startsWith('calendar.')) {
    const module = tool.startsWith('design.')
      ? 'design'
      : tool.startsWith('video.')
        ? 'video'
        : tool.startsWith('rss.')
          ? 'rss'
          : 'calendar'
    activateWorkbenchMode(module)
    pushTrace('call', `执行 ${tool}`, 'tool_running', { module, executionKind: toExecutionKind(tool) })
    const payload = await dispatchModuleAction(module, tool, args)
    const artifacts = normalizeArtifacts(payload, module, runId)
    pushTrace('result', String(payload.summary || `${tool} 已完成`), 'tool_running', {
      module,
      intent: typeof payload.intent === 'string' ? payload.intent : tool,
      executionKind: toExecutionKind(tool),
      jobId: typeof payload.jobId === 'string' ? payload.jobId : null,
      artifactRefs: artifacts,
      ownerResourceId: typeof payload.ownerResourceId === 'string' ? payload.ownerResourceId : null,
      lastEvidenceAt: new Date().toISOString(),
    })
    return true
  }

  return false
}
