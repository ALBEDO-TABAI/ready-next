import { useEffect } from 'react'
import { create } from 'zustand'
import type { BrowserUserAttention } from '../../../shared/browser-user-attention'
import type { BrowserDownloadReceipt } from '../../../shared/browser-download-receipt'
import { useAgent } from '../../stores/useAgent'
import { isForegroundBusyScopeRunState } from '../agent/scopeRunState'
import type { AgentMessage, ScopeRunState } from '../agent/types'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'

/*
 * The assistant's browser tasks as the interface shows them (W7 §4.7, §4.10): the tabs each task owns, whether it is
 * running, whether it needs the person (login, captcha, takeover, review rejected) and the files it downloaded.
 * Main owns every fact; this store only mirrors what Main returns and never guesses a state Main did not report.
 *
 * When to re-read is decided in one place: every trigger calls requestBrowserTaskReread(reason). The triggers:
 *   attention    Main's push agent:browserTaskAttentionChanged: a need was recorded or answered (the need itself)
 *   mount        the workbench opened
 *   tabs         a tab opened or closed (task tabs come and go)
 *   claims       the lease push shows a task holding or releasing a page (running, or its run ended)
 *   run-ended    a run in the assistant finished (files it downloaded)
 *   card         a task card mounted
 *   tab-visible  a task's tab became the visible page
 *   acted        the help button's input was refused or finished
 * Needs are never polled: the push names the task and its conversation, and the need is read from Main then.
 */

export type BrowserTaskRereadReason =
  | 'attention' | 'mount' | 'tabs' | 'claims' | 'run-ended' | 'card' | 'tab-visible' | 'acted'

export type BrowserTaskState = 'running' | 'needs_user' | 'done'
export const BROWSER_TASK_STATE_LABEL: Record<BrowserTaskState, string> = {
  running: '运行中',
  needs_user: '等你处理',
  done: '已完成',
}

export interface BrowserTaskRecord {
  browserTaskId: string
  /** When this window first saw the task; keeps the sidebar order stable. */
  seenAt: number
  parentTaskId: string | null
  ownerRunId: string | null
  /** The conversation the task belongs to, once known. */
  scopeId: string | null
  /** What the person asked for, shortened; null until known. */
  title: string | null
  /** The tabs Main lists for the task, in Main's order. */
  tabIds: string[]
  /** The tabs a run of the task is holding right now. */
  heldTabIds: string[]
  attention: BrowserUserAttention | null
  receipts: BrowserDownloadReceipt[]
}

/** One help input per task: sending, admitted (the run continues), or refused with the reason in plain words. */
export interface BrowserTaskAction {
  attentionId: string
  phase: 'sending' | 'sent' | 'refused'
  message?: string
}

interface BrowserTaskWorkState {
  tasks: Record<string, BrowserTaskRecord>
  actions: Record<string, BrowserTaskAction>
  /** Runs the assistant is executing now, from the agent store. */
  activeRunIds: string[]
}

export const useBrowserTaskWork = create<BrowserTaskWorkState>(() => ({ tasks: {}, actions: {}, activeRunIds: [] }))

export function browserTaskState(task: BrowserTaskRecord, activeRunIds: readonly string[]): BrowserTaskState {
  if (task.attention) return 'needs_user'
  if (task.heldTabIds.length > 0) return 'running'
  if (task.ownerRunId && activeRunIds.includes(task.ownerRunId)) return 'running'
  return 'done'
}

/** The task that needs the person on this page, if any: the page named by the attention, or any page of a task
 *  whose attention names no page (a rejected review). */
export function attentionTaskForTab(tasks: Record<string, BrowserTaskRecord>, tabId: string | null | undefined): BrowserTaskRecord | null {
  if (!tabId) return null
  const all = Object.values(tasks).filter(task => task.attention)
  return all.find(task => task.attention!.tabId === tabId)
    ?? all.find(task => !task.attention!.tabId && task.tabIds.includes(tabId))
    ?? null
}

/** Tasks a run left something for the person in: a pending need or downloaded files. */
export function browserTasksForRun(tasks: Record<string, BrowserTaskRecord>, runId: string): BrowserTaskRecord[] {
  return Object.values(tasks)
    .filter(task => task.ownerRunId === runId && (task.attention || task.receipts.length > 0))
    .sort((a, b) => a.seenAt - b.seenAt)
}

export function taskIdForTab(tasks: Record<string, BrowserTaskRecord>, tabId: string | null | undefined): string | null {
  if (!tabId) return null
  return Object.values(tasks).find(task => task.tabIds.includes(tabId))?.browserTaskId
    ?? attentionTaskForTab(tasks, tabId)?.browserTaskId
    ?? null
}

/** 打开页面 from a task card: the browser shows the tab (BrowserMode listens and activates it like a sidebar click). */
export const BROWSER_TASK_SHOW_TAB_EVENT = 'ready:browser-task-show-tab'
export function showBrowserTaskTab(tabId: string): void {
  requestWorkbenchModeOpen('browser')
  window.dispatchEvent(new CustomEvent(BROWSER_TASK_SHOW_TAB_EVENT, { detail: { tabId } }))
}

/** The first line of a request, short enough for a sidebar heading. */
export function shortTaskTitle(text: string, max = 24): string {
  const line = text.split('\n').map(part => part.replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const HELP_MESSAGE_PREFIX = 'browser-help:'

/** What the person asked a run to do: the user message before the run's reply, skipping the help inputs, which
 *  only point back at the original request. */
export function requestTextForRun(messages: readonly AgentMessage[], runId: string): string | null {
  const replyIndex = messages.findIndex(message => message.type === 'agent' && message.meta?.runId === runId)
  if (replyIndex < 0) return null
  for (let index = replyIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== 'user') continue
    if (message.id.startsWith(HELP_MESSAGE_PREFIX)) continue
    const text = message.content.trim()
    if (text) return text
  }
  return null
}

// ---- reading from Main ----

type BrowserApi = Window['electronAPI']['browser']
type TabInfo = Awaited<ReturnType<BrowserApi['getTabs']>>[number]
type ClaimInfo = NonNullable<Awaited<ReturnType<BrowserApi['getAgentSupervisionState']>>['claims']>[number]

type RereadTarget = { all: boolean; ids: Set<string> }
let draining: Promise<void> | null = null
let queued: RereadTarget | null = null
/** The conversation Main named for a task in its push: the need is read against it, even for a task on no tab. */
const pushedScopes = new Map<string, string>()

function mergeTargets(left: RereadTarget, right: RereadTarget): RereadTarget {
  if (left.all || right.all) return { all: true, ids: new Set() }
  return { all: false, ids: new Set([...left.ids, ...right.ids]) }
}

/**
 * Re-read what Main knows about the assistant's browser tasks. Without ids every known task is re-read (and new ones
 * are discovered); with ids only those tasks' needs and files are re-read. Calls made while a read is running fold
 * into one follow-up read.
 */
export function requestBrowserTaskReread(_reason: BrowserTaskRereadReason, ids?: readonly string[]): Promise<void> {
  const target: RereadTarget = ids ? { all: false, ids: new Set(ids) } : { all: true, ids: new Set() }
  queued = queued ? mergeTargets(queued, target) : target
  if (!draining) {
    draining = (async () => {
      try {
        while (queued) {
          const next = queued
          queued = null
          await rereadOnce(next)
        }
      } finally {
        draining = null
      }
    })()
  }
  return draining
}

/** Test support: forget every task and pending read. */
export function resetBrowserTaskWorkForTest(): void {
  queued = null
  draining = null
  pushedScopes.clear()
  useBrowserTaskWork.setState({ tasks: {}, actions: {}, activeRunIds: [] }, false)
}

function activeRunOf(): { scopeId: string; runId: string } | null {
  const state = useAgent.getState()
  const scopeId = state.currentScopeId
  const run = scopeId ? state.scopeRunStates?.[scopeId] : null
  return scopeId && run?.requestId && isForegroundBusyScopeRunState(run) ? { scopeId, runId: run.requestId } : null
}

function allLoadedMessages(): AgentMessage[][] {
  const state = useAgent.getState()
  const lists = Object.values(state.sessions || {}).map(slice => (slice?.messages || []) as AgentMessage[])
  return [state.messages || [], ...lists]
}

function titleFromAgentStore(task: BrowserTaskRecord): string | null {
  if (task.ownerRunId) {
    for (const messages of allLoadedMessages()) {
      const text = requestTextForRun(messages, task.ownerRunId)
      if (text) return shortTaskTitle(text)
    }
  }
  return null
}

async function titleFromProjection(parentTaskId: string): Promise<{ title: string | null; scopeId: string | null }> {
  try {
    const result = await window.electronAPI.agent.getTaskProjection(parentTaskId)
    if (!result?.success || !result.data) return { title: null, scopeId: null }
    const request = result.data.requestAnchor?.canonicalMessageSnapshot?.content
    const scopeTitle = useAgent.getState().scopes.find(scope => scope.id === result.data!.scopeId)?.title
    const text = (typeof request === 'string' && request.trim()) || scopeTitle || ''
    return { title: text ? shortTaskTitle(text) : null, scopeId: result.data.scopeId || null }
  } catch (error) {
    console.warn('[browser-task-work] task title unavailable:', error instanceof Error ? error.message : String(error))
    return { title: null, scopeId: null }
  }
}

async function rereadOnce(target: RereadTarget): Promise<void> {
  const api = typeof window === 'undefined' ? null : window.electronAPI
  const browser = api?.browser
  if (!browser?.getTabs) return
  let tabs: TabInfo[]
  try {
    tabs = await browser.getTabs()
  } catch (error) {
    console.warn('[browser-task-work] tabs unavailable:', error instanceof Error ? error.message : String(error))
    return
  }
  let claims: ClaimInfo[] = []
  try {
    claims = (await browser.getAgentSupervisionState?.())?.claims ?? []
  } catch {
    // silent-catch: without the lease snapshot the tasks keep their last known running state; the next read retries.
  }

  const previous = useBrowserTaskWork.getState().tasks
  const now = Date.now()
  const activeRun = activeRunOf()
  const next: Record<string, BrowserTaskRecord> = {}
  const touch = (browserTaskId: string): BrowserTaskRecord => {
    const existing = next[browserTaskId]
    if (existing) return existing
    const prior = previous[browserTaskId]
    const fresh: BrowserTaskRecord = prior
      ? { ...prior, tabIds: [], heldTabIds: [] }
      : {
        browserTaskId, seenAt: now, parentTaskId: null, title: null, tabIds: [], heldTabIds: [], attention: null, receipts: [],
        // A task first seen while the open conversation's run is acting belongs to that run until Main says otherwise.
        ownerRunId: activeRun?.runId ?? null, scopeId: activeRun?.scopeId ?? null,
      }
    next[browserTaskId] = fresh
    return fresh
  }
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (tab.browserTaskId) touch(tab.browserTaskId).tabIds.push(tab.id)
  }
  for (const claim of claims) {
    if (!claim.browserTaskId) continue
    const task = touch(claim.browserTaskId)
    task.parentTaskId = claim.parentTaskId || task.parentTaskId
    task.ownerRunId = claim.ownerRunId || task.ownerRunId
    if (claim.state === 'held' && !task.heldTabIds.includes(claim.tabId)) task.heldTabIds.push(claim.tabId)
  }
  // Tasks no longer on any tab or claim keep what they still show (a need, downloaded files) until re-read below.
  for (const [id, prior] of Object.entries(previous)) {
    if (!next[id] && (prior.attention || prior.receipts.length > 0)) next[id] = { ...prior, tabIds: [], heldTabIds: [] }
  }
  for (const [id, scopeId] of pushedScopes) touch(id).scopeId = scopeId

  const currentScopeId = useAgent.getState().currentScopeId
  const toRead = Object.keys(next).filter(id => target.all || target.ids.has(id) || !previous[id])
  await Promise.all(toRead.map(async id => {
    const task = next[id]
    const scopeId = task.scopeId ?? currentScopeId
    if (scopeId && api?.agent?.getBrowserTaskAttention) {
      try {
        const attention = await api.agent.getBrowserTaskAttention({ scopeId, browserTaskId: id })
        task.attention = attention ?? null
        if (attention) {
          task.scopeId = scopeId
          task.parentTaskId = attention.parentTaskId
          task.ownerRunId = attention.ownerRunId
        }
      } catch (error) {
        console.warn('[browser-task-work] attention unavailable:', error instanceof Error ? error.message : String(error))
      }
    }
    if (browser.getTaskDownloadReceipts) {
      try {
        const result = await browser.getTaskDownloadReceipts({ browserTaskId: id })
        if (result?.success) {
          task.receipts = result.downloadReceipts
          if (result.downloadReceipts[0]) task.ownerRunId = result.downloadReceipts[0].ownerRunId
        }
      } catch (error) {
        console.warn('[browser-task-work] download receipts unavailable:', error instanceof Error ? error.message : String(error))
      }
    }
  }))

  for (const [id, task] of Object.entries(next)) {
    const keep = task.tabIds.length > 0 || task.heldTabIds.length > 0 || task.attention || task.receipts.length > 0
    if (!keep) { delete next[id]; pushedScopes.delete(id); continue }
    if (!task.title) task.title = titleFromAgentStore(task)
  }
  const untitled = Object.values(next).filter(task => !task.title && task.parentTaskId)
  await Promise.all(untitled.map(async task => {
    const found = await titleFromProjection(task.parentTaskId!)
    if (found.title) task.title = found.title
    if (!task.scopeId && found.scopeId) task.scopeId = found.scopeId
  }))

  useBrowserTaskWork.setState(state => {
    // A help input whose need is gone is done; a refusal stays until the need changes.
    const actions = Object.fromEntries(Object.entries(state.actions).filter(([id, action]) => {
      const attention = next[id]?.attention
      if (action.phase === 'sending') return true
      return Boolean(attention && attention.id === action.attentionId)
    }))
    return { tasks: next, actions }
  })
}

export function setBrowserTaskAction(browserTaskId: string, action: BrowserTaskAction | null): void {
  useBrowserTaskWork.setState(state => {
    const actions = { ...state.actions }
    if (action) actions[browserTaskId] = action
    else delete actions[browserTaskId]
    return { actions }
  })
}

// ---- triggers ----

function heldTaskIds(claims: readonly ClaimInfo[] | undefined): Set<string> {
  return new Set((claims ?? []).filter(claim => claim.state === 'held' && claim.browserTaskId).map(claim => claim.browserTaskId))
}

function busyRunIds(): string[] {
  const state = useAgent.getState()
  const ids = new Set<string>()
  const collect = (runs: Record<string, ScopeRunState> | undefined) => {
    for (const run of Object.values(runs || {})) if (run?.requestId && isForegroundBusyScopeRunState(run)) ids.add(run.requestId)
  }
  collect(state.scopeRunStates)
  for (const slice of Object.values(state.sessions || {})) collect(slice?.scopeRunStates)
  return [...ids].sort()
}

/** Installs every re-read trigger; returns the cleanup. The workbench installs it once. */
export function installBrowserTaskRereadTriggers(): () => void {
  const host = typeof window === 'undefined' ? null : window
  const browser = host?.electronAPI?.browser
  if (!host || !browser) return () => {}
  const cleanups: Array<() => void> = []
  let tabsTimer: number | undefined
  const tabsChanged = () => {
    host.clearTimeout(tabsTimer)
    tabsTimer = host.setTimeout(() => { void requestBrowserTaskReread('tabs') }, 150)
  }
  cleanups.push(() => host.clearTimeout(tabsTimer))

  void requestBrowserTaskReread('mount')
  const offOpened = browser.onTabOpened?.(tabsChanged)
  if (offOpened) cleanups.push(offOpened)
  const offUpdate = browser.onTabUpdate?.(event => { if ((event as { type?: string })?.type === 'closed') tabsChanged() })
  if (offUpdate) cleanups.push(offUpdate)

  // A task that starts holding a page is new or running again; one that stops holding has had its run closed out.
  let held = new Set<string>()
  const offLease = browser.onLeaseChanged?.(snapshot => {
    if (!snapshot?.claims) return
    const now = heldTaskIds(snapshot.claims)
    const changed = [...now].filter(id => !held.has(id)).concat([...held].filter(id => !now.has(id)))
    held = now
    if (changed.length > 0) void requestBrowserTaskReread('claims')
  })
  if (offLease) cleanups.push(offLease)
  // Main's push: a need was recorded (login, captcha, takeover, a rejected review) or answered.
  const offAttention = host.electronAPI.agent?.onBrowserTaskAttentionChanged?.(({ scopeId, browserTaskId }) => {
    pushedScopes.set(browserTaskId, scopeId)
    void requestBrowserTaskReread('attention', [browserTaskId])
  })
  if (offAttention) cleanups.push(offAttention)

  // The assistant's runs: a finished run may have left a need or files behind.
  let runs = busyRunIds()
  useBrowserTaskWork.setState({ activeRunIds: runs })
  cleanups.push(useAgent.subscribe(() => {
    const current = busyRunIds()
    if (current.join('\n') === runs.join('\n')) return
    const ended = runs.filter(id => !current.includes(id))
    runs = current
    useBrowserTaskWork.setState({ activeRunIds: current })
    if (ended.length > 0) void requestBrowserTaskReread('run-ended')
  }))

  return () => { for (const cleanup of cleanups.splice(0)) cleanup() }
}

/** The workbench's one installation of the re-read triggers. */
export function useBrowserTaskWorkSync(): void {
  useEffect(() => installBrowserTaskRereadTriggers(), [])
}
