import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserSiteResearchTabSession } from '../main/modules/browser-engine/browser-site-research-tab-session'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'

test('site research reuses its dedicated agent tab for every query and detail', async () => {
  const opened: string[] = []
  const navigated: Array<{ tabId: string; url: string }> = []
  const extracted: string[] = []
  let heartbeats = 0
  const capabilityService = {
    openTarget: async (url: string) => {
      opened.push(url)
      return { success: true, tabId: 'research-tab-1' }
    },
    navigateTargetTab: async (tabId: string, url: string) => {
      navigated.push({ tabId, url })
      return { success: true, tabId }
    },
    extractStructured: async (tabId: string) => {
      extracted.push(tabId)
      return { template: 'card_list', items: [], sourceUrl: '' }
    },
  }
  const leaseService = {
    checkWrite: () => null,
    heartbeat: () => { heartbeats += 1 },
  }
  const session = new BrowserSiteResearchTabSession(
    capabilityService as never,
    leaseService as never,
    'agent-view',
    'lease-1',
    'research-tab-1',
  )

  await session.extract('https://www.xiaohongshu.com/search_result?keyword=one', { template: 'card_list', limit: 12 })
  await session.extract('https://www.xiaohongshu.com/search_result?keyword=two', { template: 'card_list', limit: 12 })
  await session.extract('https://www.xiaohongshu.com/explore/note-1', { template: 'article_list', limit: 4 })

  assert.deepEqual(opened, [])
  assert.deepEqual(navigated, [
    { tabId: 'research-tab-1', url: 'https://www.xiaohongshu.com/search_result?keyword=one' },
    { tabId: 'research-tab-1', url: 'https://www.xiaohongshu.com/search_result?keyword=two' },
    { tabId: 'research-tab-1', url: 'https://www.xiaohongshu.com/explore/note-1' },
  ])
  assert.deepEqual(extracted, ['research-tab-1', 'research-tab-1', 'research-tab-1'])
  assert.equal(session.tabId, 'research-tab-1')
  assert.equal(heartbeats, 3)
})

test('site research stops before navigation when its single-writer lease is lost', async () => {
  let writes = 0
  const session = new BrowserSiteResearchTabSession(
    { navigateTargetTab: async () => { writes += 1; return { success: true, tabId: 'unexpected' } } } as never,
    { checkWrite: () => ({ errorCode: 'lease_takeover' }), heartbeat: () => undefined } as never,
    'agent-view',
    'lease-lost',
    'research-tab-1',
  )

  await assert.rejects(
    session.extract('https://www.xiaohongshu.com/', { template: 'card_list', limit: 1 }),
    /lease_lost/,
  )
  assert.equal(writes, 0)
})

test('xiaohongshu extractor sent to the real page is valid JavaScript without nested regex literals', async () => {
  let compiledScript = ''
  let waitOptions: Record<string, unknown> | null = null
  const session = new BrowserSiteResearchTabSession(
    {
      navigateTargetTab: async (tabId: string) => ({ success: true, tabId }),
      extractStructured: async (_tabId: string, options: { customScript?: string; wait?: Record<string, unknown> }) => {
        compiledScript = String(options.customScript || '')
        waitOptions = options.wait || null
        assert.doesNotThrow(() => new Function(compiledScript))
        assert.doesNotThrow(() => new Function(`return ${String(options.wait?.customJs || '')}`))
        return { template: 'custom', items: [], sourceUrl: '' }
      },
    } as never,
    { checkWrite: () => null, heartbeat: () => undefined } as never,
    'agent-view',
    'lease-1',
    'research-tab-1',
  )

  await session.extract('https://www.xiaohongshu.com/user/profile/account-1', { template: 'card_list', limit: 12 })
  assert.match(compiledScript, /startsWith\('\/user\/profile\/'\)/)
  assert.doesNotMatch(compiledScript, /\^\/user\/profile/)
  assert.equal(waitOptions?.condition, 'custom_js')
  assert.match(String(waitOptions?.customJs), /section\.note-item/)
})

test('site research blocks model-driven tab fan-out and manual fallback after task ownership begins', async () => {
  let createdTabs = 0
  let navigations = 0
  const task = {
    taskId: 'browser-task-site-research-1',
    kind: 'site_research',
    status: 'paused',
    progress: { total: 18, completed: 0, failed: 0, currentLabel: null },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
  const controller = {
    getActiveTab: () => ({ id: 'tab-source', url: 'https://www.xiaohongshu.com/user/profile/account-1' }),
    getTabList: () => [{ id: 'tab-source', url: 'https://www.xiaohongshu.com/user/profile/account-1' }],
    createTab: async () => { createdTabs += 1; return { success: true, tabId: 'unexpected' } },
    navigate: async () => { navigations += 1; return { success: true } },
    listTasksByKind: async () => [task],
    getTaskPayload: () => ({ scopeId: 'scope-site-research-1' }),
  }
  const message = '请在当前小红书账号页搜索关键词：\n1. one\n2. two\n只读研究，不下载、不发布。'
  const context = { inputSource: 'model' as const }

  const opened = await executeBrowserTool(
    'browser_tabs',
    { action: 'open', url: 'https://www.xiaohongshu.com/search_result?keyword=one', background: true },
    controller as never,
    undefined,
    'scope-site-research-1',
    undefined,
    message,
    undefined,
    context,
  )
  const searched = await executeBrowserTool(
    'browser_search',
    { query: 'one', scope: 'current_site', tab_id: 'tab-source' },
    controller as never,
    undefined,
    'scope-site-research-1',
    undefined,
    message,
    undefined,
    context,
  )

  assert.match(typeof opened === 'string' ? opened : opened.text, /site_research_tab_fanout_forbidden/)
  assert.match(typeof searched === 'string' ? searched : searched.text, /site_research_manual_fallback_forbidden/)
  assert.equal(createdTabs, 0)
  assert.equal(navigations, 0)
})
