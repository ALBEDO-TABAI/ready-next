import type { ReactNode } from 'react'
import { Button } from '../Button'
import { openFloat } from './float-store'

// Dialog (W1 §5): a modal float centred near the top third. Esc and a click on the dimmed page
// close it; the first action marked autoFocus takes focus, otherwise the dialog itself does.
export interface DialogAction {
  label: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  autoFocus?: boolean
  onClick?: () => void | Promise<void>
}

export interface DialogSpec {
  title: string
  body?: ReactNode
  actions: DialogAction[]
  onClose?: () => void
}

export function openDialog(spec: DialogSpec): string {
  return openFloat({
    anchor: { left: 0, top: 0, right: 0, bottom: 0 },
    placement: 'center',
    modal: true,
    role: 'dialog',
    label: spec.title,
    className: 'rn-dialog',
    onClose: spec.onClose,
    render: close => (
      <>
        <h2 className="rn-dialog__title">{spec.title}</h2>
        {spec.body && <div className="rn-dialog__body">{spec.body}</div>}
        <div className="rn-dialog__actions">
          {spec.actions.map(action => (
            <Button
              key={action.label}
              variant={action.variant ?? 'secondary'}
              data-autofocus={action.autoFocus || undefined}
              onClick={async () => { await action.onClick?.(); close() }}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </>
    ),
  })
}

/** Resolves true when the confirming action is chosen, false on cancel, Esc or a click outside. */
export function confirmDialog(options: { title: string; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    let decided = false
    openDialog({
      title: options.title,
      body: options.body,
      onClose: () => { if (!decided) resolve(false) },
      actions: [
        { label: options.cancelLabel ?? '取消', variant: 'ghost', onClick: () => { decided = true; resolve(false) } },
        { label: options.confirmLabel ?? '确定', variant: options.danger ? 'danger' : 'primary', autoFocus: true, onClick: () => { decided = true; resolve(true) } },
      ],
    })
  })
}
