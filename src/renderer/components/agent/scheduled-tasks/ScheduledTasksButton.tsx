import { Clock3 } from 'lucide-react'

export interface ScheduledTasksButtonProps {
  active?: boolean
  enabledCount?: number
  attentionCount?: number
  onClick: () => void
}

export function ScheduledTasksButton({
  active = false,
  enabledCount = 0,
  attentionCount = 0,
  onClick,
}: ScheduledTasksButtonProps) {
  const badgeKind = attentionCount > 0 ? 'attention' : enabledCount > 0 ? 'enabled' : null
  const stateLabel = attentionCount > 0
    ? `，${attentionCount} 项需要处理`
    : enabledCount > 0
      ? `，${enabledCount} 项已启用`
      : ''

  return (
    <button
      type="button"
      className="scheduled-tasks-trigger"
      aria-label={`定时任务${stateLabel}`}
      aria-haspopup="dialog"
      aria-expanded={active}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      title="定时任务"
    >
      <Clock3 aria-hidden="true" size={15} strokeWidth={2} />
      {badgeKind && (
        <span
          className={`scheduled-tasks-trigger__badge is-${badgeKind}`}
          aria-hidden="true"
        />
      )}
    </button>
  )
}
