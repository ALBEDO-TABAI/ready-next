export interface WidgetThemePayload {
  vars: Record<string, string>
  isDark: boolean
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
] as const

export function resolveWidgetThemePayload(): WidgetThemePayload {
  const root = document.documentElement
  const styles = getComputedStyle(root)

  const vars: Record<string, string> = {}
  for (const name of THEME_VAR_NAMES) {
    vars[name] = styles.getPropertyValue(name).trim()
  }

  vars['--widget-bg-primary'] = vars['--bg-content']
  vars['--widget-bg-secondary'] = vars['--bg-canvas']
  vars['--widget-border'] = vars['--border-default']
  vars['--widget-text-primary'] = vars['--text-title']
  vars['--widget-text-secondary'] = vars['--text-body']
  vars['--widget-text-muted'] = vars['--text-muted']
  vars['--widget-accent'] = vars['--color-blue']
  vars['--widget-accent-soft'] = vars['--color-blue-light']

  return {
    vars,
    isDark:
      root.getAttribute('data-theme') === 'dark' ||
      root.classList.contains('dark'),
  }
}

export function getWidgetIframeStyleBlock(vars: Record<string, string>): string {
  const cssVars = Object.entries(vars)
    .map(([key, value]) => `${key}:${value};`)
    .join('\n')

  return `
:root {
${cssVars}
}

html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--widget-text-secondary);
  font-family: Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

.widget-root {
  box-sizing: border-box;
  width: 100%;
  color: var(--widget-text-secondary);
}

.widget-root, .widget-root * {
  box-sizing: border-box;
}

.widget-root a {
  color: var(--widget-accent);
}

.widget-root .card {
  border: 1px solid var(--widget-border);
  border-radius: 16px;
  background: var(--widget-bg-primary);
  padding: 16px;
}

.widget-root .muted {
  color: var(--widget-text-muted);
}

.widget-root .title {
  color: var(--widget-text-primary);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
}

.widget-root .subtitle {
  color: var(--widget-text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.widget-root .row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.widget-root .stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.widget-root .badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  padding: 4px 10px;
  background: var(--widget-accent-soft);
  color: var(--widget-accent);
  font-size: 12px;
  font-weight: 600;
}

.widget-root button,
.widget-root input,
.widget-root select {
  font: inherit;
}

.widget-root button {
  border: 1px solid var(--widget-border);
  border-radius: 10px;
  background: var(--widget-bg-primary);
  color: var(--widget-text-primary);
  padding: 8px 12px;
  cursor: pointer;
}

.widget-root input,
.widget-root select {
  width: 100%;
  border: 1px solid var(--widget-border);
  border-radius: 10px;
  background: var(--widget-bg-primary);
  color: var(--widget-text-primary);
  padding: 8px 10px;
}

.widget-root canvas {
  display: block;
  width: 100%;
  max-width: 100%;
}
`
}
