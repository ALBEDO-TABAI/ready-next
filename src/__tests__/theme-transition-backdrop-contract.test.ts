import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('theme transition whitelist no longer animates backdrop-filter', () => {
  const indexCss = readRendererStyles()

  // The per-selector transition whitelist was removed in favor of the shared ritual overlay.
  // The invariant "no animated backdrop-filter / -webkit-backdrop-filter during theme swap"
  // is preserved because the <html data-theme-transitioning> block no longer exists.
  assert.doesNotMatch(indexCss, /html\[data-theme-transitioning='true'\]\s*\{/)
  assert.doesNotMatch(indexCss, /data-theme-transitioning[\s\S]*backdrop-filter/)
  assert.doesNotMatch(indexCss, /data-theme-transitioning[\s\S]*-webkit-backdrop-filter/)
})
