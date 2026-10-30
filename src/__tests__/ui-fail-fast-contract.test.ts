import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { buildSync } from 'esbuild'

function readWorkspaceFile(path: string): string {
  // allow-source-grep: Preserve the existing workbench and markdown guards; calendar loading is exercised below.
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench init and markdown loading expose real failures instead of silently faking success', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')

  assert.match(workbenchMode, /workspaceInitError/)
  assert.doesNotMatch(workbenchMode, /fallback to mock files/)
  assert.doesNotMatch(workbenchMode, /await refreshFiles\(\)/)

  assert.match(markdownEditor, /loadError/)
  assert.doesNotMatch(markdownEditor, /# 暂不支持该格式/)
  assert.doesNotMatch(markdownEditor, /# 文件读取失败/)
  assert.match(markdownEditor, /文件暂不支持直接编辑/)
  assert.match(markdownEditor, /文档加载失败/)
})

test('calendar workbench displays failed load receipts and rejected retries instead of an empty calendar', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
  const replacements = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    let loads = 0
    Object.assign(dom.window, { electronAPI: { calendar: {
      snapshot: async () => {
        if (++loads === 1) return { success: false, mock: false, error: '无法读取日历数据库' }
        throw new Error('日历连接已断开')
      },
      onChanged: () => () => {},
      getLoginItem: async () => ({ success: true, mock: false, data: false }),
    } } })
    // Bundle the real workbench and store with browser aliases; only CSS and native APIs need a DOM substitute.
    const compiled = buildSync({
      entryPoints: ['src/renderer/modules/calendar/workbench/App.tsx'], bundle: true, write: false,
      platform: 'browser', format: 'cjs', jsx: 'automatic', tsconfig: 'tsconfig.web.json',
      loader: { '.css': 'empty' }, external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    }).outputFiles[0].text
    const loaded = { exports: {} as { App: typeof import('../renderer/modules/calendar/workbench/App').App } }
    new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports)
    await act(async () => root.render(createElement(loaded.exports.App)))
    const loadState = () => dom.window.document.querySelector('.calendar-load-state')
    assert.equal(loads, 1)
    assert.match(loadState()?.textContent ?? '', /无法读取日历数据库/)
    assert.equal(dom.window.document.querySelector('.app'), null, 'failed loading must not render an empty calendar')
    const retry = loadState()?.querySelector('button')
    assert.equal(retry?.textContent, '重新读取')
    await act(async () => retry!.click())
    assert.equal(loads, 2)
    assert.match(loadState()?.textContent ?? '', /日历连接已断开/)
    assert.equal(dom.window.document.querySelector('.app'), null)
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
