import { useState, useCallback } from 'react'
import type { ModalMode } from './Modal'

interface ModalState {
  open: boolean
  mode: ModalMode
  title?: string
  message: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: (value?: string) => void
  onCancel?: () => void
}

const initialState: ModalState = {
  open: false,
  mode: 'alert',
  message: '',
}

/**
 * useModal — hook for imperatively showing alert/confirm/prompt modals.
 *
 * Usage:
 *   const { modalProps, showAlert, showConfirm, showPrompt } = useModal()
 *   // Spread modalProps onto <Modal {...modalProps} />
 *   // Then call showAlert/showConfirm/showPrompt as needed
 */
export function useModal() {
  const [state, setState] = useState<ModalState>(initialState)

  const close = useCallback(() => {
    setState(initialState)
  }, [])

  /** Show an alert dialog (single OK button). Returns a promise that resolves when dismissed. */
  const showAlert = useCallback((message: string, title?: string): Promise<void> => {
    return new Promise((resolve) => {
      setState({
        open: true,
        mode: 'alert',
        title,
        message,
        onConfirm: () => {
          close()
          resolve()
        },
        onCancel: () => {
          close()
          resolve()
        },
      })
    })
  }, [close])

  /** Show a confirm dialog (OK/Cancel). Returns a promise that resolves to true (OK) or false (Cancel). */
  const showConfirm = useCallback((message: string, title?: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        open: true,
        mode: 'confirm',
        title,
        message,
        onConfirm: () => {
          close()
          resolve(true)
        },
        onCancel: () => {
          close()
          resolve(false)
        },
      })
    })
  }, [close])

  /** Show a prompt dialog (input + OK/Cancel). Returns the entered string or null if cancelled. */
  const showPrompt = useCallback((
    message: string,
    defaultValue?: string,
    title?: string,
  ): Promise<string | null> => {
    return new Promise((resolve) => {
      setState({
        open: true,
        mode: 'prompt',
        title,
        message,
        defaultValue: defaultValue || '',
        onConfirm: (value?: string) => {
          close()
          resolve(value ?? '')
        },
        onCancel: () => {
          close()
          resolve(null)
        },
      })
    })
  }, [close])

  return {
    /** Spread these onto <Modal {...modalProps} /> */
    modalProps: state,
    showAlert,
    showConfirm,
    showPrompt,
  }
}
