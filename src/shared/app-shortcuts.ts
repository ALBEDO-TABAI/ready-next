export type ReadyAppShortcutAction =
  | 'capture-window'
  | 'open-ready'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'save-document'
  | 'close-document'
  | 'new-document'
  | 'toggle-theme'
  | 'switch-browser'
  | 'switch-document'
  | 'switch-rss'
  | 'switch-calendar'

export interface ReadyShortcutInput {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

export interface ReadyShortcutGuideItem {
  id: string
  label: string
  description?: string
  value: string
}

export const READY_SHORTCUT_GUIDE: ReadyShortcutGuideItem[] = [
  {
    id: 'captureWindow',
    label: '截取 Ready 窗口',
    description: '精准截取当前窗口并保存到桌面，保留透明圆角',
    value: '⌘ / Ctrl + ⇧ + S',
  },
  { id: 'openReady', label: '打开 Ready 主页', value: 'Home' },
  { id: 'switchMode', label: '切换工作模式', description: '浏览器 / 文档 / RSS / 日历', value: 'F1–F4 或 ⌘ / Ctrl + 1–4' },
  { id: 'openSettings', label: '打开设置', value: '⌘ / Ctrl + ,' },
  { id: 'toggleSidebar', label: '切换文件侧栏', description: '单按 · 仅在工作台且没有输入时生效', value: '⌘ / Ctrl + B 或 ·' },
  { id: 'toggleChat', label: '切换聊天面板', description: '仅在工作台且没有输入时生效', value: 'Tab' },
  { id: 'cycleSidePanel', label: '轮换左侧面板', value: 'Ctrl + Tab' },
  { id: 'newDocument', label: '新建文档', value: '⌘ / Ctrl + T' },
  { id: 'saveDocument', label: '保存当前文档', value: '⌘ / Ctrl + S' },
  { id: 'closeDocument', label: '关闭当前文档', value: '⌘ / Ctrl + W' },
  { id: 'toggleTheme', label: '切换深浅主题', value: '⌘ / Ctrl + \\' },
  { id: 'sendMessage', label: '发送消息', value: 'Enter' },
  { id: 'insertLineBreak', label: '消息内换行', value: '⇧ + Enter' },
]

export function resolveReadyAppShortcut(input: ReadyShortcutInput): ReadyAppShortcutAction | null {
  const key = String(input.key || '')
  const normalizedKey = key.toLowerCase()
  const commandOrControl = Boolean(input.metaKey) || Boolean(input.ctrlKey)
  const shift = Boolean(input.shiftKey)
  const alt = Boolean(input.altKey)

  if (commandOrControl && shift && !alt && normalizedKey === 's') return 'capture-window'
  if (alt) return null

  if (!commandOrControl && !shift) {
    if (key === 'Home') return 'open-ready'
    const functionModeMap: Record<string, ReadyAppShortcutAction> = {
      F1: 'switch-browser',
      F2: 'switch-document',
      F3: 'switch-rss',
      F4: 'switch-calendar',
    }
    return functionModeMap[key] ?? null
  }

  if (!commandOrControl || shift) return null

  const commandMap: Record<string, ReadyAppShortcutAction> = {
    ',': 'open-settings',
    b: 'toggle-sidebar',
    s: 'save-document',
    w: 'close-document',
    t: 'new-document',
    '\\': 'toggle-theme',
    '1': 'switch-browser',
    '2': 'switch-document',
    '3': 'switch-rss',
    '4': 'switch-calendar',
  }
  return commandMap[normalizedKey] ?? null
}
