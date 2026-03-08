export class BrowserAppShortcutBridgeService {
  private readonly sendToRenderer: (channel: string, data: unknown) => void

  constructor(deps: {
    sendToRenderer: (channel: string, data: unknown) => void
  }) {
    this.sendToRenderer = deps.sendToRenderer
  }

  isAppShortcutInput(input: Electron.Input): boolean {
    if (input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false
    const key = String(input.key || '')
    const meta = Boolean(input.meta) || Boolean(input.control)
    if (!meta && !input.shift) {
      if (key === 'Home') return true
      if (/^F[1-6]$/.test(key)) return true
    }
    if (meta && !input.shift) {
      if (/^[1-6]$/.test(key)) return true
      if (key === 'b' || key === 'B' || key === ',' || key === '\\') return true
    }
    return false
  }

  dispatchAppShortcut(input: Electron.Input): void {
    this.sendToRenderer('app:shortcut', {
      key: String(input.key || ''),
      metaKey: Boolean(input.meta),
      ctrlKey: Boolean(input.control),
      shiftKey: Boolean(input.shift),
      altKey: Boolean(input.alt),
    })
  }

  bind(webContents: Electron.WebContents): void {
    webContents.on('before-input-event', (event, input) => {
      if (!this.isAppShortcutInput(input)) return
      event.preventDefault()
      this.dispatchAppShortcut(input)
    })
  }
}
