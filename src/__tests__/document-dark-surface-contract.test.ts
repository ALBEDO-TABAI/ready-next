import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function captureRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `missing CSS rule for ${selector}`)
  return match[1]
}

test('document widget chrome stays transparent while interactive controls use surface tokens', () => {
  const styles = readWorkspaceFile('src/renderer/styles/document-widget-editor.css')

  assert.match(captureRule(styles, '.ready-doc-widget-card'), /background:\s*transparent/)
  assert.match(captureRule(styles, '.ready-doc-widget-card-title-pill'), /background:\s*transparent/)
  assert.match(captureRule(styles, '.ready-doc-widget-card-title-input'), /var\(--input-slot-bg\)/)
  assert.match(captureRule(styles, '.ready-doc-widget-primary-action'), /var\(--input-slot-bg\)/)

  for (const selector of [
    '.ready-doc-widget-card-title-input',
    '.ready-doc-widget-primary-action',
  ]) {
    assert.doesNotMatch(captureRule(styles, selector), /color-mix\(in srgb,\s*white/)
  }
})

test('document widget keeps transparent chrome and themed controls in dark mode', () => {
  const styles = readWorkspaceFile('src/renderer/styles/document-widget-editor.css')

  assert.match(
    captureRule(styles, "html[data-theme='dark'] .ready-doc-widget-card"),
    /background:\s*transparent/,
  )
  assert.match(
    styles,
    /html\[data-theme='dark'\] \.ready-doc-widget-card-title-input,\s*\nhtml\[data-theme='dark'\] \.ready-doc-widget-primary-action\s*\{[\s\S]*background:\s*color-mix\(in srgb,\s*var\(--input-slot-bg\) 80%,\s*var\(--surface-card-bg\) 20%\);/,
  )
  assert.match(styles, /html\[data-theme='dark'\] \.ready-widget-edit-drawer-warning\s*\{[\s\S]*var\(--color-orange-light\)/)
  assert.match(styles, /html\[data-theme='dark'\] \.ready-widget-edit-drawer-error\s*\{[\s\S]*var\(--color-red-light\)/)
})
