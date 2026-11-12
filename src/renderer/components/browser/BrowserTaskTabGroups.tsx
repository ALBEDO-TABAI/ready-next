import { Globe, Loader2, X } from 'lucide-react'
import { extractBrowserDomain } from '../../modules/browser/url-utils'
import { BROWSER_TASK_STATE_LABEL, type BrowserTaskState } from '../../modules/browser/browser-task-work'
import type { BrowserTab } from '../../stores/useBrowserTabs'

/** One task's tabs in the sidebar: its name, its state and its tabs in Main's order. */
export interface BrowserTaskTabGroup {
  browserTaskId: string
  title: string
  state: BrowserTaskState
  /** The tab the task is waiting on the person in, if any. */
  attentionTabId: string | null
  tabs: BrowserTab[]
}

function tabIcon(tab: BrowserTab) {
  if (tab.loading) return <Loader2 className="browser-tab-list__icon animate-spin" strokeWidth={2} aria-hidden="true" />
  if (tab.favicon) return <img className="browser-tab-list__icon browser-tab-list__favicon" src={tab.favicon} alt="" draggable={false} />
  return <Globe className="browser-tab-list__icon" strokeWidth={1.8} aria-hidden="true" />
}

/**
 * The assistant's work tabs as their own group in the browser sidebar (W7 §4.10): each task with its name and state
 * (运行中 / 等你处理 / 已完成). Clicking a tab brings it to the front; 全部关闭 closes the task's tabs through Main.
 */
export default function BrowserTaskTabGroups({ groups, activeTabId, splitTabId, onTabClick, onTabClose, onCloseAll }: {
  groups: BrowserTaskTabGroup[]
  activeTabId: string | null
  splitTabId: string | null
  onTabClick: (id: string, event: { shiftKey: boolean }) => void | Promise<void>
  onTabClose: (id: string) => void | Promise<void>
  onCloseAll: (browserTaskId: string) => void | Promise<void>
}) {
  if (groups.length === 0) return null
  return (
    <div className="browser-task-groups" role="group" aria-label="助手的标签" data-browser-task-groups="">
      <div className="browser-task-groups__label" aria-hidden="true">助手的标签</div>
      {groups.map(group => {
        const stateLabel = BROWSER_TASK_STATE_LABEL[group.state]
        return (
          <section
            key={group.browserTaskId}
            className="browser-task-group"
            data-browser-task-group={group.browserTaskId}
            data-state={group.state}
            aria-label={`${group.title}，${stateLabel}`}
          >
            <div className="browser-task-group__head">
              <span className="browser-task-group__name" title={group.title}>{group.title}</span>
              <span className="browser-task-group__state" data-state={group.state}>{stateLabel}</span>
              <button
                type="button"
                className="browser-task-group__close"
                title="关闭这个任务的全部标签"
                aria-label={`全部关闭：${group.title}`}
                onClick={() => void onCloseAll(group.browserTaskId)}
              >
                全部关闭
              </button>
            </div>
            <div role="list" aria-label={`${group.title}的标签`}>
              {group.tabs.map(tab => {
                const isSplit = tab.id === splitTabId && tab.id !== activeTabId
                const current = tab.id === activeTabId || isSplit
                const waiting = tab.id === group.attentionTabId
                const domain = tab.domain || extractBrowserDomain(tab.url || '')
                return (
                  <div
                    key={tab.id}
                    role="listitem"
                    className="browser-tab-list__row"
                    data-browser-task-tab={tab.id}
                    data-current={current || undefined}
                    title={tab.title || 'New Tab'}
                    onClick={event => void onTabClick(tab.id, { shiftKey: event.shiftKey })}
                    onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void onTabClose(tab.id) } }}
                  >
                    <span className="browser-tab-list__glyph">{tabIcon(tab)}</span>
                    <span className="browser-tab-list__text">
                      <span className="browser-tab-list__label">{tab.title || 'New Tab'}</span>
                      {waiting
                        ? <span className="browser-task-group__waiting">等你处理</span>
                        : domain && <span className="browser-tab-list__meta">{domain}</span>}
                    </span>
                    <button
                      type="button"
                      className="browser-tab-list__close"
                      title="关闭标签页"
                      aria-label={`关闭 ${tab.title || '标签页'}`}
                      onMouseDown={event => event.stopPropagation()}
                      onClick={event => { event.stopPropagation(); void onTabClose(tab.id) }}
                    >
                      <X strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
