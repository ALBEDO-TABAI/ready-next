import { useEffect, useMemo } from 'react'
import { Button, RefCapsule } from '../../../ui'
import {
  browserTasksForRun,
  requestBrowserTaskReread,
  showBrowserTaskTab,
  useBrowserTaskWork,
  type BrowserTaskAction,
  type BrowserTaskRecord,
} from '../../../../modules/browser/browser-task-work'
import {
  BROWSER_TASK_NEED_COPY,
  browserTaskButtonBusy,
  browserTaskButtonLabel,
  fileNameOf,
  formatFileSize,
} from '../../../../modules/browser/browser-task-copy'
import { sendBrowserTaskHelp } from '../../../../modules/browser/browser-task-help'

const extensionOf = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toUpperCase() ?? null
const withoutExtension = (name: string) => name.replace(/\.[a-z0-9]{1,8}$/i, '') || name

/**
 * A browser task's card under the assistant's reply (W7 §4.7, §4.3): what it needs from the person with the one
 * button, and the files it downloaded as reference capsules (click opens, Space quick-looks) with their size.
 */
export function BrowserTaskCardView({ task, action, onContinue, onOpenPage }: {
  task: BrowserTaskRecord
  action?: BrowserTaskAction
  onContinue: () => void
  /** Shows the page the need is on; absent when the need names no page. */
  onOpenPage?: () => void
}) {
  const attention = task.attention
  const copy = attention ? BROWSER_TASK_NEED_COPY[attention.reason] : null
  const refusal = attention && action?.attentionId === attention.id && action.phase === 'refused' ? action.message || null : null
  if (!attention && task.receipts.length === 0) return null
  return (
    <div className="rn-task-card rn-ui" data-browser-task-card={task.browserTaskId}>
      {attention && copy && (
        <div className="rn-task-card__need" role="region" aria-label={copy.title} data-reason={attention.reason}>
          <div className="rn-task-card__head">
            <span className="rn-task-card__dot" aria-hidden="true" />
            <span className="rn-task-card__title">{copy.title}</span>
            <span className="rn-task-card__state">等你处理</span>
          </div>
          {refusal
            ? <p className="rn-task-card__refusal" role="alert">{refusal}</p>
            : <p className="rn-task-card__hint">{copy.hint}</p>}
          <div className="rn-task-card__actions">
            {onOpenPage && <Button variant="ghost" size="sm" onClick={onOpenPage}>打开页面</Button>}
            <Button variant="primary" size="sm" disabled={browserTaskButtonBusy(action, attention.id)} onClick={onContinue}>
              {browserTaskButtonLabel(attention.action.label, action, attention.id)}
            </Button>
          </div>
        </div>
      )}
      {task.receipts.length > 0 && (
        <div className="rn-task-card__files" role="group" aria-label="下载的文件">
          <span className="rn-task-card__files-label" aria-hidden="true">下载的文件</span>
          {task.receipts.map(receipt => {
            const name = fileNameOf(receipt.path)
            const extension = extensionOf(name)
            return (
              <span key={receipt.receiptId} className="rn-task-card__file" data-browser-download-receipt={receipt.receiptId}>
                <RefCapsule reference={receipt.readyRef} title={withoutExtension(name)} typeHint={name} />
                <span className="rn-task-card__size">{[extension, formatFileSize(receipt.size)].filter(Boolean).join(' · ')}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The cards of the browser tasks a run left something in; re-reads them when the reply mounts. */
export function BrowserTaskRunCards({ runId }: { runId: string }) {
  const tasks = useBrowserTaskWork(state => state.tasks)
  const actions = useBrowserTaskWork(state => state.actions)
  const forRun = useMemo(() => browserTasksForRun(tasks, runId), [runId, tasks])
  const ids = forRun.map(task => task.browserTaskId).join('\n')
  useEffect(() => {
    if (ids) void requestBrowserTaskReread('card', ids.split('\n'))
  }, [ids])
  if (forRun.length === 0) return null
  return (
    <div
      className="flex max-w-[90%] w-full flex-col"
      style={{ gap: 10, paddingRight: 18, boxSizing: 'border-box' }}
      data-browser-task-cards={runId}
    >
      {forRun.map(task => {
        const tabId = task.attention?.tabId
        return (
          <BrowserTaskCardView
            key={task.browserTaskId}
            task={task}
            action={actions[task.browserTaskId]}
            onContinue={() => { void sendBrowserTaskHelp(task.browserTaskId) }}
            onOpenPage={tabId ? () => showBrowserTaskTab(tabId) : undefined}
          />
        )
      })}
    </div>
  )
}
