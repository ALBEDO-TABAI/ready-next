import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs } from '../../stores/useDocTabs'
import { useMode } from '../../stores/useMode'
import type { AgentMessage, ChatAttachment } from './types'
import { diagnoseAgentPanelSnapshot } from './agent-panel-test-harness-diagnostics'
import {
  asRecord,
  createAgentPanelSnapshot,
  extractToolNameFromTraceText,
  taskCardFromProjection,
} from './agent-panel-test-harness-snapshot'
import type {
  AgentPanelHarnessEvent,
  AgentPanelSessionSummary,
  AgentPanelSnapshot,
  AgentPanelSubmitResult,
  AgentPanelSubmitOptions,
  AgentPanelTaskCardSnapshot,
  AgentPanelTestAttachmentInput,
  AgentPanelTestHarness,
  AgentPanelTestWorkspaceResult,
  StoreLike,
  StoreState,
  SendMessageResultLike
} from './agent-panel-test-harness-types'
export function shouldEnableHarness(): boolean {
  if (typeof window === 'undefined') return false
  const meta = import.meta as unknown as { env?: { DEV?: boolean } }
  if (meta.env?.DEV) return true
  try {
    const params = new URLSearchParams(window.location.search || '')
    if (params.get('agentTest') === '1' || params.get('readyAgentTest') === '1') return true
  } catch {
    // silent-catch: URL parsing is only an optional harness enable signal.
  }
  try {
    return (
      window.localStorage?.getItem('ready.agentPanelTest') === '1' ||
      window.localStorage?.getItem('ready:agent:test') === '1'
    )
  } catch {
    // silent-catch: localStorage can be blocked; that just leaves the harness disabled.
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function basenameFromPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path
}

function extensionFromPath(path: string): string {
  const name = basenameFromPath(path)
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function typeFromExtension(ext: string): ChatAttachment['type'] {
  const normalized = ext.toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.heic'].includes(normalized)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'].includes(normalized)) return 'video'
  if (['.md', '.txt', '.json', '.csv', '.html', '.xml', '.yaml', '.yml'].includes(normalized)) return 'text'
  if (['.xls', '.xlsx', '.tsv'].includes(normalized)) return 'spreadsheet'
  return 'other'
}

async function hydrateAttachment(input: AgentPanelTestAttachmentInput): Promise<ChatAttachment> {
  const path = String(input.path || '').trim()
  if (!path) throw new Error('attachment path is required')
  const stat = await window.electronAPI?.document?.stat?.(path).catch(() => null)
  const data = stat && typeof stat === 'object' && 'success' in stat && stat.success ? stat.data : null
  const ext = input.ext || (typeof data?.extension === 'string' ? data.extension : extensionFromPath(path))
  return {
    id: `test-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name || basenameFromPath(path),
    path,
    type: input.type || typeFromExtension(ext),
    size: typeof input.size === 'number' ? input.size : (typeof data?.size === 'number' ? data.size : 0),
    ext,
    source: input.source || 'file',
    isDirectory: typeof input.isDirectory === 'boolean' ? input.isDirectory : Boolean(data?.isDirectory),
  }
}

function buildTestAttachmentPathContext(attachments: ChatAttachment[]): string {
  const lines = attachments
    .filter((attachment) => typeof attachment.path === 'string' && attachment.path.trim())
    .map((attachment) => `- ${attachment.name || basenameFromPath(attachment.path)}: ${attachment.path}`)
  if (lines.length === 0) return ''
  return [
    '--- 测试模式附件路径 ---',
    '以下路径来自测试 harness 注入，等同于用户已附加的本地文件；需要处理附件时优先使用这些绝对路径。',
    ...lines,
  ].join('\n')
}

async function setDomTextareaValue(text: string): Promise<boolean> {
  if (typeof document === 'undefined') return false
  let textarea: HTMLTextAreaElement | null = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_500) {
    const candidate = document.querySelector('[data-ready-agent-input="true"]') as HTMLTextAreaElement | null
    if (candidate && !candidate.disabled) {
      textarea = candidate
      break
    }
    await delay(50)
  }
  if (!textarea) return false
  textarea.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) {
    setter.call(textarea, text)
  } else {
    textarea.value = text
  }
  const inputEvent = typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
    : new Event('input', { bubbles: true })
  textarea.dispatchEvent(inputEvent)
  await delay(0)
  return true
}

async function submitViaDom(text: string): Promise<boolean> {
  const changed = await setDomTextareaValue(text)
  if (!changed || typeof document === 'undefined') return false
  let sendButton: HTMLButtonElement | null = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_500) {
    const candidate = document.querySelector('[data-ready-agent-send="true"]') as HTMLButtonElement | null
    if (candidate && !candidate.disabled) {
      sendButton = candidate
      break
    }
    await delay(50)
  }
  if (!sendButton) return false
  await delay(100)
  if (sendButton.disabled) return false
  sendButton.click()
  await delay(0)
  return true
}

function hasSubmittedUserMessage(
  messages: AgentMessage[],
  beforeMessageCount: number,
  normalizedText: string,
): boolean {
  return Boolean(
    messages
      .slice(beforeMessageCount)
      .find((message) => message.type === 'user' && message.content.trim() === normalizedText)
    || messages.find((message) => message.type === 'user' && message.content.trim() === normalizedText),
  )
}

async function waitForDomSubmitEvidence(
  store: StoreLike,
  beforeMessageCount: number,
  normalizedText: string,
): Promise<{ submitted: boolean; started: boolean }> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1_500) {
    const state = store.getState()
    const currentRun = state.currentScopeId ? state.scopeRunStates[state.currentScopeId] || null : null
    if (hasSubmittedUserMessage(state.messages, beforeMessageCount, normalizedText)) {
      return { submitted: true, started: true }
    }
    if (
      state.isStreaming
      || state.foregroundBusy
      || Boolean(currentRun?.requestId)
      || Boolean(currentRun?.taskId)
    ) {
      return { submitted: false, started: true }
    }
    await delay(50)
  }
  return { submitted: false, started: false }
}

async function loadProjectionCards(
  scopeId: string | null,
  expectedMessageVisibilityEpoch: number | null,
): Promise<AgentPanelTaskCardSnapshot[]> {
  if (!scopeId || expectedMessageVisibilityEpoch === null || typeof window === 'undefined') return []
  const listTaskProjections = window.electronAPI?.agent?.listTaskProjections
  if (!listTaskProjections) return []
  const result = await Promise.race([
    listTaskProjections(scopeId).catch(() => null),
    delay(1_500).then(() => null),
  ])
  if (!result?.success || !Array.isArray(result.data)) return []
  return result.data
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .filter((item) => item.scopeId === scopeId
      && item.messageVisibilityEpoch === expectedMessageVisibilityEpoch)
    .map(taskCardFromProjection)
}

export function createAgentPanelTestHarness(store: StoreLike): AgentPanelTestHarness {
  let seq = 0
  const events: AgentPanelHarnessEvent[] = []
  const maxEvents = 300
  const pushEvent = (kind: AgentPanelHarnessEvent['kind'], state: StoreState, detail: Record<string, unknown>) => {
    events.push({
      seq: ++seq,
      kind,
      capturedAt: new Date().toISOString(),
      scopeId: state.currentScopeId || null,
      detail,
    })
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
  }

  const unsubscribe = store.subscribe?.((state, previous) => {
    if (state.currentScopeId !== previous.currentScopeId) {
      pushEvent('scope', state, { from: previous.currentScopeId, to: state.currentScopeId })
    }
    if (state.messages.length !== previous.messages.length) {
      pushEvent('message_count', state, { from: previous.messages.length, to: state.messages.length })
    }
    const run = state.currentScopeId ? state.scopeRunStates[state.currentScopeId] || null : null
    const previousRun = previous.currentScopeId ? previous.scopeRunStates[previous.currentScopeId] || null : null
    if (run?.phase !== previousRun?.phase || run?.terminalReason !== previousRun?.terminalReason) {
      pushEvent('phase', state, {
        phase: run?.phase || null,
        terminalReason: run?.terminalReason || null,
      })
    }
    if ((run?.toolTrace.length || 0) !== (previousRun?.toolTrace.length || 0)) {
      pushEvent('tool_trace', state, {
        from: previousRun?.toolTrace.length || 0,
        to: run?.toolTrace.length || 0,
      })
    }
    if (Boolean(run?.softError) !== Boolean(previousRun?.softError)) {
      pushEvent('soft_error', state, { present: Boolean(run?.softError) })
    }
  })
  const unsubscribeStream = window.electronAPI?.agent?.onStream?.((data) => {
    if (data.type !== 'done') return
    pushEvent('stream_done', store.getState(), {
      runId: data.runId || null,
      canonicalMessageId: data.canonicalMessage?.id || null,
      canonicalMessageDigest: data.canonicalMessageDigest || null,
    })
  })

  const snapshot = async (): Promise<AgentPanelSnapshot> => {
    const state = store.getState()
    const scopeId = state.currentScopeId
    const expectedMessageVisibilityEpoch = scopeId
      && state.currentScope?.id === scopeId
      && Number.isSafeInteger(state.currentScope.messageVisibilityEpoch)
      ? state.currentScope.messageVisibilityEpoch
      : null
    const projectionCards = await loadProjectionCards(scopeId, expectedMessageVisibilityEpoch)
    const current = store.getState()
    const authorityStillCurrent = current.currentScopeId === scopeId
      && current.currentScope?.id === scopeId
      && current.currentScope.messageVisibilityEpoch === expectedMessageVisibilityEpoch
    return createAgentPanelSnapshot(current, authorityStillCurrent ? projectionCards : [])
  }

  const waitForIdle = async (options: { timeoutMs?: number; pollMs?: number } = {}) => {
    const timeoutMs = Math.max(500, options.timeoutMs || 45_000)
    const pollMs = Math.max(25, options.pollMs || 100)
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const current = createAgentPanelSnapshot(store.getState())
      if (
        !current.composer.locked &&
        !current.runtime.foregroundBusy
      ) {
        return snapshot()
      }
      await delay(pollMs)
    }
    const timedOut = await snapshot()
    timedOut.diagnostics = [
      ...timedOut.diagnostics,
      {
        id: 'wait_for_idle_timeout',
        severity: 'error',
        layer: 'runtime',
        message: '等待 Agent 面板空闲超时。',
        evidence: { timeoutMs },
      },
    ]
    return timedOut
  }

  const submit = async (
    text: string,
    options: AgentPanelSubmitOptions = {},
  ): Promise<AgentPanelSubmitResult> => {
    const before = await snapshot()
    let attached: ChatAttachment[] = []
    if (options.attachments?.length) {
      attached = await attachFiles(options.attachments)
    }
    const attachmentContext = buildTestAttachmentPathContext(attached)
    const messageText = attachmentContext ? `${text.trim()}\n\n${attachmentContext}` : text
    const normalizedText = messageText.trim()
    const mode = options.mode || 'dom'
    if (options.codexExternalReadSlice && mode !== 'store') throw new Error(
      'codex_external_read_slice_requires_store_mode',
    )
    const allowStoreFallback = options.allowStoreFallback !== false
    let inputMode: 'dom' | 'store' = mode
    let sendResult: SendMessageResultLike | null = null
    let domSubmitted = false
    let domClickSubmitted = false
    let domRunStarted = false
    if (mode === 'dom') {
      const maxDomAttempts = allowStoreFallback ? 1 : 3
      for (let attempt = 0; attempt < maxDomAttempts; attempt += 1) {
        domClickSubmitted = await submitViaDom(messageText) || domClickSubmitted
        if (domClickSubmitted) {
          const evidence = await waitForDomSubmitEvidence(store, before.messages.length, normalizedText)
          domSubmitted = evidence.submitted
          domRunStarted = domRunStarted || evidence.started
        }
        if (domSubmitted) break
        await delay(250)
      }
    }

    if ((!domClickSubmitted || (!domSubmitted && !domRunStarted)) && allowStoreFallback) {
      inputMode = 'store'
      const state = store.getState()
      state.setInputValue(messageText, { preserveContinuationIntent: true })
      const sendPromise = state.sendMessage(messageText, options.codexExternalReadSlice
        ? { codexExternalReadSlice: options.codexExternalReadSlice }
        : undefined)
      if (options.awaitStoreSend === false) {
        void sendPromise.catch(() => {})
      } else {
        sendResult = await sendPromise
      }
    } else if (domClickSubmitted && (domSubmitted || domRunStarted)) {
      inputMode = 'dom'
    }

    const after = options.waitForIdle === false
      ? await snapshot()
      : await waitForIdle({ timeoutMs: options.timeoutMs, pollMs: options.pollMs })
    const diagnostics = diagnoseAgentPanelSnapshot(after)
    const submittedUserMessage = after.messages
      .slice(before.messages.length)
      .find((message) => message.type === 'user' && message.content.trim() === normalizedText)
      || after.messages.find((message) => message.type === 'user' && message.content.trim() === normalizedText)
    const hasRunEvidence = Boolean(
      after.runtime.activeRun?.requestId
      || after.runtime.activeRun?.taskId
      || after.toolTrace.length > before.toolTrace.length
      || after.messages.length > before.messages.length + (submittedUserMessage ? 1 : 0),
    )
    if (!submittedUserMessage) {
      diagnostics.push({
        id: 'send_returned_without_user_message',
        severity: 'error',
        layer: 'send',
        message: 'sendMessage 返回后面板没有出现对应用户消息，测试不能判定为通过。',
        evidence: {
          sendResult,
          beforeMessageCount: before.messages.length,
          afterMessageCount: after.messages.length,
          currentScopeId: after.currentScopeId,
        },
      })
    } else if (!hasRunEvidence) {
      diagnostics.push({
        id: 'send_returned_without_run_evidence',
        severity: 'error',
        layer: 'runtime',
        message: '用户消息已出现，但没有任务卡、运行态或工具记录，测试不能判定为通过。',
        evidence: {
          sendResult,
          currentScopeId: after.currentScopeId,
          activeRun: after.runtime.activeRun,
        },
      })
    }
    if (
      options.requireAssistantMessage
      && !after.messages.slice(before.messages.length).some(
        (message) => message.type === 'agent' && message.content.trim().length > 0,
      )
    ) {
      diagnostics.push({
        id: 'assistant_message_missing',
        severity: 'error',
        layer: 'runtime',
        message: '本轮没有产生新的 Agent 最终回复，测试不能判定为通过。',
        evidence: {
          sendResult,
          beforeMessageCount: before.messages.length,
          afterMessageCount: after.messages.length,
          currentScopeId: after.currentScopeId,
        },
      })
    }
    const observedToolNames = Array.from(new Set(after.toolTrace
      .filter((item) => item.kind === 'call')
      .map((item) => extractToolNameFromTraceText(item.text))
      .filter((name): name is string => Boolean(name))))
    for (const expectedToolName of options.expectedToolNames || []) {
      if (observedToolNames.includes(expectedToolName)) continue
      diagnostics.push({
        id: 'expected_tool_not_called',
        severity: 'error',
        layer: 'tool',
        message: `测试要求调用 ${expectedToolName}，但面板工具轨迹中没有出现。`,
        evidence: { expectedToolName, observedToolNames },
      })
    }
    for (const forbiddenToolName of options.forbiddenToolNames || []) {
      if (!observedToolNames.includes(forbiddenToolName)) continue
      diagnostics.push({
        id: 'forbidden_tool_called',
        severity: 'error',
        layer: 'tool',
        message: `测试禁止调用 ${forbiddenToolName}，但面板工具轨迹中出现了该工具。`,
        evidence: { forbiddenToolName, observedToolNames },
      })
    }
    return {
      ok: diagnostics.every((item) => item.severity !== 'error'),
      inputMode,
      sendResult,
      before,
      after,
      diagnostics,
    }
  }

  const answerPendingAskUserQuestions: AgentPanelTestHarness['answerPendingAskUserQuestions'] = async (options = {}) => {
    const state = store.getState()
    const message = [...state.messages].reverse().find((item) =>
      item.type === 'ask_user_questions'
      && item.askUserQuestions?.status === 'pending'
      && Array.isArray(item.askUserQuestions.questions)
      && item.askUserQuestions.questions.length > 0)
    const card = message?.askUserQuestions
    if (!card) return { success: false, error: 'no pending ask_user_questions card' }
    const answers: Array<{ id: string; answer: string | string[] }> = []
    for (const question of card.questions) {
      if (question.kind === 'single_choice') {
        const first = question.options?.[0]
        if (first) answers.push({ id: question.id, answer: first })
      } else if (question.kind === 'multi_choice') {
        const first = question.options?.[0]
        if (first) answers.push({ id: question.id, answer: [first] })
      } else {
        answers.push({ id: question.id, answer: options.freeText || '测试选择' })
      }
    }
    const api = window.electronAPI?.agentInteraction
    if (!api) return { success: false, cardId: card.cardId, answers, error: 'agentInteraction API not available' }
    const result = await api.submitAskUserQuestions({ cardId: card.cardId, answers })
    const response = result as { success?: boolean; error?: string }
    if (response.success && store.setState) {
      const answeredAt = Date.now()
      const current = store.getState()
      const markSubmitted = (messages: AgentMessage[]): AgentMessage[] => messages.map((item) => {
        if (item.id !== card.cardId || item.type !== 'ask_user_questions' || !item.askUserQuestions) return item
        return {
          ...item,
          askUserQuestions: {
            ...item.askUserQuestions,
            status: 'submitted' as const,
            answers,
            answeredAt,
          },
        }
      })
      let nextSessions = current.sessions
      if (current.sessions) {
        for (const [sessionId, session] of Object.entries(current.sessions)) {
          if (!session.messages?.some((item) => item.id === card.cardId)) continue
          nextSessions = {
            ...nextSessions,
            [sessionId]: {
              ...session,
              messages: markSubmitted(session.messages),
            },
          }
        }
      }
      store.setState({
        messages: markSubmitted(current.messages),
        sessions: nextSessions,
      })
    }
    return {
      success: response.success === true,
      cardId: card.cardId,
      answers,
      error: response.error,
    }
  }

  const attachFiles = async (files: AgentPanelTestAttachmentInput[]): Promise<ChatAttachment[]> => {
    const state = store.getState()
    if (!state.addAttachments) throw new Error('agent store does not expose addAttachments')
    const attachments = await Promise.all(files.map(hydrateAttachment))
    state.addAttachments(attachments)
    return attachments
  }

  const clearAttachments = (): void => {
    store.getState().clearAttachments?.()
  }

  const createSession = async (): Promise<AgentPanelSnapshot> => {
    const beforeScopeId = store.getState().currentScopeId
    const createNewSession = store.getState().createNewSession
    if (!createNewSession) throw new Error('createNewSession not available')
    const result = await createNewSession()
    if (!result.ok) throw new Error(result.code)
    const startedAt = Date.now()
    while (Date.now() - startedAt < 5_000) {
      const current = store.getState()
      if (current.currentScopeId && current.currentScopeId !== beforeScopeId) break
      await delay(50)
    }
    store.getState().setInputValue('', { preserveContinuationIntent: true })
    const clearStartedAt = Date.now()
    while (Date.now() - clearStartedAt < 1_500) {
      if (!store.getState().inputValue) break
      await delay(50)
    }
    return snapshot()
  }

  const prepareWorkspace = async (
    root: string,
    options: { reindex?: boolean } = {},
  ): Promise<AgentPanelTestWorkspaceResult> => {
    const normalizedRoot = String(root || '').trim()
    if (!normalizedRoot) return { ok: false, root: normalizedRoot, error: 'workspace root is required' }
    try {
      window.localStorage?.setItem('ready-workspace-root', normalizedRoot)
    } catch {
      // silent-catch: the persisted workspace hint is optional for harness-driven tests;
      // localStorage may be unavailable in some renderer sandboxes and that just leaves the
      // hint unset for the next reload.
    }
    const validation = useWorkspace.getState().setWorkspaceRoot(normalizedRoot)
    if (!validation.ok) {
      return {
        ok: false,
        root: normalizedRoot,
        error: validation.message || validation.reason || 'workspace root rejected',
      }
    }
    if (options.reindex === false) return { ok: true, root: normalizedRoot }
    const reindex = await window.electronAPI?.document?.reindexWorkspace?.(normalizedRoot)
    if (!reindex?.success) {
      return { ok: false, root: normalizedRoot, reindex, error: reindex?.error || 'reindex failed' }
    }
    return { ok: true, root: normalizedRoot, reindex }
  }

  const sessionSummary = (): AgentPanelSessionSummary => {
    const state = store.getState()
    const order = Array.isArray(state.sessionOrder) ? state.sessionOrder : []
    const sessions = state.sessions || {}
    return {
      activeSessionId: state.activeSessionId || null,
      sessionOrder: [...order],
      currentScopeId: state.currentScopeId || null,
      sessions: order.map((id) => {
        const session = sessions[id] || {}
        const messages = Array.isArray(session.messages) ? session.messages : []
        return {
          id,
          conversationId: session.conversationId || null,
          state: session.state || null,
          inputValue: session.inputValue || '',
          messageCount: messages.length,
          pendingAskUserCount: messages.filter((message) =>
            message.type === 'ask_user_questions'
            && message.askUserQuestions?.status === 'pending'
          ).length,
        }
      }),
    }
  }

  const createVisibleSession: AgentPanelTestHarness['createVisibleSession'] = async () => {
    const createNewSession = store.getState().createNewSession
    if (!createNewSession) {
      return { ok: false, summary: sessionSummary(), error: 'createNewSession not available' }
    }
    const result = await createNewSession()
    if (!result.ok) return { ok: false, summary: sessionSummary(), error: result.code }
    const id = store.getState().activeSessionId || null
    if (!id) return { ok: false, id, summary: sessionSummary(), error: 'visible session id missing' }
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const summary = sessionSummary()
      if (summary.activeSessionId === id && summary.sessionOrder.includes(id)) {
        return { ok: true, id, summary }
      }
      await delay(50)
    }
    return { ok: false, id, summary: sessionSummary(), error: 'visible session did not become active' }
  }

  const activateSession: AgentPanelTestHarness['activateSession'] = async (id) => {
    const normalizedId = String(id || '').trim()
    if (!normalizedId) {
      return { ok: false, id: normalizedId, summary: sessionSummary(), snapshot: await snapshot(), error: 'session id is required' }
    }
    const state = store.getState()
    if (!state.sessionOrder?.includes(normalizedId)) {
      return { ok: false, id: normalizedId, summary: sessionSummary(), snapshot: await snapshot(), error: 'session not visible' }
    }
    if (!state.setActiveSessionId) {
      return { ok: false, id: normalizedId, summary: sessionSummary(), snapshot: await snapshot(), error: 'setActiveSessionId not available' }
    }
    state.setActiveSessionId(normalizedId)
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2_000) {
      const current = store.getState()
      if (current.activeSessionId === normalizedId) {
        return { ok: true, id: normalizedId, summary: sessionSummary(), snapshot: await snapshot() }
      }
      await delay(50)
    }
    return { ok: false, id: normalizedId, summary: sessionSummary(), snapshot: await snapshot(), error: 'session did not become active' }
  }

  const setDocumentFixture: AgentPanelTestHarness['setDocumentFixture'] = async (input) => {
    const title = String(input.title || '').trim()
    if (!title) return { ok: false, error: 'document title is required' }
    const state = useDocTabs.getState()
    let tabId = String(input.tabId || '').trim()
    if (tabId && !state.tabs.some((tab) => tab.id === tabId)) {
      return { ok: false, error: 'document fixture tab not found' }
    }
    if (!tabId) {
      tabId = state.createBackgroundTab({ title, content: input.content })
    } else {
      state.renameTab(tabId, title)
      state.setTabContent(tabId, input.content)
    }
    useMode.getState().setAppMode('workbench')
    useMode.getState().setWorkbenchMode('document')
    useDocTabs.getState().setActiveTab(tabId)
    await delay(100)
    const current = useDocTabs.getState().tabs.find((tab) => tab.id === tabId)
    if (!current || useMode.getState().workbenchMode !== 'document') {
      return { ok: false, error: 'document fixture did not become visible' }
    }
    return {
      ok: true,
      tabId,
      title: current.title,
      contentLength: current.content.length,
    }
  }

  return {
    snapshot,
    diagnose: async () => (await snapshot()).diagnostics,
    submit,
    answerPendingAskUserQuestions,
    attachFiles,
    clearAttachments,
    createSession,
    prepareWorkspace,
    waitForIdle,
    sessionSummary,
    createVisibleSession,
    activateSession,
    setDocumentFixture,
    events: () => [...events],
    clearEvents: () => {
      events.splice(0, events.length)
    },
    dispose: () => {
      unsubscribe?.()
      unsubscribeStream?.()
      if (typeof window !== 'undefined' && window.__READY_AGENT_TEST__) {
        delete window.__READY_AGENT_TEST__
      }
    },
  }
}
