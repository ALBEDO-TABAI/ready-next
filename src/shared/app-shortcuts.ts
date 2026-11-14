export type ReadyAppShortcutAction =
  | 'browser-find'
  | 'browser-find-next'
  | 'browser-find-previous'
  | 'navigate-back'
  | 'navigate-forward'
  | 'capture-window'
  | 'open-ready'
  | 'open-settings'
  | 'open-search'
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

/** One catalog for app, native menu, OS-wide and module shortcuts. */
export interface AppShortcut {
  readonly id: string
  readonly keys: string
  readonly scope: 'global' | 'browser' | 'calendar' | 'document' | 'canvas' | 'skills' | 'assistant'
  readonly description: string
  readonly action?: ReadyAppShortcutAction
  /** Listed in 设置 › 快捷键 (the everyday keys, not the operating system's editing keys). */
  readonly guide?: true
}
export const APP_SHORTCUTS: readonly AppShortcut[] = [
  { id: 'browser-find', keys: 'CommandOrControl+F', scope: 'browser', description: '在网页中查找', action: 'browser-find', guide: true },
  { id: 'browser-find-next', keys: 'CommandOrControl+G', scope: 'browser', description: '查找下一项', action: 'browser-find-next', guide: true },
  { id: 'browser-find-previous', keys: 'CommandOrControl+Shift+G', scope: 'browser', description: '查找上一项', action: 'browser-find-previous', guide: true },
  { id: 'switch-browser', keys: 'CommandOrControl+1', scope: 'global', description: '切换到浏览器', action: 'switch-browser', guide: true },
  { id: 'switch-browser-function', keys: 'F1', scope: 'global', description: '切换到浏览器', action: 'switch-browser' },
  { id: 'switch-document', keys: 'CommandOrControl+2', scope: 'global', description: '切换到文档', action: 'switch-document', guide: true },
  { id: 'switch-document-function', keys: 'F2', scope: 'global', description: '切换到文档', action: 'switch-document' },
  { id: 'switch-rss', keys: 'CommandOrControl+3', scope: 'global', description: '切换到资讯', action: 'switch-rss', guide: true },
  { id: 'switch-rss-function', keys: 'F3', scope: 'global', description: '切换到资讯', action: 'switch-rss' },
  { id: 'switch-calendar', keys: 'CommandOrControl+4', scope: 'global', description: '切换到日历', action: 'switch-calendar', guide: true },
  { id: 'switch-calendar-function', keys: 'F4', scope: 'global', description: '切换到日历', action: 'switch-calendar' },
  { id: 'capture-window', keys: 'CommandOrControl+Shift+S', scope: 'global', description: '截取 Ready 窗口', action: 'capture-window', guide: true },
  { id: 'open-ready', keys: 'Home', scope: 'global', description: '打开 Ready 主页', action: 'open-ready', guide: true },
  { id: 'open-settings', keys: 'CommandOrControl+,', scope: 'global', description: '打开设置', action: 'open-settings', guide: true },
  { id: 'toggle-sidebar', keys: 'CommandOrControl+B', scope: 'global', description: '收起或展开侧栏', action: 'toggle-sidebar', guide: true },
  { id: 'save-document', keys: 'CommandOrControl+S', scope: 'global', description: '保存当前文档', action: 'save-document', guide: true },
  { id: 'close-document', keys: 'CommandOrControl+W', scope: 'global', description: '关闭当前文档', action: 'close-document', guide: true },
  { id: 'new-document', keys: 'CommandOrControl+T', scope: 'global', description: '新建文档', action: 'new-document', guide: true },
  { id: 'toggle-theme', keys: 'CommandOrControl+\\', scope: 'global', description: '切换主题', action: 'toggle-theme', guide: true },
  { id: 'open-search', keys: 'CommandOrControl+K', scope: 'global', description: '搜索对象和命令', action: 'open-search', guide: true },
  // W6 §2.1, §2.3: a reference is quick-looked with Space (hovered or focused); ⌘K's result with ⌥↵, or opened in a new tab with ⌘↵.
  { id: 'reference.quick-look', keys: 'Space', scope: 'global', description: '速览悬停或选中的引用', guide: true },
  { id: 'search.quick-look', keys: 'Alt+Enter', scope: 'global', description: '速览搜索结果' },
  { id: 'search.open-new-tab', keys: 'CommandOrControl+Enter', scope: 'global', description: '在新标签打开搜索结果' },
  { id: 'toggle-assistant', keys: 'Tab', scope: 'global', description: '收起或展开助手', guide: true },
  { id: 'assistant.send', keys: 'Enter', scope: 'assistant', description: '发送消息', guide: true },
  { id: 'assistant.newline', keys: 'Shift+Enter', scope: 'assistant', description: '消息内换行', guide: true },
  { id: 'sidebar-backquote', keys: '`', scope: 'global', description: '收起或展开侧栏' },
  { id: 'sidebar-dot', keys: '·', scope: 'global', description: '收起或展开侧栏' },
  { id: 'quick-note', keys: 'Alt+Command+Space', scope: 'global', description: '快记', guide: true },
  { id: 'calendar-tray-mac', keys: 'Control+Command+K', scope: 'global', description: '菜单栏日历（macOS）' },
  { id: 'calendar-join-mac', keys: 'Control+Command+J', scope: 'global', description: '加入下一场会议（macOS）' },
  { id: 'calendar-tray-other', keys: 'Control+Alt+K', scope: 'global', description: '菜单栏日历（Windows/Linux）' },
  { id: 'calendar-join-other', keys: 'Control+Alt+J', scope: 'global', description: '加入下一场会议（Windows/Linux）' },
  { id: 'undo', keys: 'CommandOrControl+Z', scope: 'global', description: '撤销' },
  { id: 'redo', keys: 'CommandOrControl+Shift+Z', scope: 'global', description: '重做' },
  { id: 'redo-windows', keys: 'Control+Y', scope: 'global', description: '重做（Windows）' },
  { id: 'cut', keys: 'CommandOrControl+X', scope: 'global', description: '剪切' },
  { id: 'copy', keys: 'CommandOrControl+C', scope: 'global', description: '复制' },
  { id: 'paste', keys: 'CommandOrControl+V', scope: 'global', description: '粘贴' },
  { id: 'paste-plain', keys: 'CommandOrControl+Shift+V', scope: 'global', description: '粘贴并匹配样式' },
  { id: 'select-all', keys: 'CommandOrControl+A', scope: 'global', description: '全选' },
  { id: 'hide', keys: 'Command+H', scope: 'global', description: '隐藏应用' },
  { id: 'hide-others', keys: 'Alt+Command+H', scope: 'global', description: '隐藏其他应用' },
  { id: 'quit', keys: 'CommandOrControl+Q', scope: 'global', description: '退出应用' },
  { id: 'minimize', keys: 'CommandOrControl+M', scope: 'global', description: '最小化' },
  { id: 'reload', keys: 'CommandOrControl+R', scope: 'global', description: '重新加载（菜单）' },
  { id: 'force-reload', keys: 'CommandOrControl+Shift+R', scope: 'global', description: '强制重新加载（菜单）' },
  { id: 'devtools-mac', keys: 'Alt+Command+I', scope: 'global', description: '开发者工具（macOS 菜单）' },
  { id: 'devtools-other', keys: 'Control+Shift+I', scope: 'global', description: '开发者工具（其他平台菜单）' },
  { id: 'fullscreen-mac', keys: 'Control+Command+F', scope: 'global', description: '全屏（macOS 菜单）' },
  { id: 'fullscreen-other', keys: 'F11', scope: 'global', description: '全屏（其他平台菜单）' },
  { id: 'zoom-in', keys: 'CommandOrControl+Plus', scope: 'global', description: '放大（菜单）' },
  { id: 'zoom-out', keys: 'CommandOrControl+-', scope: 'global', description: '缩小（菜单）' },
  { id: 'zoom-reset', keys: 'CommandOrControl+0', scope: 'global', description: '重置缩放（菜单）' },
  { id: 'calendar.create', keys: 'C', scope: 'calendar', description: '新建日程' },
  { id: 'calendar.today', keys: 'T', scope: 'calendar', description: '回到今天' },
  { id: 'calendar.next', keys: 'J', scope: 'calendar', description: '下一时段' },
  { id: 'calendar.prev', keys: 'K', scope: 'calendar', description: '上一时段' },
  { id: 'calendar.day', keys: 'D', scope: 'calendar', description: '日视图' },
  { id: 'calendar.week', keys: 'W', scope: 'calendar', description: '周视图' },
  { id: 'calendar.month', keys: 'M', scope: 'calendar', description: '月视图' },
  { id: 'calendar.availability', keys: 'S', scope: 'calendar', description: '分享空闲时间' },
  { id: 'calendar.goto', keys: '.', scope: 'calendar', description: '跳到日期' },
  { id: 'calendar.zoomIn', keys: 'CommandOrControl+Shift+.', scope: 'calendar', description: '放大时间网格' },
  { id: 'calendar.zoomOut', keys: 'CommandOrControl+Shift+,', scope: 'calendar', description: '缩小时间网格' },
  { id: 'calendar.zoomReset', keys: 'CommandOrControl+Shift+0', scope: 'calendar', description: '重置时间网格' },
  { id: 'calendar.allday', keys: 'CommandOrControl+Shift+A', scope: 'calendar', description: '收起或展开全天区' },
  { id: 'calendar.weekends', keys: 'CommandOrControl+Shift+E', scope: 'calendar', description: '显示或隐藏周末' },
  { id: 'calendar.declined', keys: 'CommandOrControl+Shift+D', scope: 'calendar', description: '显示或隐藏已拒绝日程' },
  { id: 'calendar.sidebar', keys: '\\', scope: 'calendar', description: '收起或展开外壳侧栏' },
  { id: 'calendar.panel', keys: 'CommandOrControl+Alt+\\', scope: 'calendar', description: '收起或展开上下文栏' },
  { id: 'calendar.theme', keys: 'CommandOrControl+Shift+L', scope: 'calendar', description: '切换外壳主题' },
  { id: 'calendar.shortcuts', keys: '?', scope: 'calendar', description: '查看快捷键' },
  { id: 'calendar.delete', keys: 'Backspace', scope: 'calendar', description: '删除所选日程' },
  { id: 'calendar.duplicate', keys: 'CommandOrControl+D', scope: 'calendar', description: '复制所选日程' },
  { id: 'calendar.confirm', keys: 'CommandOrControl+Enter', scope: 'calendar', description: '确认日程编辑' },
  { id: 'calendar.search', keys: 'CommandOrControl+F', scope: 'calendar', description: '搜索日程' },
  { id: 'calendar.join', keys: 'CommandOrControl+J', scope: 'calendar', description: '加入会议' },
  { id: 'calendar.new', keys: 'CommandOrControl+N', scope: 'calendar', description: '新建日程' },
  { id: 'calendar.redo', keys: 'CommandOrControl+Y', scope: 'calendar', description: '重做日历编辑' },
  { id: 'calendar.delete-single', keys: 'CommandOrControl+Backspace', scope: 'calendar', description: '删除这一次日程' },
  { id: 'calendar.delete-single-forward', keys: 'CommandOrControl+Delete', scope: 'calendar', description: '删除这一次日程' },
  { id: 'calendar.days2', keys: '2', scope: 'calendar', description: '切换为2天视图' },
  { id: 'calendar.days3', keys: '3', scope: 'calendar', description: '切换为3天视图' },
  { id: 'calendar.days4', keys: '4', scope: 'calendar', description: '切换为4天视图' },
  { id: 'calendar.days5', keys: '5', scope: 'calendar', description: '切换为5天视图' },
  { id: 'calendar.days6', keys: '6', scope: 'calendar', description: '切换为6天视图' },
  { id: 'calendar.days8', keys: '8', scope: 'calendar', description: '切换为8天视图' },
  { id: 'calendar.days9', keys: '9', scope: 'calendar', description: '切换为9天视图' },
  { id: 'canvas.group', keys: 'CommandOrControl+G', scope: 'canvas', description: '组合所选图形' },
  { id: 'canvas.ungroup', keys: 'CommandOrControl+Shift+G', scope: 'canvas', description: '取消图形组合' },
  { id: 'canvas.search', keys: 'CommandOrControl+F', scope: 'canvas', description: '在画板中搜索' },
  { id: 'canvas.duplicate', keys: 'CommandOrControl+D', scope: 'canvas', description: '创建所选卡片的副本' },
  { id: 'canvas.layer-forward', keys: 'CommandOrControl+Alt+]', scope: 'canvas', description: '所选卡片上移一层' },
  { id: 'canvas.layer-backward', keys: 'CommandOrControl+Alt+[', scope: 'canvas', description: '所选卡片下移一层' },
  { id: 'canvas.open', keys: 'Enter', scope: 'canvas', description: '打开所选卡片' },
  { id: 'canvas.parent-board', keys: 'Alt+ArrowUp', scope: 'canvas', description: '回到上一级画板' },
  { id: 'skills.confirm', keys: 'CommandOrControl+Enter', scope: 'skills', description: '确认技能编辑' },
  { id: 'document.confirm', keys: 'CommandOrControl+Enter', scope: 'document', description: '确认当前块编辑' },
  { id: 'document.italic', keys: 'CommandOrControl+I', scope: 'document', description: '斜体' },
  { id: 'document.underline', keys: 'CommandOrControl+U', scope: 'document', description: '下划线' },
  { id: 'document.code', keys: 'CommandOrControl+E', scope: 'document', description: '行内代码' },
  { id: 'document.strike', keys: 'CommandOrControl+Shift+X', scope: 'document', description: '删除线' },
  { id: 'navigate-back', keys: 'CommandOrControl+[', scope: 'global', description: '后退', action: 'navigate-back', guide: true },
  { id: 'navigate-forward', keys: 'CommandOrControl+]', scope: 'global', description: '前进', action: 'navigate-forward', guide: true },
]

export function appShortcut(id: string): AppShortcut {
  const shortcut = APP_SHORTCUTS.find(item => item.id === id)
  if (!shortcut) throw new Error(`Unknown shortcut: ${id}`)
  return shortcut
}

export function shortcutKeycaps(shortcut: AppShortcut, mac = true): string[] {
  const labels: Record<string, string> = { CommandOrControl: mac ? '⌘' : 'Ctrl', Command: '⌘', Control: mac ? '⌃' : 'Ctrl', Alt: mac ? '⌥' : 'Alt', Shift: '⇧', Space: 'Space', Plus: '+' }
  return shortcut.keys.split('+').map(key => labels[key] ?? key)
}

export function matchesAppShortcut(shortcut: AppShortcut, input: ReadyShortcutInput): boolean {
  const parts = shortcut.keys.split('+'), key = parts.pop()!
  const mod = parts.includes('CommandOrControl')
  const command = Boolean(input.metaKey), control = Boolean(input.ctrlKey)
  if (mod ? command === control : (command !== parts.includes('Command') || control !== parts.includes('Control'))) return false
  if (Boolean(input.shiftKey) !== parts.includes('Shift') || Boolean(input.altKey) !== parts.includes('Alt')) return false
  return input.key.toLowerCase() === (key === 'Space' ? ' ' : key === 'Plus' ? '+' : key.toLowerCase())
}

export function resolveReadyAppShortcut(input: ReadyShortcutInput, scope: AppShortcut['scope'] = 'global'): ReadyAppShortcutAction | null {
  return APP_SHORTCUTS.find(shortcut => shortcut.action && (shortcut.scope === 'global' || shortcut.scope === scope) && matchesAppShortcut(shortcut, input))?.action ?? null
}

export const READY_SHORTCUT_GUIDE: ReadyShortcutGuideItem[] = APP_SHORTCUTS.filter(item => item.guide).map(item => ({
  id: item.id, label: item.description, value: shortcutKeycaps(item).join(' + ').replace('⌘', item.keys.includes('CommandOrControl') ? '⌘ / Ctrl' : '⌘'),
}))
