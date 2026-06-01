import { BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron'
import type { NativeContextMenuItem, NativeContextMenuRequest, NativeContextMenuResponse } from '../../../shared/native-context-menu'

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
  }
}

function itemLabel(item: NativeContextMenuItem): string {
  if (!item.iconText) return item.label
  return `${item.iconText}  ${item.label}`
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
    return popupNativeContextMenu(window, request)
  })
}
