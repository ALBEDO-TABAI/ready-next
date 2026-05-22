import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser address editing uses a ref-backed guard so fast navigate events can still refresh the visible URL', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')

  assert.match(browserMode, /const isAddressEditingRef = useRef\(false\)/)
  assert.match(browserMode, /const setAddressEditing = useCallback\(\(next: boolean\) => \{[\s\S]*isAddressEditingRef\.current = next/)
  assert.match(browserMode, /const handleBrowserEditStart = useCallback\(\(\) => \{[\s\S]*setAddressEditing\(true\)/)
  assert.match(browserMode, /const handleBrowserEditEnd = useCallback\(\(\) => \{[\s\S]*setAddressEditing\(false\)/)
  assert.match(browserMode, /isAddressEditingRef,\s*sendBoundsImmediate,/)
  assert.match(browserMode, /onEditStart=\{handleBrowserEditStart\}/)
  assert.match(browserMode, /onEditEnd=\{handleBrowserEditEnd\}/)
  assert.doesNotMatch(browserMode, /if \(isAddressEditing\) \{[\s\S]*browser\?\.hideAll\?\.\(\)/)
  assert.doesNotMatch(browserMode, /\[isAddressEditing, isElectron, shouldRevealBrowserHost, browserRuntimeReady, tabs\.length, syncBrowserVisibility\]/)

  assert.match(runtimeHook, /import \{ useCallback, useEffect, useRef, useState, type RefObject \} from 'react'/)
  assert.match(runtimeHook, /interface UseBrowserRuntimeEffectsParams \{[\s\S]*isAddressEditingRef: RefObject<boolean>/)
  assert.match(runtimeHook, /if \(store\.activeTabId === event\.tabId && event\.url && !isAddressEditingRef\.current\)/)
  assert.doesNotMatch(runtimeHook, /if \(store\.activeTabId === event\.tabId && event\.url && !isAddressEditing\)/)
})

test('browser header dismisses address editing before external collapse or tab switch transitions', () => {
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const interactionHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserHeaderInteraction.ts')

  assert.match(browserHeader, /const dismissAddressEditing = useCallback\(\(\) => \{[\s\S]*onBlur\(\)[\s\S]*onEditEnd\(\)[\s\S]*collapseActiveTab\(\)/)
  assert.match(browserHeader, /useEffect\(\(\) => \{[\s\S]*if \(isActive\) return[\s\S]*dismissAddressEditing\(\)/)
  assert.match(browserHeader, /useBrowserHeaderInteraction\(isActive,\s*dismissAddressEditing\)/)
  assert.match(browserHeader, /onTabClick=\{\(tabId, event\) => \{[\s\S]*dismissAddressEditing\(\)[\s\S]*onTabClick\(tabId, event\)/)

  assert.match(interactionHook, /export function useBrowserHeaderInteraction\(isActive = true, onDismissActiveTab\?: \(\) => void\)/)
  assert.match(interactionHook, /onDismissActiveTab\?\.\(\)/)
})
