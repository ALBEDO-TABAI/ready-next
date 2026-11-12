import { useCallback, useEffect, useMemo, useRef } from 'react'
import { showToast } from '../../components/ui'
import type { BrowserTaskTabGroup } from '../../components/browser/BrowserTaskTabGroups'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import {
  BROWSER_TASK_SHOW_TAB_EVENT,
  attentionTaskForTab,
  browserTaskState,
  requestBrowserTaskReread,
  taskIdForTab,
  useBrowserTaskWork,
  type BrowserTaskRecord,
} from './browser-task-work'

const UNNAMED_TASK = '助手的任务'

/** The sidebar groups: each task with tabs, in the order the tasks appeared, its tabs in Main's order. */
export function buildBrowserTaskTabGroups(
  tasks: Record<string, BrowserTaskRecord>,
  tabs: readonly BrowserTab[],
  activeRunIds: readonly string[],
): BrowserTaskTabGroup[] {
  const byId = new Map(tabs.map(tab => [tab.id, tab]))
  return Object.values(tasks)
    .sort((a, b) => a.seenAt - b.seenAt)
    .map(task => ({
      browserTaskId: task.browserTaskId,
      title: task.title || UNNAMED_TASK,
      state: browserTaskState(task, activeRunIds),
      attentionTabId: task.attention?.tabId ?? null,
      tabs: task.tabIds.map(id => byId.get(id)).filter((tab): tab is BrowserTab => Boolean(tab)),
    }))
    .filter(group => group.tabs.length > 0)
}

/**
 * The browser mode's share of the assistant's tasks: the sidebar groups, 全部关闭, a re-read when a task's tab becomes
 * the visible page, and 打开页面 from a task card (activated like a sidebar click).
 */
export function useBrowserTaskShell({ tabs, visibleTabIds, activateTab }: {
  tabs: readonly BrowserTab[]
  visibleTabIds: ReadonlyArray<string | null | undefined>
  activateTab: (tabId: string) => void
}) {
  const tasks = useBrowserTaskWork(state => state.tasks)
  const activeRunIds = useBrowserTaskWork(state => state.activeRunIds)
  const taskGroups = useMemo(() => buildBrowserTaskTabGroups(tasks, tabs, activeRunIds), [activeRunIds, tabs, tasks])

  const visibleKey = visibleTabIds.filter(Boolean).join('\n')
  // A visible page with a band says what it needs itself; the lock pill would only repeat it (and cover the button).
  const bandShown = visibleTabIds.some(tabId => Boolean(attentionTaskForTab(tasks, tabId)))
  useEffect(() => {
    if (!visibleKey) return
    const current = useBrowserTaskWork.getState().tasks
    const ids = visibleKey.split('\n').map(tabId => taskIdForTab(current, tabId)).filter((id): id is string => Boolean(id))
    if (ids.length > 0) void requestBrowserTaskReread('tab-visible', ids)
  }, [visibleKey])

  const activate = useRef(activateTab)
  activate.current = activateTab
  useEffect(() => {
    const onShow = (event: Event) => {
      const tabId = (event as CustomEvent<{ tabId?: string }>).detail?.tabId
      if (tabId) activate.current(tabId)
    }
    window.addEventListener(BROWSER_TASK_SHOW_TAB_EVENT, onShow)
    return () => window.removeEventListener(BROWSER_TASK_SHOW_TAB_EVENT, onShow)
  }, [])

  const closeTaskTabs = useCallback(async (browserTaskId: string) => {
    try {
      const result = await window.electronAPI.browser.closeTaskTabs({ browserTaskId })
      if (!result?.success) showToast(`没能关闭这些标签：${result?.error || '未知原因'}`, { tone: 'bad' })
    } catch (error) {
      /* silent-catch: the failure is shown to the person as a toast; the tabs are re-read either way. */
      showToast(`没能关闭这些标签：${error instanceof Error ? error.message : String(error)}`, { tone: 'bad' })
    } finally {
      void requestBrowserTaskReread('tabs')
    }
  }, [])

  return { taskGroups, closeTaskTabs, bandShown }
}
