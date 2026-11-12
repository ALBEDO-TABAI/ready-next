import { appShortcut } from '../../../../shared/app-shortcuts'
import { requestWorkbenchModeOpen } from '../mode-transition'
import { registerCommands, type ReadyCommand } from './registry'
import { requestShellAction, type ShellAction } from './shell-actions'

export function registerGlobalCommands(): () => void {
  const actions: Array<[ShellAction, string, string?]> = [
    ['toggle-theme', '切换主题', 'toggle-theme'],
    ['toggle-sidebar', '收起或展开侧栏', 'toggle-sidebar'],
    ['toggle-assistant', '收起或展开助手', 'toggle-assistant'],
    ['open-today', '今日'], ['open-skills', '技能中心'], ['open-graph', '关系图谱'],
    ['open-find-replace', '在资料库中查找与替换'],
    ['new-page', '新建页面'], ['new-database', '新建数据库'],
    ['open-fastcard', '打开 FastCard'], ['open-settings', '打开设置', 'open-settings'],
  ]
  // What ⌘K offers before anything is typed, after 最近打开.
  const common: ShellAction[] = ['open-today', 'new-page', 'open-fastcard', 'open-find-replace', 'toggle-theme', 'open-settings']
  const commands: ReadyCommand[] = actions.map(([action, title, shortcut]) => ({
    id: `shell.${action}`, title, shortcut: shortcut ? appShortcut(shortcut) : undefined,
    ...(common.includes(action) ? { common: true } : {}),
    run: () => requestShellAction(action),
  }))
  for (const [mode, title] of [['browser', '浏览器'], ['document', '文档'], ['rss', '资讯'], ['calendar', '日历']] as const) {
    commands.push({ id: `shell.switch-${mode}`, title: `切换到${title}`, keywords: [mode], shortcut: appShortcut(`switch-${mode}`), run: () => requestWorkbenchModeOpen(mode) })
  }
  return registerCommands('shell', commands)
}
