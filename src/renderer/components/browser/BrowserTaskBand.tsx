import { Button } from '../ui'
import { BROWSER_TASK_NEED_COPY, browserTaskButtonBusy, browserTaskButtonLabel } from '../../modules/browser/browser-task-copy'
import { sendBrowserTaskHelp } from '../../modules/browser/browser-task-help'
import {
  attentionTaskForTab,
  useBrowserTaskWork,
  type BrowserTaskAction,
  type BrowserTaskRecord,
} from '../../modules/browser/browser-task-work'

/** The band for the page shown in a pane: present only while a task waits on the person in this tab. */
export function BrowserTaskBandForTab({ tabId }: { tabId: string | null | undefined }) {
  const tasks = useBrowserTaskWork(state => state.tasks)
  const actions = useBrowserTaskWork(state => state.actions)
  const task = attentionTaskForTab(tasks, tabId)
  if (!task) return null
  return (
    <BrowserTaskBand
      task={task}
      action={actions[task.browserTaskId]}
      onContinue={() => { void sendBrowserTaskHelp(task.browserTaskId) }}
    />
  )
}

/**
 * The band above a page whose task needs the person (W7 §4.7): what is needed and the one button. It sits outside the
 * page's bounds, so the native page moves down instead of being covered.
 */
export function BrowserTaskBand({ task, action, onContinue }: {
  task: BrowserTaskRecord
  action?: BrowserTaskAction
  onContinue: () => void
}) {
  const attention = task.attention
  if (!attention) return null
  const copy = BROWSER_TASK_NEED_COPY[attention.reason]
  const refusal = action?.attentionId === attention.id && action.phase === 'refused' ? action.message || null : null
  return (
    <div
      className="rn-task-band rn-ui"
      role="region"
      aria-label={copy.title}
      data-browser-task-band={task.browserTaskId}
      data-reason={attention.reason}
    >
      <span className="rn-task-band__dot" aria-hidden="true" />
      <div className="rn-task-band__text">
        <span className="rn-task-band__title">{copy.title}</span>
        {refusal
          ? <span className="rn-task-band__refusal" role="alert">{refusal}</span>
          : <span className="rn-task-band__hint">{copy.hint}</span>}
      </div>
      <Button variant="primary" size="sm" disabled={browserTaskButtonBusy(action, attention.id)} onClick={onContinue}>
        {browserTaskButtonLabel(attention.action.label, action, attention.id)}
      </Button>
    </div>
  )
}
