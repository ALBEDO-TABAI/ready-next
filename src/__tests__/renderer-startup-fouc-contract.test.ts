import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('renderer first frame already carries data-theme + data-skin to prevent FOUC into the debug-white state', () => {
  const indexHtml = readWorkspaceFile('src/renderer/index.html')
  const rendererMain = readWorkspaceFile('src/renderer/main.tsx')
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  // CSP must still allow inline scripts — the head bootstrap runs inline, before main.tsx.
  assert.match(
    indexHtml,
    /Content-Security-Policy[\s\S]*script-src[^;]*'unsafe-inline'/,
    'CSP must allow inline scripts for the head theme-bootstrap to execute',
  )

  // An inline <script> in <head> must synchronously seed data-theme + data-skin from localStorage
  // so the first paint already resolves the liquid-glass cascade instead of the :root default.
  const headMatch = indexHtml.match(/<head[\s\S]*?<\/head>/i)
  assert.ok(headMatch, 'index.html must have a <head>')
  const headSection = headMatch![0]
  assert.match(headSection, /<script>[\s\S]*localStorage\.getItem\(['"]ready-theme['"]\)[\s\S]*<\/script>/)
  assert.match(headSection, /setAttribute\(['"]data-theme['"]/)
  assert.match(headSection, /setAttribute\(['"]data-skin['"]/)
  assert.match(headSection, /localStorage\.getItem\(['"]ready-theme-skin['"]\)/)
  // system mode should resolve to prefers-color-scheme result, not fall back to light.
  assert.match(headSection, /prefers-color-scheme: dark/)

  // main.tsx is now a reconciler — it aligns localStorage/DOM with the main-process source after the first paint,
  // rather than being the first code to write data-theme.
  assert.match(rendererMain, /reconcileStartupTheme/)
  assert.match(rendererMain, /const themeResult = await window\.electronAPI\?\.theme\.get\(\)/)
  assert.doesNotMatch(rendererMain, /hydrateStartupTheme/)

  // Windows/Linux get a theme-matched backgroundColor at window creation so the native frame
  // doesn't flash white before the renderer paints.
  assert.match(
    mainIndex,
    /backgroundColor:\s*process\.platform === 'darwin' \? '#00000000' : nonMacFirstFrameBg/,
  )
  assert.match(mainIndex, /nonMacFirstFrameBg = nativeTheme\.shouldUseDarkColors \? '#1A1B1E' : '#F7F9FC'/)
})
