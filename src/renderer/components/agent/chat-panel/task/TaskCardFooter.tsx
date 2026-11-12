import { RunFeedbackStars } from './RunFeedbackStars'

export function TaskCardFooter({
  taskId,
  taskKindBadge,
  terminal,
  detached,
}: {
  taskId?: string | null
  taskKindBadge: string | null
  terminal: boolean
  detached: boolean
}) {
  if (!terminal && !taskKindBadge) return null

  return (
    <div className="ready-task-content-line flex items-end justify-between" style={{ gap: 10 }}>
      <div style={{ minWidth: 0 }}>
        {terminal && !detached && taskId ? <RunFeedbackStars taskId={taskId} /> : null}
      </div>
      {taskKindBadge ? (
        <span
          data-ready-task-kind-badge="true"
          style={{
            padding: '2px 7px',
            borderRadius: 999,
            border: '1px solid var(--rn-hair-2)',
            fontSize: 'var(--rn-fs-2xs)',
            lineHeight: 1.2,
            fontWeight: 500,
            letterSpacing: '0.08em',
            color: 'var(--rn-ink-3)',
            background: 'transparent',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {taskKindBadge}
        </span>
      ) : null}
    </div>
  )
}
