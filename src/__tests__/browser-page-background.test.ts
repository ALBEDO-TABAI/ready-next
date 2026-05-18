import assert from 'node:assert/strict'
import test from 'node:test'

import type { BrowserHostView } from '../main/modules/browser-engine/host-types'
import { BrowserPageBackgroundService } from '../main/modules/browser-engine/page-background-service'
import {
  DEFAULT_BROWSER_PAGE_BACKGROUND,
  normalizeBrowserPageBackgroundColor,
  resolveBrowserPageBackground,
} from '../shared/browser-page-background'

test('browser page background color parser ignores transparent colors and returns opaque hex', () => {
  assert.equal(normalizeBrowserPageBackgroundColor('transparent'), null)
  assert.equal(normalizeBrowserPageBackgroundColor('rgba(0, 0, 0, 0)'), null)
  assert.equal(normalizeBrowserPageBackgroundColor('rgba(255, 255, 255, 0.4)'), null)
  assert.equal(normalizeBrowserPageBackgroundColor('rgb(250, 251, 252)'), '#fafbfc')
  assert.equal(normalizeBrowserPageBackgroundColor('#0f172a'), '#0f172a')
})

test('browser page background prefers document canvas colors over header samples', () => {
  assert.equal(resolveBrowserPageBackground({
    document: [
      { color: 'rgba(0, 0, 0, 0)' },
      { color: 'rgb(255, 255, 255)' },
    ],
    viewport: [
      { color: 'rgb(0, 0, 0)' },
      { color: 'rgb(0, 0, 0)' },
    ],
  }), '#ffffff')
})

test('browser page background falls back to viewport majority when the document canvas is transparent', () => {
  assert.equal(resolveBrowserPageBackground({
    document: [
      { color: 'transparent' },
      { color: 'rgba(0, 0, 0, 0)' },
    ],
    viewport: [
      { color: 'rgb(17, 24, 39)' },
      { color: 'rgb(17, 24, 39)' },
      { color: 'rgb(255, 255, 255)' },
    ],
  }), '#111827')
})

test('browser page background uses normal browser white when no page color is proven', () => {
  assert.equal(resolveBrowserPageBackground({
    document: [{ color: 'transparent' }],
    viewport: [{ color: 'rgba(0, 0, 0, 0)' }],
    colorScheme: 'light dark',
    prefersDark: false,
  }), DEFAULT_BROWSER_PAGE_BACKGROUND)
})

test('browser page background service resets first and then applies the resolved page color', async () => {
  const applied: string[] = []
  const logs: string[] = []
  const view = {
    setBackgroundColor: (color: string) => {
      applied.push(color)
    },
    webContents: {
      executeJavaScript: async () => ({
        document: [{ color: 'transparent' }],
        viewport: [{ color: 'rgb(10, 20, 30)' }],
      }),
    },
  }
  const service = new BrowserPageBackgroundService((message) => {
    logs.push(message)
  })

  service.reset(view as unknown as BrowserHostView)
  await service.sync(view as unknown as BrowserHostView)

  assert.deepEqual(applied, ['#ffffff', '#0a141e'])
  assert.deepEqual(logs, [])
})
