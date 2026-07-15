import { requestModuleAgentAction } from '../../utils/moduleAgentBridge'
import { createAgentArtifact, mergeArtifacts } from './scopeRunState'
import {
  classifyDocActionFailureReason,
  classifyDocActionMutationOutcome,
  getActiveDocumentSnapshot,
  mapToolActionToDocAction,
  performDocAction,
  performDocActionWithMetadata,
} from './documentActions'
import type { AgentArtifact, AgentModuleKind, ScopeRunState, ScopeRunTaskStepStatus, ToolTraceEvent } from './types'
import { useDocTabs } from '../../stores/useDocTabs'

function toExecutionKind(tool: string): ScopeRunState['executionKind'] {
  if (tool === 'rss.analyzeItem') return 'pipeline'
  if (tool.startsWith('browser.')) return 'interactive'
  return 'deterministic'
}

async function dispatchModuleAction(
  module: 'rss' | 'calendar',
  action: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = 4000
  return await requestModuleAgentAction({ module, action, args }, { timeoutMs, pollIntervalMs: 40 }) as Record<string, unknown>
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

function createSingleStepTask(title: string, detail: string, timestamp: string, status: ScopeRunState['phase'] = 'tool_running'): Pick<
  ScopeRunState,
  'taskTitle' | 'taskSummary' | 'steps' | 'currentStepId' | 'waitingFor' | 'resumableActions'
> {
  const stepStatus: ScopeRunTaskStepStatus = status === 'error' ? 'error' : status === 'done' ? 'done' : 'running'
  return {
    taskTitle: title,
    taskSummary: detail,
    steps: [{
      id: 'execute',
      title: detail,
      status: stepStatus,
      updatedAt: timestamp,
    }],
    currentStepId: 'execute',
    waitingFor: 'none',
    resumableActions: ['cancel'],
  }
}

function setTagForgeCreationPending(tabId: string, pending: boolean): void {
  useDocTabs.setState((state) => ({
    tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, tagForgeCreationPending: pending || undefined } : tab),
  }))
}

async function canMarkTagForgeCreation(path: string | undefined): Promise<boolean> {
  if (!path) return true
  const documentApi = (globalThis as typeof globalThis & { window?: Window }).window?.electronAPI?.document
  if (!documentApi) return false
  const result = await documentApi.readFile(path).catch(() => null)
  return result?.success === false && result.errorCode === 'FILE_NOT_FOUND'
}

async function refreshCleanTagForgeTabFromDisk(tabId: string, path: string): Promise<void> {
  const before = useDocTabs.getState().tabs.find((tab) => tab.id === tabId)
  if (!before || before.isDirty || before.path !== path) return
  const documentApi = (globalThis as typeof globalThis & { window?: Window }).window?.electronAPI?.document
  const result = await documentApi?.readFile(path).catch(() => null)
  const content = result?.success
    ? typeof result.content === 'string'
      ? result.content
      : result.data?.type === 'text'
        ? result.data.content
        : null
    : null
  const current = useDocTabs.getState().tabs.find((tab) => tab.id === tabId)
  if (content === null || !current || current.isDirty || current.path !== path) return
  useDocTabs.getState().setTabContent(tabId, content)
  useDocTabs.getState().markTabSaved(tabId)
}

interface HandleModuleToolActionParams {
  scopeId: string
  agentName: string
  tool: string
  args: Record<string, unknown>
  runId: string | null
  activateWorkbenchMode: (mode: 'browser' | 'document' | 'rss' | 'calendar') => void
  upsertScopeRunState: (scopeId: string, updater: (previous: ScopeRunState | null) => ScopeRunState) => void
  getScopeRunState?: () => ScopeRunState | null
  tagForgeAPI?: Window['electronAPI']['tagForge']
}

export interface ModuleToolActionExecutionResult {
  handled: boolean
  payload?: Record<string, unknown>
}

export async function executeModuleToolAction(
  params: HandleModuleToolActionParams,
): Promise<ModuleToolActionExecutionResult> {
  const { scopeId, agentName, tool, args, runId, activateWorkbenchMode, upsertScopeRunState, getScopeRunState } = params
  if (!tool) return { handled: false }

  if(tool==='tagForge.checkRevision'){
    const path=typeof args.path==='string'?args.path:'';const tab=useDocTabs.getState().tabs.find((item)=>item.path===path)
    return{handled:true,payload:{ok:!tab?.isDirty,open:Boolean(tab),errorKind:tab?.isDirty?'open_tab_revision_conflict':undefined}}
  }
  if(tool==='tagForge.applyContent'){
    const path=typeof args.path==='string'?args.path:'';const content=typeof args.content==='string'?args.content:'';const state=useDocTabs.getState();const tab=state.tabs.find((item)=>item.path===path)
    if(tab?.isDirty)return{handled:true,payload:{ok:false,errorKind:'open_tab_revision_conflict'}}
    if(tab){state.setTabContent(tab.id,content);state.markTabSaved(tab.id)}
    return{handled:true,payload:{ok:true,open:Boolean(tab)}}
  }

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
      designPhase: patch?.designPhase ?? previous?.designPhase ?? null,
      designTodo: patch?.designTodo ?? previous?.designTodo ?? [],
      designReviewSummary: patch?.designReviewSummary ?? previous?.designReviewSummary ?? null,
      ownedNodeIds: patch?.ownedNodeIds ?? previous?.ownedNodeIds ?? [],
      repairScope: patch?.repairScope ?? previous?.repairScope ?? null,
      scenePlanId: patch?.scenePlanId ?? previous?.scenePlanId ?? null,
      boardId: patch?.boardId ?? previous?.boardId ?? null,
      styleSystem: patch?.styleSystem ?? previous?.styleSystem ?? null,
      reviewFailures: patch?.reviewFailures ?? previous?.reviewFailures ?? [],
      lastAcceptedScreenshot: patch?.lastAcceptedScreenshot ?? previous?.lastAcceptedScreenshot ?? null,
      taskTitle: patch?.taskTitle ?? previous?.taskTitle ?? null,
      taskSummary: patch?.taskSummary ?? previous?.taskSummary ?? null,
      steps: patch?.steps ?? previous?.steps ?? [],
      currentStepId: patch?.currentStepId ?? previous?.currentStepId ?? null,
      waitingFor: patch?.waitingFor ?? previous?.waitingFor ?? 'none',
      resumableActions: patch?.resumableActions ?? previous?.resumableActions ?? [],
      recentArtifacts: mergeArtifacts(previous?.recentArtifacts, patch?.recentArtifacts),
      taskContinuation: patch?.taskContinuation ?? previous?.taskContinuation ?? null,
      memoryCapture: patch?.memoryCapture ?? previous?.memoryCapture ?? null,
      error: previous?.error || null,
      ...patch,
    }))
  }

  if (tool === 'app.switchMode') {
    const mode = args.mode
    if (typeof mode === 'string' && ['browser', 'document', 'rss', 'calendar'].includes(mode)) {
      activateWorkbenchMode(mode as 'browser' | 'document' | 'rss' | 'calendar')
    }
    pushTrace('result', `已切换到 ${String(mode || '指定')} 模式。`)
    return {
      handled: true,
      payload: {
        intent: 'app.switchMode',
        summary: `已切换到 ${String(mode || '指定')} 模式。`,
      },
    }
  }

  if (tool === 'app.notify') {
    const text = typeof args.message === 'string' ? args.message : ''
    if (text) pushTrace('result', `通知：${text}`)
    return {
      handled: true,
      payload: {
        intent: 'app.notify',
        summary: text ? `通知：${text}` : '通知已发送。',
      },
    }
  }

  if (tool === 'renderer:present-file') {
    // Stage R PR-R3 — present_file delivers an artifact reference (path inside
    // <outputsRoot>) to the user. Path was already sandbox-validated by main
    // (`resolveReadableWithinRoot` in present-file.ts). Here we just publish
    // a recentArtifacts entry so the file shows up in ChatPanel and emit a
    // result trace so the user sees the present action.
    const path = typeof args.path === 'string' ? args.path : ''
    const reason = typeof args.reason === 'string' && args.reason ? args.reason : null
    if (!path) {
      return {
        handled: true,
        payload: {
          intent: 'renderer:present-file',
          status: 'failed',
          summary: 'present_file 缺少 path。',
        },
      }
    }
    const fileLabel = path.split(/[/\\]/).pop() || path
    const artifact = createAgentArtifact(
      { kind: 'present-file', label: fileLabel, path },
      'research',
      runId,
    )
    const summary = reason ? `已呈现文件 ${fileLabel}：${reason}` : `已呈现文件 ${fileLabel}`
    pushTrace('result', summary, 'tool_running', {
      module: 'research',
      intent: 'renderer:present-file',
      executionKind: 'deterministic',
      ownerResourceId: path,
      artifactRefs: artifact ? [artifact] : [],
      recentArtifacts: artifact ? [artifact] : [],
      lastEvidenceAt: new Date().toISOString(),
    })
    return {
      handled: true,
      payload: {
        intent: 'renderer:present-file',
        status: 'presented',
        summary,
        path,
      },
    }
  }

  if (tool === 'document.writeFile') {
    const path = typeof args.path === 'string' ? args.path : ''
    const content = typeof args.content === 'string' ? args.content : ''
    if (!path) {
      pushTrace('result', '文档工具执行失败：document.writeFile 缺少 path。', 'error')
      return {
        handled: true,
        payload: {
          intent: 'write_document_file',
          summary: '文档工具执行失败：document.writeFile 缺少 path。',
          status: 'failed',
        },
      }
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
      ...createSingleStepTask('文档任务', `写入文档：${path}`, new Date().toISOString()),
    })
    return {
      handled: true,
      payload: {
        intent: 'write_document_file',
        summary: summaries.join('；'),
      },
    }
  }

  if (tool === 'document.inspectActive') {
    pushTrace('call', '读取当前活动文档快照', 'tool_running', {
      module: 'document',
      executionKind: 'deterministic',
    })
    const snapshot = getActiveDocumentSnapshot(typeof args.tabId === 'string' ? args.tabId : undefined)
    const summary = snapshot
      ? `已读取当前文档快照：${snapshot.title}（${snapshot.charCount} 字）`
      : '当前没有可读取的活动文档'
    pushTrace('result', summary, 'tool_running', {
      module: 'document',
      intent: tool,
      executionKind: 'deterministic',
      lastEvidenceAt: new Date().toISOString(),
      ...createSingleStepTask('文档任务', summary, new Date().toISOString()),
    })
    return {
      handled: true,
      payload: {
        intent: tool,
        summary,
        snapshot,
      },
    }
  }

  const docAction = mapToolActionToDocAction(tool, args)
  if (docAction) {
    pushTrace('call', `执行 ${tool}`, 'tool_running', { module: 'document', executionKind: 'deterministic' })
    const tagForgeApi=params.tagForgeAPI??(globalThis as typeof globalThis&{window?:Window}).window?.electronAPI?.tagForge
    const tabIdsBefore=docAction.type==='new_tab'?new Set(useDocTabs.getState().tabs.map((tab)=>tab.id)):null
    const canMarkCreation=docAction.type==='new_tab'?await canMarkTagForgeCreation(typeof docAction.path==='string'?docAction.path:undefined):false
    const preSaveSnapshot=docAction.type==='save_tab'?getActiveDocumentSnapshot(typeof args.tabId==='string'?args.tabId:undefined):null
    const preSaveTab=preSaveSnapshot?useDocTabs.getState().tabs.find((tab)=>tab.id===preSaveSnapshot.tabId):null
    const creationPending=preSaveTab?.tagForgeCreationPending===true
    const result = await performDocActionWithMetadata(docAction)
    let summary = result.summary
    const failureReason = classifyDocActionFailureReason(docAction, summary)
    const payload: Record<string, unknown> = {
      intent: tool,
      summary,
    }
    Object.assign(payload, classifyDocActionMutationOutcome(docAction, summary))
    if(docAction.type==='new_tab'&&runId&&tabIdsBefore&&canMarkCreation){const created=useDocTabs.getState().tabs.find((tab)=>!tabIdsBefore.has(tab.id));if(created)setTagForgeCreationPending(created.id,true)}
    if (result.document) {
      payload.document = result.document
      payload.documentTabId = result.document.tabId
      payload.documentTitle = result.document.title
      payload.documentPath = result.document.path
      payload.documentDirty = result.document.dirty
      payload.documentRequiresSave = result.document.requiresSave
      payload.documentSaveState = result.document.saveState
    }
    const mutationReason = typeof payload.mutationReason === 'string' ? payload.mutationReason : ''
    let actionFailed = Boolean(failureReason)
      || payload.ok === false
      || mutationReason === 'validation_failed'
      || mutationReason === 'rejected'
      || mutationReason === 'no_match'
      || mutationReason === 'cancelled'
    const artifact = docAction.type === 'save_tab' && payload.documentSaved === true && typeof payload.documentPath === 'string'
      ? createAgentArtifact(
        {
          kind: 'delivered_file',
          label: payload.documentPath.split(/[/\\]/).pop() || payload.documentPath,
          path: payload.documentPath,
          mimeType: String(payload.documentPath).toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain',
          meta: {
            deliverySource: 'document.saveTab',
            deliveryStatus: 'verified',
            requestedTarget: true,
          },
        },
        'document',
        runId,
      )
      : null
    const saveConfirmed=docAction.type==='save_tab'&&typeof payload.documentPath==='string'&&(payload.documentSaved===true||/文档未改动，已跳过保存/.test(summary))
    if(saveConfirmed&&runId&&result.document?.tabId&&typeof payload.documentPath==='string'&&tagForgeApi){
      const root=String(window.localStorage?.getItem('ready-workspace-root')||'').trim()
      const proposals=Array.isArray(args.tagProposals)?args.tagProposals:[]
      const isMarkdown=payload.documentPath.toLowerCase().endsWith('.md')
      if(root&&isMarkdown){
        const latest=getActiveDocumentSnapshot(result.document.tabId)
        const prepared=latest?await tagForgeApi.prepareCreation({
          sourceRunId:runId,
          path:payload.documentPath,
          workspaceRoots:[root],
          content:latest.content,
          proposals:proposals as Array<{facet:'form'|'domain'|'entity'|'use';label:string;evidenceCode:string;evidenceExcerpt:string;confidence:number}>,
          creationPending,
        }).catch(()=>null):null
        if(prepared?.success&&prepared.data){
          payload.tagForgeReceiptId=prepared.data.receiptId
          useDocTabs.getState().setTabContent(result.document.tabId,prepared.data.content)
          const enriched=await performDocActionWithMetadata({type:'save_tab',tabId:result.document.tabId,path:payload.documentPath})
          const enrichmentSaved=!classifyDocActionFailureReason({type:'save_tab'},enriched.summary)&&(/已保存文档|文档未改动，已跳过保存/.test(enriched.summary))
          if(enrichmentSaved){
            const finalized=await tagForgeApi.finalizeCreation({receiptId:prepared.data.receiptId,sourceRunId:runId,path:payload.documentPath,workspaceRoots:[root]}).catch(()=>null)
            if(finalized?.success&&finalized.data){
              payload.tagForgeEnrichmentRequired=false;payload.tagForgeReceiptId=finalized.data.receiptId;payload.tagForgeExpectedRevision=finalized.data.revision;payload.tagForgeStatus='completed'
              setTagForgeCreationPending(result.document.tabId,false)
            }else{
              await refreshCleanTagForgeTabFromDisk(result.document.tabId,payload.documentPath)
              payload.tagForgeEnrichmentRequired=true;payload.tagForgeStatus='failed_retryable';payload.tagForgeError=finalized?.error||'自动标签未完成，正文已正常保存';payload.errorKind='tag_forge_finalize_failed';payload.recoverable=true
            }
          }else{
            payload.tagForgeEnrichmentRequired=true;payload.tagForgeStatus='failed_retryable';payload.tagForgeError='标签内容保存失败';payload.errorKind='tag_forge_save_failed';payload.recoverable=true
          }
        }else if(prepared?.success===false){
          const failure=prepared as typeof prepared&{data?:{receiptId?:string}|null;errorKind?:string;missingContentFacets?:string[];rejectedLabels?:string[]}
          payload.tagForgeEnrichmentRequired=true;payload.tagForgeStatus='failed_retryable';payload.tagForgeError=prepared.error||'自动标签未完成，正文已正常保存';payload.errorKind=failure.errorKind||'tag_forge_validation_failed';payload.recoverable=true
          if(failure.data?.receiptId)payload.tagForgeReceiptId=failure.data.receiptId
          if(Array.isArray(failure.missingContentFacets))payload.tagForgeMissingContentFacets=failure.missingContentFacets
          if(Array.isArray(failure.rejectedLabels))payload.tagForgeRejectedLabels=failure.rejectedLabels
        }else if(prepared?.success&&prepared.data===null&&creationPending){
          setTagForgeCreationPending(result.document.tabId,false)
        }else if(creationPending){
          payload.tagForgeEnrichmentRequired=true;payload.tagForgeStatus='failed_retryable';payload.tagForgeError='自动标签连接中断，正文已正常保存';payload.errorKind='tag_forge_prepare_unavailable';payload.recoverable=true
        }
      }else if(isMarkdown&&creationPending){
        payload.tagForgeEnrichmentRequired=true;payload.tagForgeStatus='failed_retryable';payload.tagForgeError='无法确认文档所属工作区';payload.errorKind='tag_forge_workspace_required';payload.recoverable=true
      }
    }
    if(payload.tagForgeEnrichmentRequired===true){actionFailed=true;summary=`正文已保存，标签尚未补全，系统将自动重试：${String(payload.documentPath||'当前文档')}`;payload.summary=summary;payload.ok=false;payload.done=false;payload.status='pending'}
    const tracePhase: ScopeRunState['phase'] = actionFailed ? 'error' : 'tool_running'
    pushTrace('result', summary, tracePhase, {
      module: 'document',
      intent: tool,
      executionKind: 'deterministic',
      lastEvidenceAt: new Date().toISOString(),
      ...(artifact ? { artifactRefs: [artifact], recentArtifacts: [artifact] } : {}),
      ...createSingleStepTask('文档任务', summary, new Date().toISOString(), tracePhase),
    })
    if (artifact) {
      payload.artifactRefs = [artifact]
      payload.recentArtifacts = [artifact]
    }
    if (failureReason) {
      payload.ok = false
      payload.reason = failureReason
    } else if (actionFailed) {
      payload.ok = false
      payload.reason = 'document_action_failed'
    }
    return {
      handled: true,
      payload,
    }
  }

  if (tool.startsWith('rss.') || tool.startsWith('calendar.')) {
    const module = tool.startsWith('rss.') ? 'rss' : 'calendar'
    // Calendar registers its agent handler unconditionally (its scene is always
    // mounted), so calendar tools run in the background without yanking the
    // visible mode. RSS still mounts/registers lazily, so it keeps the switch.
    if (module === 'rss') activateWorkbenchMode(module)
    pushTrace('call', `执行 ${tool}`, 'tool_running', {
      module,
      executionKind: toExecutionKind(tool),
      ...createSingleStepTask(module === 'rss' ? 'RSS 任务' : '日程任务', `执行 ${tool}`, new Date().toISOString()),
    })
    const progress = (event: Record<string, unknown>) => {
      const kind = event.kind === 'call' ? 'call' : 'result'
      const text = typeof event.text === 'string' ? event.text : ''
      if (!text) return
      pushTrace(kind, text, 'tool_running', {
        module,
        executionKind: toExecutionKind(tool),
      })
    }
    const payload = await dispatchModuleAction(module, tool, {
      ...args,
      __scopeRunId: runId,
      __scopeId: scopeId,
      ...(progress ? { __onProgress: progress } : {}),
    })
    if (Array.isArray(payload.toolEvents) && payload.streamedToolEvents !== true) {
      for (const event of payload.toolEvents) {
        if (!event || typeof event !== 'object') continue
        const kind = event.kind === 'call' ? 'call' : 'result'
        const text = typeof event.text === 'string' ? event.text : ''
        if (!text) continue
        pushTrace(kind, text, 'tool_running', {
          module,
          executionKind: toExecutionKind(tool),
        })
      }
    }
    const artifacts = normalizeArtifacts(payload, module, runId)
    pushTrace('result', String(payload.summary || `${tool} 已完成`), 'tool_running', {
      module,
      intent: typeof payload.intent === 'string' ? payload.intent : tool,
      executionKind: toExecutionKind(tool),
      jobId: typeof payload.jobId === 'string' ? payload.jobId : null,
      artifactRefs: artifacts,
      ownerResourceId: typeof payload.ownerResourceId === 'string' ? payload.ownerResourceId : null,
      lastEvidenceAt: new Date().toISOString(),
      ...createSingleStepTask(module === 'rss' ? 'RSS 任务' : '日程任务', String(payload.summary || `${tool} 已完成`), new Date().toISOString()),
    })
    return {
      handled: true,
      payload,
    }
  }

  return { handled: false }
}

export async function handleModuleToolAction(params: HandleModuleToolActionParams): Promise<boolean> {
  const result = await executeModuleToolAction(params)
  return result.handled
}
