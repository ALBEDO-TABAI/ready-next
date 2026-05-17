import { useEffect, useRef, useState, useCallback } from 'react'

export type ModalMode = 'alert' | 'confirm' | 'prompt'

export interface ModalProps {
  /** Whether the modal is visible */
  open: boolean
  /** Modal mode: alert (OK), confirm (OK/Cancel), prompt (input + OK/Cancel) */
  mode: ModalMode
  /** Dialog title */
  title?: string
  /** Dialog message / description */
  message: string
  /** Default value for prompt mode */
  defaultValue?: string
  /** Placeholder text for prompt input */
  placeholder?: string
  /** Label for the confirm/OK button */
  confirmLabel?: string
  /** Label for the cancel button */
  cancelLabel?: string
  /** Render the confirm button in danger (red) style — for destructive actions */
  danger?: boolean
  /** Called when the user confirms. For prompt mode, receives the input value. */
  onConfirm?: (value?: string) => void
  /** Called when the user cancels or closes the modal */
  onCancel?: () => void
}

/**
 * Modal — a reusable dialog component that replaces native alert/confirm/prompt.
 *
 * Uses existing CSS variables for theming (light/dark mode compatible).
 * Supports three modes:
 *   - alert: single OK button
 *   - confirm: OK + Cancel buttons
 *   - prompt: text input + OK + Cancel buttons
 *
 * Features:
 *   - Backdrop overlay with click-to-close (confirm/prompt only on Cancel)
 *   - Close on Escape key
 *   - Focus trap within the dialog
 *   - Smooth open/close animations
 *   - Full ARIA dialog attributes
 */
export default function Modal({
  open,
  mode,
  title,
  message,
  defaultValue = '',
  placeholder,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ModalProps) {
  const [inputValue, setInputValue] = useState(defaultValue)
  const [isClosing, setIsClosing] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  // Reset input value when modal opens with a new defaultValue
  useEffect(() => {
    if (open) {
      setInputValue(defaultValue)
      setIsClosing(false)
    }
  }, [open, defaultValue])

  // Focus management: focus input (prompt) or confirm button (alert/confirm) on open
  useEffect(() => {
    if (open && !isClosing) {
      requestAnimationFrame(() => {
        if (mode === 'prompt' && inputRef.current) {
          inputRef.current.focus()
          inputRef.current.select()
        } else if (confirmBtnRef.current) {
          confirmBtnRef.current.focus()
        }
      })
    }
  }, [open, mode, isClosing])

  // Close with animation
  const animateClose = useCallback((callback?: () => void) => {
    setIsClosing(true)
    setTimeout(() => {
      callback?.()
    }, 150) // match animation duration
  }, [])

  const handleConfirm = useCallback(() => {
    animateClose(() => {
      onConfirm?.(mode === 'prompt' ? inputValue : undefined)
    })
  }, [animateClose, onConfirm, mode, inputValue])

  const handleCancel = useCallback(() => {
    animateClose(() => {
      onCancel?.()
    })
  }, [animateClose, onCancel])

  // Keyboard: Escape to close, Enter to confirm
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (mode === 'alert') {
          handleConfirm()
        } else {
          handleCancel()
        }
      } else if (e.key === 'Enter' && mode !== 'prompt') {
        e.preventDefault()
        handleConfirm()
      } else if (e.key === 'Enter' && mode === 'prompt') {
        e.preventDefault()
        handleConfirm()
      }
      // Focus trap: keep focus within the dialog
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, input, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, mode, handleConfirm, handleCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{
        background: 'var(--overlay-bg)',
        animation: isClosing
          ? 'modalFadeOut var(--duration-fast) ease-in forwards'
          : 'modalFadeIn var(--duration-normal) ease-out',
      }}
      onClick={(e) => {
        // Click on backdrop
        if (e.target === e.currentTarget) {
          if (mode === 'alert') {
            handleConfirm()
          } else {
            handleCancel()
          }
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
      aria-describedby="modal-message"
    >
      <div
        ref={dialogRef}
        style={{
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
          width: 380,
          maxWidth: 'calc(100vw - 32px)',
          padding: '24px',
          animation: isClosing
            ? 'modalSlideOut var(--duration-fast) ease-in forwards'
            : 'modalSlideIn var(--duration-normal) ease-out',
        }}
      >
        {/* Title */}
        {title && (
          <h2
            id="modal-title"
            style={{
              fontSize: 'var(--text-lg)',
              fontWeight: 600,
              color: 'var(--text-title)',
              margin: '0 0 8px',
              lineHeight: 1.4,
            }}
          >
            {title}
          </h2>
        )}

        {/* Message */}
        <p
          id="modal-message"
          style={{
            fontSize: 'var(--text-base)',
            color: 'var(--text-secondary)',
            margin: '0 0 20px',
            lineHeight: 1.6,
          }}
        >
          {message}
        </p>

        {/* Prompt input */}
        {mode === 'prompt' && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={placeholder}
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: 'var(--text-base)',
              color: 'var(--text-body)',
              background: 'var(--bg-editor)',
              border: '1px solid var(--border-input)',
              borderRadius: 'var(--radius-md)',
              outline: 'none',
              marginBottom: 20,
              transition: `border-color var(--duration-fast)`,
              boxSizing: 'border-box',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-blue)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-input)'
            }}
          />
        )}

        {/* Buttons */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          {/* Cancel button (confirm and prompt modes) */}
          {mode !== 'alert' && (
            <button
              onClick={handleCancel}
              style={{
                padding: '6px 16px',
                fontSize: 'var(--text-base)',
                fontWeight: 500,
                color: 'var(--text-muted)',
                background: 'transparent',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                transition: `all var(--duration-fast)`,
                lineHeight: 1.5,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {cancelLabel}
            </button>
          )}

          {/* Confirm / OK button */}
          <button
            ref={confirmBtnRef}
            onClick={handleConfirm}
            style={{
              padding: '6px 16px',
              fontSize: 'var(--text-base)',
              fontWeight: 500,
              color: '#FFFFFF',
              background: danger ? 'var(--color-red)' : 'var(--color-blue)',
              border: '1px solid transparent',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              transition: `all var(--duration-fast)`,
              lineHeight: 1.5,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.filter = 'brightness(1.1)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = 'none'
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>

      {/* Inline keyframe styles for the modal animations */}
      <style>{`
        @keyframes modalFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalFadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }
        @keyframes modalSlideIn {
          from { opacity: 0; transform: scale(0.95) translateY(-8px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes modalSlideOut {
          from { opacity: 1; transform: scale(1) translateY(0); }
          to { opacity: 0; transform: scale(0.95) translateY(-8px); }
        }
      `}</style>
    </div>
  )
}
