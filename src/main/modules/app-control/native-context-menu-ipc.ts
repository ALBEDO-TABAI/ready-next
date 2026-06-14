import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron'
import type { NativeContextMenuItem, NativeContextMenuRequest, NativeContextMenuResponse } from '../../../shared/native-context-menu'

const FLOATING_MENU_ICONS: Record<NonNullable<NativeContextMenuItem['iconKey']>, string> = {
  user: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.2" r="2.15"/><path d="M4.15 12.75c.55-2.02 1.95-3.05 3.85-3.05s3.3 1.03 3.85 3.05" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg>',
  'theme-light': '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.55" fill="none" stroke="currentColor" stroke-width="1.45"/><path d="M8 3.45a4.55 4.55 0 0 1 0 9.1V3.45Z"/></svg>',
  'theme-dark': '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.95 10.78a5.2 5.2 0 0 1-6.73-6.73 5.42 5.42 0 1 0 6.73 6.73Z" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.02" fill="none" stroke="currentColor" stroke-width="1.35"/><path d="M8.62 2.75H7.38l-.33 1.1c-.3.08-.58.2-.84.35l-1.01-.54-.88.88.54 1.01c-.15.26-.27.54-.35.84l-1.1.33v1.24l1.1.33c.08.3.2.58.35.84l-.54 1.01.88.88 1.01-.54c.26.15.54.27.84.35l.33 1.1h1.24l.33-1.1c.3-.08.58-.2.84-.35l1.01.54.88-.88-.54-1.01c.15-.26.27-.54.35-.84l1.1-.33V6.72l-1.1-.33a4.2 4.2 0 0 0-.35-.84l.54-1.01-.88-.88-1.01.54a4.2 4.2 0 0 0-.84-.35l-.33-1.1Z" fill="none" stroke="currentColor" stroke-width="1.05" stroke-linejoin="round"/></svg>',
}

function normalizeItem(item: unknown): NativeContextMenuItem | null {
  if (!item || typeof item !== 'object') return null
  const source = item as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  const label = typeof source.label === 'string' ? source.label.trim() : ''
  const separator = source.separator === true
  if (!separator && (!id || !label)) return null
  return {
    id: separator ? id || 'separator' : id,
    label,
    separator,
    enabled: source.enabled === false ? false : true,
    checked: source.checked === true,
    iconText: typeof source.iconText === 'string' ? source.iconText.trim().slice(0, 4) : undefined,
    iconKey: typeof source.iconKey === 'string' && source.iconKey in FLOATING_MENU_ICONS
      ? source.iconKey as NativeContextMenuItem['iconKey']
      : undefined,
    accelerator: typeof source.accelerator === 'string' ? source.accelerator.trim() : undefined,
  }
}

function normalizeRequest(payload: unknown): NativeContextMenuRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const source = payload as Record<string, unknown>
  const x = Number(source.x)
  const y = Number(source.y)
  const rawItems = Array.isArray(source.items) ? source.items : []
  const items = rawItems.map(normalizeItem).filter((item): item is NativeContextMenuItem => Boolean(item))
  if (!Number.isFinite(x) || !Number.isFinite(y) || items.length === 0) return null
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    items,
    presentation: source.presentation === 'floating' ? 'floating' : 'native',
  }
}

function itemLabel(item: NativeContextMenuItem): string {
  if (!item.iconText || item.iconKey) return item.label
  return `${item.iconText}   ${item.label}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function floatingMenuHtml(menuId: string, items: NativeContextMenuItem[]): string {
  const rows = items
    .filter((item) => !item.separator)
    .map((item) => {
      const disabled = item.enabled === false
      const icon = item.iconKey ? FLOATING_MENU_ICONS[item.iconKey] : `<span>${escapeHtml(item.iconText || '')}</span>`
      return `
        <button class="menu-item" data-id="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''}>
          <span class="menu-icon">${icon}</span>
          <span class="menu-label">${escapeHtml(item.label)}</span>
        </button>`
    })
    .join('')
  const dataJson = JSON.stringify({ channel: `ui:floating-context-menu-select:${menuId}` }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
  }
  body {
    padding: 0;
    color: rgba(24, 24, 24, 0.94);
  }
  .menu {
    width: 96px;
    padding: 6px;
    border: 0.5px solid rgba(255, 255, 255, 0.76);
    border-radius: 12px;
    background: rgba(248, 248, 248, 0.78);
    box-shadow:
      0 18px 34px rgba(0, 0, 0, 0.16),
      0 4px 12px rgba(0, 0, 0, 0.08),
      inset 0 1px 0 rgba(255, 255, 255, 0.70);
    backdrop-filter: blur(22px) saturate(1.28);
    -webkit-backdrop-filter: blur(22px) saturate(1.28);
  }
  .menu-item {
    display: grid;
    grid-template-columns: 16px 1fr;
    align-items: center;
    width: 100%;
    height: 26px;
    padding: 0 8px;
    gap: 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    line-height: 26px;
    text-align: left;
  }
  .menu-item:disabled {
    opacity: 0.45;
  }
  .menu-item:not(:disabled):hover {
    background: rgba(0, 0, 0, 0.06);
  }
  .menu-icon {
    display: flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
    color: rgba(24, 24, 24, 0.92);
    font-size: 12px;
    line-height: 16px;
  }
  .menu-icon svg {
    width: 14px;
    height: 14px;
    display: block;
    fill: currentColor;
  }
  .menu-label {
    display: block;
    height: 26px;
    line-height: 26px;
    white-space: nowrap;
  }
</style>
</head>
<body>
  <div class="menu" role="menu">${rows}</div>
  <script>
    const data = ${dataJson};
    const { ipcRenderer } = require('electron');
    document.addEventListener('click', (event) => {
      const button = event.target.closest('.menu-item');
      if (!button || button.disabled) return;
      ipcRenderer.send(data.channel, button.dataset.id);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.close();
    });
  </script>
</body>
</html>`
}

function popupFloatingContextMenu(window: BrowserWindow, request: NativeContextMenuRequest): Promise<NativeContextMenuResponse> {
  return new Promise((resolve) => {
    const menuId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const width = 96
    const visibleItemCount = request.items.filter((item) => !item.separator).length
    const height = 12 + Math.max(1, visibleItemCount) * 26
    let settled = false
    const contentBounds = window.getContentBounds()
    const popup = new BrowserWindow({
      parent: window,
      modal: false,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      width,
      height,
      x: contentBounds.x + request.x,
      y: contentBounds.y + request.y,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
      },
    })
    const channel = `ui:floating-context-menu-select:${menuId}`
    const settle = (response: NativeContextMenuResponse) => {
      if (settled) return
      settled = true
      ipcMain.removeAllListeners(channel)
      if (!popup.isDestroyed()) popup.close()
      resolve(response)
    }
    ipcMain.once(channel, (_event, selectedId: unknown) => {
      settle({ success: true, selectedId: typeof selectedId === 'string' ? selectedId : undefined })
    })
    popup.on('blur', () => settle({ success: true, dismissed: true }))
    popup.on('closed', () => settle({ success: true, dismissed: true }))
    popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(floatingMenuHtml(menuId, request.items))}`)
      .then(() => {
        if (!settled) popup.show()
      })
      .catch((error: unknown) => settle({ success: false, error: error instanceof Error ? error.message : 'floating_menu_load_failed' }))
  })
}

function popupNativeContextMenu(window: BrowserWindow, request: NativeContextMenuRequest): Promise<NativeContextMenuResponse> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (response: NativeContextMenuResponse) => {
      if (settled) return
      settled = true
      resolve(response)
    }
    const template: MenuItemConstructorOptions[] = request.items.map((item) => {
      if (item.separator) return { type: 'separator' }
      return {
        type: item.checked ? 'checkbox' : 'normal',
        checked: item.checked ? true : undefined,
        label: itemLabel(item),
        enabled: item.enabled ?? true,
        accelerator: item.accelerator || undefined,
        click: () => settle({ success: true, selectedId: item.id }),
      }
    })
    const menu = Menu.buildFromTemplate(template)
    menu.popup({
      window,
      x: request.x,
      y: request.y,
      callback: () => settle({ success: true, dismissed: true }),
    })
  })
}

export function setupNativeContextMenuIPC(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('ui:showNativeContextMenu', async (_event, payload: unknown): Promise<NativeContextMenuResponse> => {
    const request = normalizeRequest(payload)
    if (!request) return { success: false, error: 'invalid_menu_request' }
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return { success: false, error: 'main_window_unavailable' }
    if (request.presentation === 'floating') return popupFloatingContextMenu(window, request)
    return popupNativeContextMenu(window, request)
  })
}
