/**
 * P1-E5 (2026-07-03, browser action receipt contract) — deterministic
 * post-action change summary shaping + integration into write-action output.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBrowserActionReceipt,
  captureBrowserActionReceipt,
} from '../main/modules/browser-engine/browser-action-receipt'
import {
  buildBrowserActionSessionProgress,
  noteBrowserActionSession,
} from '../main/modules/browser-engine/browser-action-session'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import { __clearBrowserPowerPolicyForTests } from '../main/modules/browser-engine/browser-power-policy'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

function parseOutput(out: string | ToolExecutionOutput): Record<string, unknown> {
  if (typeof out !== 'string') return (out.data || JSON.parse(out.text)) as Record<string, unknown>
  return JSON.parse(out) as Record<string, unknown>
}

test.beforeEach(() => {
  __clearBrowserPowerPolicyForTests()
})

test('buildBrowserActionReceipt: url change is detected', () => {
  const receipt = buildBrowserActionReceipt({
    beforeUrl: 'https://x.com/a',
    after: { url: 'https://x.com/b', title: 'B', activeElement: 'input:标题' },
  })
  assert.equal(receipt.captured, true)
  assert.equal(receipt.url, 'https://x.com/b')
  assert.equal(receipt.urlChanged, true)
  assert.equal(receipt.activeElement, 'input:标题')
})

test('buildBrowserActionReceipt: same url → urlChanged false', () => {
  const receipt = buildBrowserActionReceipt({
    beforeUrl: 'https://x.com/a',
    after: { url: 'https://x.com/a', title: 'A' },
  })
  assert.equal(receipt.urlChanged, false)
})

test('buildBrowserActionReceipt: visible toast/alert surfaces as visibleSignal (capped)', () => {
  const long = '发布成功'.repeat(80)
  const receipt = buildBrowserActionReceipt({
    beforeUrl: 'https://x.com/a',
    after: { url: 'https://x.com/a', visibleSignal: long },
  })
  assert.ok(receipt.visibleSignal && receipt.visibleSignal.length <= 201)
  assert.ok(receipt.visibleSignal!.startsWith('发布成功'))
})

test('buildBrowserActionReceipt: missing/empty after → not captured, no throw', () => {
  assert.deepEqual(buildBrowserActionReceipt({ beforeUrl: 'https://x', after: null }), { captured: false })
  assert.deepEqual(buildBrowserActionReceipt({ beforeUrl: 'https://x', after: { url: '' } }), { captured: false })
})

test('captureBrowserActionReceipt: probe throwing degrades to { captured: false }', async () => {
  const receipt = await captureBrowserActionReceipt(
    { executeJS: async () => { throw new Error('probe blew up') } },
    'tab-1',
    'https://x.com/a',
  )
  assert.deepEqual(receipt, { captured: false })
})

test('browser_type output carries a change receipt (integration)', async () => {
  let probed = false
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', title: 'Editor', url: 'https://creator.xiaohongshu.com/publish', active: true }) as never,
    getTabList: () => [{ id: 'tab-1', title: 'Editor', url: 'https://creator.xiaohongshu.com/publish', active: true }] as never,
    executeJS: async (_tabId: string | null, code: string) => {
      if (code.includes('__READY_ACTION_RECEIPT__')) {
        probed = true
        return { url: 'https://creator.xiaohongshu.com/publish', title: '写笔记', activeElement: 'textarea:正文', visibleSignal: '已保存草稿' }
      }
      // runGuardedSelectorType path returns a JSON string result
      return JSON.stringify({ ok: true, typed: true })
    },
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_type',
    { selector: 'textarea', text: '今天天气不错', tab_id: 'tab-1' },
    controller,
  )
  const parsed = parseOutput(out)
  assert.ok(probed, 'the read-only receipt probe must run after typing')
  const receipt = parsed.changeReceipt as Record<string, unknown> | undefined
  assert.ok(receipt, 'browser_type output must include a changeReceipt')
  assert.equal(receipt!.captured, true)
  assert.equal(receipt!.activeElement, 'textarea:正文')
  assert.equal(receipt!.visibleSignal, '已保存草稿')
})

test('nextSuggestedAction stays in session metadata and never becomes a task step or criterion', () => {
  const session = noteBrowserActionSession('scope-d11', {
    targetTabId: 'tab-1',
    transactionStatus: 'confirmed',
    nextSuggestedAction: 'finish with transaction proof',
  })
  assert.ok(session)
  const progress = buildBrowserActionSessionProgress(session!) as Record<string, unknown>
  assert.equal(progress.detail, null)
  assert.equal((progress.browserActionSession as { nextSuggestedAction?: string }).nextSuggestedAction, 'finish with transaction proof')
  assert.equal('steps' in progress, false)
  assert.equal('criteria' in progress, false)
})
