import {
  WIDGET_THEME_DARK,
  WIDGET_THEME_LIGHT,
  buildWidgetBaseStyleCss,
  buildWidgetTokenVarDeclarations,
  type WidgetThemeTokenSet,
} from '../../../shared/document-widget-theme'

export type WidgetBackgroundMode = 'opaque' | 'transparent'

export interface WidgetThemePayload {
  vars: Record<string, string>
  isDark: boolean
  backgroundMode: WidgetBackgroundMode
}

export interface ResolveWidgetThemeOptions {
  backgroundMode?: WidgetBackgroundMode
}

const THEME_VAR_NAMES = [
  '--bg-content',
  '--bg-canvas',
  '--bg-panel',
  '--bg-hover',
  '--border-default',
  '--text-title',
  '--text-body',
  '--text-muted',
  '--text-light',
  '--color-blue',
  '--color-blue-light',
  '--color-green',
  '--color-orange',
  '--color-red',
  '--color-ready-orange',
  '--color-ready-orange-light',
  '--font-mono',
] as const

function pick(live: string | undefined, fallback: string): string {
  return live && live.trim().length > 0 ? live : fallback
}

export function resolveWidgetThemePayload(options?: ResolveWidgetThemeOptions): WidgetThemePayload {
  const backgroundMode: WidgetBackgroundMode = options?.backgroundMode === 'transparent' ? 'transparent' : 'opaque'
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const isDark =
    root.getAttribute('data-theme') === 'dark' ||
    root.classList.contains('dark')
  const tokens: WidgetThemeTokenSet = isDark ? WIDGET_THEME_DARK : WIDGET_THEME_LIGHT

  const vars: Record<string, string> = {}
  for (const name of THEME_VAR_NAMES) {
    vars[name] = styles.getPropertyValue(name).trim()
  }

  // Widget 视觉以 Ready 令牌层为唯一来源。工作台 live 变量仍透传给 legacy/freeform
  // 代码，但不得反向覆盖结构化 widget 的暖纸白、墨阶和 hairline；否则应用的
  // 功能蓝表面会把两套编译器重新染回旧样式。
  Object.assign(vars, buildWidgetTokenVarDeclarations(tokens))

  vars['--widget-bg-primary'] = backgroundMode === 'transparent' ? 'transparent' : tokens.card
  vars['--widget-bg-secondary'] = tokens.canvas
  vars['--widget-bg-paper'] = tokens.paper
  vars['--widget-border'] = tokens.hair
  vars['--widget-text-primary'] = tokens.ink
  vars['--widget-text-secondary'] = tokens.inkBody
  vars['--widget-text-muted'] = tokens.ink2
  vars['--widget-text-faint'] = tokens.ink3
  vars['--widget-accent'] = tokens.accent
  vars['--widget-accent-soft'] = tokens.accentSoft
  vars['--widget-font-mono'] = pick(vars['--font-mono'], vars['--widget-font-mono'])

  return {
    vars,
    isDark,
    backgroundMode,
  }
}

export interface WidgetIframeStyleOptions {
  backgroundMode?: WidgetBackgroundMode
  /** document：文档正文里的开放式图版；省略时为导出用的纸面卡片。 */
  surface?: 'document' | 'sheet'
}

export function getWidgetIframeStyleBlock(
  vars: Record<string, string>,
  options?: WidgetIframeStyleOptions,
): string {
  const cssVars = Object.entries(vars)
    .map(([key, value]) => `${key}:${value};`)
    .join('\n')

  return `
:root {
${cssVars}
}
${buildWidgetBaseStyleCss({ backgroundMode: options?.backgroundMode, surface: options?.surface })}`
}
